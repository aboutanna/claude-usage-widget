const { app, BrowserWindow, ipcMain, Tray, Menu, screen, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const CLAUDE_URL = 'https://claude.ai/settings/usage';
const POLL_INTERVAL_MS = 60 * 1000; // 每 60 秒轮询一次，和官方设置页刷新频率接近
const SESSION_PARTITION = 'persist:claude-usage-widget';
const CONFIG_PATH = path.join(app.getPath('userData'), 'widget-config.json');

const EXPANDED_SIZE = { width: 260, height: 188 };
const COLLAPSED_SIZE = { width: 14, height: 64 };
const EDGE_SNAP_THRESHOLD = 60; // 距离屏幕左/右边缘多少像素以内，视为"贴边"
const COLLAPSE_DELAY_MS = 550; // 鼠标离开后，等待多久再收起

let sessionWindow = null; // 隐藏窗口：承载 claude.ai 登录态 cookie，并在其页面上下文里发起 fetch
let widgetWindow = null; // 悬浮小窗
let tray = null;
let pollTimer = null;
let sessionWindowReady = false;

let isPinned = false; // 固定展开，不自动收起
let isCollapsed = false;
let isHovering = false;
let currentEdge = null; // 'left' | 'right' | null
let collapseTimer = null;
let lastExpandedBounds = null; // { x, y, width, height }

// ---------- 本地配置（记住悬浮窗位置 / 固定状态） ----------
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (e) {
    return {};
  }
}

function saveConfig(patch) {
  try {
    const merged = { ...loadConfig(), ...patch };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged));
  } catch (e) {
    console.error('保存配置失败:', e);
  }
}

// ---------- 隐藏的会话窗口（登录 + 数据抓取都在这里发生） ----------
function createSessionWindow(show) {
  sessionWindow = new BrowserWindow({
    width: 900,
    height: 700,
    show: !!show,
    title: 'Claude 登录',
    webPreferences: {
      partition: SESSION_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  sessionWindowReady = false;
  sessionWindow.webContents.on('did-finish-load', () => {
    sessionWindowReady = true;
  });

  sessionWindow.loadURL(CLAUDE_URL);

  // 用户点关闭时只是隐藏，保留 cookie/session，不真正销毁窗口
  sessionWindow.on('close', (e) => {
    if (!app.isQuiting) {
      e.preventDefault();
      sessionWindow.hide();
    }
  });

  return sessionWindow;
}

function showLoginWindow() {
  if (!sessionWindow || sessionWindow.isDestroyed()) {
    createSessionWindow(true);
  } else {
    sessionWindow.show();
    sessionWindow.focus();
  }
}

async function waitForSessionWindowReady(timeoutMs = 15000) {
  const start = Date.now();
  while (!sessionWindowReady) {
    if (Date.now() - start > timeoutMs) throw new Error('SESSION_WINDOW_TIMEOUT');
    await new Promise((r) => setTimeout(r, 200));
  }
}

// 在 claude.ai 自己的页面上下文里执行 fetch，这样 cookie / CSRF / 反爬校验
// 都和用户手动打开设置页时完全一致，最不容易被拦截。
async function fetchUsageFromSessionWindow() {
  if (!sessionWindow || sessionWindow.isDestroyed()) {
    createSessionWindow(false);
  }
  await waitForSessionWindowReady();

  const script = `
    (async () => {
      const match = document.cookie.match(/(?:^|;\\s*)lastActiveOrg=([^;]*)/);
      if (!match) return { error: 'NO_ORG_ID' };
      const orgId = decodeURIComponent(match[1]);
      try {
        const res = await fetch('/api/organizations/' + orgId + '/usage', {
          credentials: 'include',
          headers: { 'Accept': 'application/json' }
        });
        if (!res.ok) return { error: 'API_ERROR_' + res.status };
        const data = await res.json();
        return { data };
      } catch (e) {
        return { error: 'FETCH_ERROR' };
      }
    })();
  `;

  return sessionWindow.webContents.executeJavaScript(script);
}

// ---------- 贴边 / 收起 / 展开 ----------
function getWorkAreaFor(x, y) {
  const display = screen.getDisplayNearestPoint({ x, y });
  return display.workArea;
}

function computeEdge(x, width, y) {
  const wa = getWorkAreaFor(x + width / 2, (y ?? 0) + 1);
  if (x <= wa.x + EDGE_SNAP_THRESHOLD) return 'left';
  if (x + width >= wa.x + wa.width - EDGE_SNAP_THRESHOLD) return 'right';
  return null;
}

function sendCollapseState() {
  widgetWindow?.webContents.send('collapse-state', { collapsed: isCollapsed, edge: currentEdge });
}

function scheduleAutoCollapseCheck() {
  if (collapseTimer) {
    clearTimeout(collapseTimer);
    collapseTimer = null;
  }
  if (isPinned || !currentEdge || isHovering || isCollapsed) return;
  collapseTimer = setTimeout(() => {
    collapseWidget();
  }, COLLAPSE_DELAY_MS);
}

function collapseWidget() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  if (isCollapsed || isPinned || !currentEdge || isHovering) return;

  const bounds = widgetWindow.getBounds();
  lastExpandedBounds = bounds;
  const wa = getWorkAreaFor(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);

  const collapsedY = Math.round(
    Math.min(
      Math.max(bounds.y + bounds.height / 2 - COLLAPSED_SIZE.height / 2, wa.y),
      wa.y + wa.height - COLLAPSED_SIZE.height
    )
  );
  const collapsedX = currentEdge === 'left' ? wa.x : wa.x + wa.width - COLLAPSED_SIZE.width;

  isCollapsed = true;
  widgetWindow.setBounds(
    { x: collapsedX, y: collapsedY, width: COLLAPSED_SIZE.width, height: COLLAPSED_SIZE.height },
    true
  );
  sendCollapseState();
}

function expandWidget() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  if (!isCollapsed) return;

  const target = lastExpandedBounds || {
    x: 100,
    y: 100,
    width: EXPANDED_SIZE.width,
    height: EXPANDED_SIZE.height,
  };
  const wa = getWorkAreaFor(target.x + EXPANDED_SIZE.width / 2, target.y + EXPANDED_SIZE.height / 2);

  let x = target.x;
  if (currentEdge === 'left') x = wa.x;
  if (currentEdge === 'right') x = wa.x + wa.width - EXPANDED_SIZE.width;

  const y = Math.min(Math.max(target.y, wa.y), wa.y + wa.height - EXPANDED_SIZE.height);

  isCollapsed = false;
  widgetWindow.setBounds({ x, y, width: EXPANDED_SIZE.width, height: EXPANDED_SIZE.height }, true);
  sendCollapseState();
}

// ---------- 悬浮小窗 ----------
function createWidgetWindow() {
  const cfg = loadConfig();
  isPinned = !!cfg.pinned;

  const { width } = screen.getPrimaryDisplay().workAreaSize;
  const startX = typeof cfg.x === 'number' ? cfg.x : width - EXPANDED_SIZE.width - 24;
  const startY = typeof cfg.y === 'number' ? cfg.y : 40;

  widgetWindow = new BrowserWindow({
    width: EXPANDED_SIZE.width,
    height: EXPANDED_SIZE.height,
    x: startX,
    y: startY,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  widgetWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  widgetWindow.setAlwaysOnTop(true, 'floating');
  widgetWindow.loadFile(path.join(__dirname, 'widget.html'));

  lastExpandedBounds = { x: startX, y: startY, width: EXPANDED_SIZE.width, height: EXPANDED_SIZE.height };
  currentEdge = computeEdge(startX, EXPANDED_SIZE.width, startY);

  widgetWindow.webContents.on('did-finish-load', () => {
    widgetWindow.webContents.send('pin-state', isPinned);
    sendCollapseState();
  });

  widgetWindow.on('moved', () => {
    if (isCollapsed) return; // 收起状态下的位移是程序自己触发的，不记录
    const [x, y] = widgetWindow.getPosition();
    saveConfig({ x, y });
    lastExpandedBounds = { ...widgetWindow.getBounds() };
    currentEdge = computeEdge(x, EXPANDED_SIZE.width, y);
    scheduleAutoCollapseCheck();
  });

  widgetWindow.on('close', (e) => {
    if (!app.isQuiting) {
      e.preventDefault();
      widgetWindow.hide();
    }
  });

  // 启动时如果就贴着边缘（默认位置就是贴右边），且没固定，过一会儿自动收起
  scheduleAutoCollapseCheck();
}

// ---------- 轮询 ----------
async function pollAndBroadcast() {
  try {
    const result = await fetchUsageFromSessionWindow();

    if (result && result.data) {
      // 拿到数据说明已登录；如果登录窗口还开着，自动收起
      if (sessionWindow && !sessionWindow.isDestroyed() && sessionWindow.isVisible()) {
        sessionWindow.hide();
      }
      widgetWindow?.webContents.send('usage-update', { usage: result.data, ts: Date.now() });
      return;
    }

    const errCode = result?.error || 'UNKNOWN_ERROR';
    if (errCode === 'NO_ORG_ID' || errCode === 'API_ERROR_401' || errCode === 'API_ERROR_403') {
      widgetWindow?.webContents.send('usage-error', 'NEED_LOGIN');
    } else {
      widgetWindow?.webContents.send('usage-error', errCode);
    }
  } catch (e) {
    widgetWindow?.webContents.send('usage-error', 'FETCH_ERROR');
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollAndBroadcast();
  pollTimer = setInterval(pollAndBroadcast, POLL_INTERVAL_MS);
}

// ---------- 菜单栏图标 ----------
function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'trayIconTemplate.png');
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    image = nativeImage.createEmpty();
  }
  tray = new Tray(image);
  tray.setToolTip('Claude Usage Widget');

  const menu = Menu.buildFromTemplate([
    {
      label: '显示/隐藏悬浮窗',
      click: () => {
        if (!widgetWindow) return;
        widgetWindow.isVisible() ? widgetWindow.hide() : widgetWindow.show();
      },
    },
    {
      label: '立即刷新',
      click: () => pollAndBroadcast(),
    },
    {
      label: '重新登录 Claude',
      click: () => showLoginWindow(),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.isQuiting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);
}

// ---------- IPC ----------
ipcMain.on('widget-refresh', () => pollAndBroadcast());
ipcMain.on('widget-hide', () => widgetWindow?.hide());
ipcMain.on('widget-open-login', () => showLoginWindow());

ipcMain.on('widget-hover', (_event, hovering) => {
  isHovering = !!hovering;
  if (isHovering) {
    if (collapseTimer) {
      clearTimeout(collapseTimer);
      collapseTimer = null;
    }
    if (isCollapsed) expandWidget();
  } else {
    scheduleAutoCollapseCheck();
  }
});

ipcMain.on('widget-toggle-pin', () => {
  isPinned = !isPinned;
  saveConfig({ pinned: isPinned });

  if (collapseTimer) {
    clearTimeout(collapseTimer);
    collapseTimer = null;
  }
  if (isPinned && isCollapsed) {
    expandWidget();
  }
  widgetWindow?.webContents.send('pin-state', isPinned);
});

// ---------- 生命周期 ----------
app.whenReady().then(() => {
  // 只做菜单栏小工具，不需要 Dock 图标
  if (process.platform === 'darwin' && app.dock) {
    app.dock.hide();
  }

  createSessionWindow(false);
  createWidgetWindow();
  createTray();
  startPolling();
});

app.on('window-all-closed', () => {
  // 两个窗口都被设计成"关闭即隐藏"，正常不会触发这里；
  // 仍保留非 mac 平台的默认退出行为作为兜底。
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  app.isQuiting = true;
});
