/**
 * background.js — Service Worker for Badge Updates
 *
 * Event-driven background script for 归拢.
 *
 * 两件事：
 *   1. 维护工具栏徽章上的标签页计数。
 *   2. 接住工具栏图标的点击，以及 open-dashboard 快捷键 —— 两者走同一个
 *      focusOrOpenDashboard()，「呼出仪表盘」只有一套行为。
 *
 * Since we no longer have a server, we query chrome.tabs directly.
 * The badge counts real web tabs (skipping browser-internal pages).
 *
 * ⚠️ 这个文件同时跑在两种后台里：
 *   - Chrome / Edge：service worker（manifest 的 background.service_worker）
 *   - Firefox：event page（manifest 的 background.scripts，没有 service worker）
 *   所以要照最低标准写——别用 window、别用 localStorage、监听器一律挂在顶层。
 *
 * Color coding gives a quick at-a-glance health signal:
 *   Green  (#3d7a4a) → 1–10 tabs  (focused, manageable)
 *   Amber  (#b8892e) → 11–20 tabs (getting busy)
 *   Red    (#b35a5a) → 21+ tabs   (time to cull!)
 */

/* ─── 浏览器环境 ──────────────────────────────────────────────────────────────
   env.js 在 Firefox 的 manifest 里排在 background.js 前面，会先加载好；
   Chrome 的 service worker 没有 "scripts" 这个键，只能靠 importScripts 现拉。
   两条路都走一遍（谁先到算谁的），取不到就按 Chromium 兜底。               */
if (typeof globalThis.GL_ENV === 'undefined' && typeof importScripts === 'function') {
  importScripts('./env.js');
}

function bgEnv() {
  return (typeof globalThis !== 'undefined' && globalThis.GL_ENV) || {
    isFirefox: false,
    browserNewtabUrls: ['chrome://newtab/', 'edge://newtab/'],
    isInternalUrl: u => /^(about:|chrome:|edge:|brave:|opera:|chrome-extension:|moz-extension:)/.test(u || ''),
  };
}

// ─── Badge updater ────────────────────────────────────────────────────────────

/**
 * updateBadge()
 *
 * Counts open real-web tabs and updates the extension's toolbar badge.
 * "Real" tabs = not browser-internal pages, not extension pages.
 *
 * 内部页的清单在 env.js 里 —— 三家浏览器的 scheme 不一样（Firefox 是
 * moz-extension://、about:newtab），写死在这里角标就会把内部页数进去。
 */
let badgeUpdateRunning = false;
let badgeUpdatePending = false;

// 批量关页时合并事件；查询和写角标串行，旧结果不会覆盖新结果。
async function updateBadge() {
  badgeUpdatePending = true;
  if (badgeUpdateRunning) return;
  badgeUpdateRunning = true;
  try {
    while (badgeUpdatePending) {
      badgeUpdatePending = false;
      await refreshBadge();
    }
  } finally {
    badgeUpdateRunning = false;
  }
}

async function refreshBadge() {
  try {
    const tabs = await chrome.tabs.query({});
    const isInternal = bgEnv().isInternalUrl;

    // Only count actual web pages — skip browser internals and extension pages
    const count = tabs.filter(t => !isInternal(t.url)).length;

    // Don't show "0" — an empty badge is cleaner
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });

    if (count === 0) return;

    // Pick badge color based on workload level
    let color;
    if (count <= 10) {
      color = '#3d7a4a'; // Green — you're in control
    } else if (count <= 20) {
      color = '#b8892e'; // Amber — things are piling up
    } else {
      color = '#b35a5a'; // Red — time to focus and close some tabs
    }

    await chrome.action.setBadgeBackgroundColor({ color });

  } catch {
    // If something goes wrong, clear the badge rather than show stale data
    try { await chrome.action.setBadgeText({ text: '' }); } catch { /* 浏览器正在退出 */ }
  }
}

// ─── 快捷键：呼出 / 聚焦仪表盘 ───────────────────────────────────────────────

/**
 * focusOrOpenDashboard()
 *
 * 快捷键触发时调用。已经开着归拢就切过去（跨窗口也行），
 * 没开就新建一个。
 *
 * 为什么不用 ⌘+1：那是浏览器的保留快捷键，扩展既注册不了也覆盖不了。
 * 用户在浏览器自己的快捷键设置页里改（Chrome/Edge 一个地址、Firefox 一个，
 * 见 env.js）。
 */
async function focusOrOpenDashboard() {
  const dashboardUrl = chrome.runtime.getURL('index.html');
  const newtabs      = bgEnv().browserNewtabUrls;

  const tabs = await chrome.tabs.query({});
  const existing = tabs.find(t => t.url === dashboardUrl || newtabs.indexOf(t.url) !== -1);

  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }

  await chrome.tabs.create({ url: dashboardUrl });
}

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'open-dashboard') return;
  focusOrOpenDashboard();
});

// ─── 工具栏图标：点一下就把仪表盘叫出来 ────────────────────────────────────────
//
// 以前点这个图标是没反应的：manifest 里没给 default_popup，也从来没注册过
// onClicked —— 浏览器照常把点击派发出来，只是没人接，而且这种「没人接」
// 是静默的，不会报错、不会留日志。现在把图标跟快捷键接到同一个函数上。
//
// ⚠️ 只有「图标没有 popup」时 onClicked 才会触发。将来如果给 action 加了
// default_popup，这段会在不报错的情况下失效，点击变成弹小窗。
chrome.action.onClicked.addListener(() => {
  focusOrOpenDashboard();
});

// ─── Event listeners ──────────────────────────────────────────────────────────

// Update badge when the extension is first installed
chrome.runtime.onInstalled.addListener(() => {
  updateBadge();
});

// Update badge when Chrome starts up
chrome.runtime.onStartup.addListener(() => {
  updateBadge();
});

// Update badge whenever a tab is opened
chrome.tabs.onCreated.addListener(() => {
  updateBadge();
});

// Update badge whenever a tab is closed
chrome.tabs.onRemoved.addListener(() => {
  updateBadge();
});

// Update badge when a tab's URL changes (e.g. navigating to/from chrome://)
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  // 标题、图标、加载进度不改变计数，不必重新扫描全部标签页。
  if (changeInfo.url !== undefined) updateBadge();
});

// 浏览器预渲染等操作可能直接替换标签页。
chrome.tabs.onReplaced.addListener(() => {
  updateBadge();
});

// ─── Initial run ─────────────────────────────────────────────────────────────

// Run once immediately when the service worker first loads
updateBadge();
