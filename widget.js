const KEY_LABELS = {
  five_hour: '5小时会话',
  seven_day: '7天全部模型',
  seven_day_sonnet: '7天 Sonnet',
  seven_day_opus: '7天 Opus',
  seven_day_cowork: '7天 Cowork',
  seven_day_oauth: '7天 OAuth',
};

const ORDER = [
  'five_hour',
  'seven_day',
  'seven_day_sonnet',
  'seven_day_opus',
  'seven_day_cowork',
  'seven_day_oauth',
];

let latestUsage = null;
let countdownTimer = null;
let overflowActive = false;
let overflowKind = null; // 'five_hour' | 'weekly' | null

// 把"距离重置还有多久"拆成天/时/分/秒，formatCountdown 和 renderOverflowBar 共用，
// 避免两处各写一套换算逻辑。
function getCountdownParts(resetsAtIso) {
  const diff = new Date(resetsAtIso).getTime() - Date.now();
  if (diff <= 0) return null;
  const totalSec = Math.floor(diff / 1000);
  const totalHours = Math.floor(totalSec / 3600);
  return {
    days: Math.floor(totalHours / 24),
    h: totalHours % 24,
    m: Math.floor((totalSec % 3600) / 60),
    s: totalSec % 60,
  };
}

function renderOverflowBar() {
  const el = document.getElementById('overflowBar');
  if (!el) return;
  if (!overflowActive || !latestUsage) {
    el.innerHTML = '';
    return;
  }
  const entry = overflowKind === 'weekly' ? latestUsage.seven_day : latestUsage.five_hour;
  if (!entry || !entry.resets_at) {
    el.innerHTML = '';
    return;
  }
  const parts = getCountdownParts(entry.resets_at);
  const pad = (n) => String(n).padStart(2, '0');
  const timeStr = parts ? `${pad(parts.h)}:${pad(parts.m)}:${pad(parts.s)}` : '00:00:00';
  const remainingSec = Math.max(0, Math.floor((new Date(entry.resets_at).getTime() - Date.now()) / 1000));
  // 快到重置时间了：30 分钟内偏蓝、5 分钟内偏绿，都是低饱和度的提示色，不追求警报感。
  const urgencyClass = remainingSec <= 300 ? 'critical' : remainingSec <= 1800 ? 'warning' : '';
  // "week" 标签和"N天"合成一块（meta），用绝对定位挂在 HH:MM:SS 左边（见 CSS），
  // 整体不占布局宽度，所以不管有没有标签、有没有天数，HH:MM:SS 的字号和位置都不变。
  const label = overflowKind === 'weekly' ? '<span class="overflow-label">week</span>' : '';
  const days = parts && parts.days > 0 ? `<span class="overflow-days">${parts.days}天</span>` : '';
  const meta = label || days ? `<div class="overflow-meta">${label}${days}</div>` : '';
  el.innerHTML = `
    <div class="overflow-time-row">
      ${meta}
      <span class="overflow-digits ${urgencyClass}">${timeStr}</span>
    </div>
  `;
}

function colorFor(pct) {
  if (pct < 50) return '#4CAF50';
  if (pct < 75) return '#d8b400';
  if (pct < 90) return '#e8600a';
  return '#f85149';
}

function formatCountdown(resetsAtIso, label) {
  if (!resetsAtIso) return '';
  const parts = getCountdownParts(resetsAtIso);
  if (!parts) return `${label}即将重置`;
  const pad = (n) => String(n).padStart(2, '0');
  const timeStr = `${pad(parts.h)}:${pad(parts.m)}:${pad(parts.s)}`;
  const fullTimeStr = parts.days > 0 ? `${parts.days}天 ${timeStr}` : timeStr;
  return `${label}重置倒计时 ${fullTimeStr}`;
}

function updateHandleColor() {
  const handle = document.querySelector('.handle');
  if (!handle || !latestUsage) return;
  let maxPct = 0;
  for (const key of ORDER) {
    const entry = latestUsage[key];
    if (entry && typeof entry.utilization === 'number') {
      maxPct = Math.max(maxPct, entry.utilization);
    }
  }
  handle.style.background = colorFor(Math.round(maxPct));
}

function render() {
  const barsEl = document.getElementById('bars');
  const statusEl = document.getElementById('status');
  const countdownEl = document.getElementById('countdown');
  const countdownWeeklyEl = document.getElementById('countdownWeekly');

  if (!latestUsage) {
    return;
  }

  statusEl.textContent = '';
  statusEl.innerHTML = '';

  let html = '';
  for (const key of ORDER) {
    const entry = latestUsage[key];
    if (!entry || typeof entry.utilization !== 'number') continue;
    const pct = Math.max(0, Math.min(100, Math.round(entry.utilization)));
    const color = colorFor(pct);
    html += `
      <div class="bar-row">
        <div class="bar-label"><span>${KEY_LABELS[key] || key}</span><span>${pct}%</span></div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div>
      </div>
    `;
  }

  if (!html) {
    barsEl.innerHTML = '';
    statusEl.textContent = '暂无可用的用量数据';
    countdownEl.textContent = '';
    countdownWeeklyEl.textContent = '';
    return;
  }

  barsEl.innerHTML = html;

  const session = latestUsage.five_hour;
  countdownEl.textContent = session && session.resets_at ? formatCountdown(session.resets_at, '会话') : '';

  const weekly = latestUsage.seven_day;
  countdownWeeklyEl.textContent =
    weekly && weekly.resets_at ? formatCountdown(weekly.resets_at, '周') : '';

  updateHandleColor();
  renderOverflowBar();
}

function startCountdownTicker() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    if (latestUsage) render();
  }, 1000);
}

function showLoadingState() {
  document.getElementById('status').textContent = '加载中...';
  document.getElementById('bars').innerHTML = '';
  document.getElementById('countdown').textContent = '';
  document.getElementById('countdownWeekly').textContent = '';
}

function showLoginPrompt() {
  const statusEl = document.getElementById('status');
  document.getElementById('bars').innerHTML = '';
  document.getElementById('countdown').textContent = '';
  document.getElementById('countdownWeekly').textContent = '';
  statusEl.innerHTML = '未登录 claude.ai，<a id="loginLink">点击登录</a>';
  document.getElementById('loginLink').addEventListener('click', () => {
    window.electronAPI.openLogin();
  });
}

function showErrorState(err) {
  const statusEl = document.getElementById('status');
  document.getElementById('bars').innerHTML = '';
  document.getElementById('countdown').textContent = '';
  document.getElementById('countdownWeekly').textContent = '';
  statusEl.textContent = `获取用量失败 (${err})，稍后自动重试`;
}

window.electronAPI.onUsageUpdate((payload) => {
  latestUsage = payload.usage;
  document.getElementById('updated').textContent =
    '更新于 ' + new Date(payload.ts).toLocaleTimeString('zh-CN', { hour12: false });
  render();
});

window.electronAPI.onUsageError((err) => {
  latestUsage = null;
  if (err === 'NEED_LOGIN') {
    showLoginPrompt();
  } else {
    showErrorState(err);
  }
});

window.electronAPI.onPinState((pinned) => {
  document.getElementById('pinBtn').classList.toggle('active', pinned);
});

window.electronAPI.onCollapseState(({ collapsed }) => {
  document.body.classList.toggle('collapsed', collapsed);
});

window.electronAPI.onThemeState((light) => {
  document.body.classList.toggle('light', !!light);
});

window.electronAPI.onOverflowState((state) => {
  overflowActive = !!(state && state.active);
  overflowKind = (state && state.kind) || null;
  document.body.classList.toggle('overflow-active', overflowActive);
  renderOverflowBar();
});

document.getElementById('refreshBtn').addEventListener('click', () => {
  window.electronAPI.refresh();
});
document.getElementById('closeBtn').addEventListener('click', () => {
  window.electronAPI.hide();
});
document.getElementById('pinBtn').addEventListener('click', () => {
  window.electronAPI.togglePin();
});

// 收起/展开的触发：整个窗口在收起时会被主进程缩成一个贴边细条，
// 所以这里只需要监听"鼠标是否还在这个窗口范围内"即可。
document.documentElement.addEventListener('mouseenter', () => {
  window.electronAPI.hoverEnter();
});
document.documentElement.addEventListener('mouseleave', () => {
  window.electronAPI.hoverLeave();
});

showLoadingState();
startCountdownTicker();
