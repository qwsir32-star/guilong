/**
 * background.js — Service Worker for Badge Updates
 *
 * Chrome's "always-on" background script for 归拢.
 *
 * 两件事：
 *   1. 维护工具栏徽章上的标签页计数。
 *   2. 接住工具栏图标的点击，以及 open-dashboard 快捷键 —— 两者走同一个
 *      focusOrOpenDashboard()，「呼出仪表盘」只有一套行为。
 *
 * Since we no longer have a server, we query chrome.tabs directly.
 * The badge counts real web tabs (skipping chrome:// and extension pages).
 *
 * Color coding gives a quick at-a-glance health signal:
 *   Green  (#3d7a4a) → 1–10 tabs  (focused, manageable)
 *   Amber  (#b8892e) → 11–20 tabs (getting busy)
 *   Red    (#b35a5a) → 21+ tabs   (time to cull!)
 */

// ─── Badge updater ────────────────────────────────────────────────────────────

/**
 * updateBadge()
 *
 * Counts open real-web tabs and updates the extension's toolbar badge.
 * "Real" tabs = not chrome://, not extension pages, not about:blank.
 */
async function updateBadge() {
  try {
    const tabs = await chrome.tabs.query({});

    // Only count actual web pages — skip browser internals and extension pages
    const count = tabs.filter(t => {
      const url = t.url || '';
      return (
        !url.startsWith('chrome://') &&
        !url.startsWith('chrome-extension://') &&
        !url.startsWith('about:') &&
        !url.startsWith('edge://') &&
        !url.startsWith('brave://')
      );
    }).length;

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
    chrome.action.setBadgeText({ text: '' });
  }
}

// ─── 快捷键：呼出 / 聚焦仪表盘 ───────────────────────────────────────────────

/**
 * focusOrOpenDashboard()
 *
 * 快捷键触发时调用。已经开着归拢就切过去（跨窗口也行），
 * 没开就新建一个。
 *
 * 为什么不用 ⌘+1：那是 Chrome 的保留快捷键，扩展既注册不了也覆盖不了。
 * 用户可以在 chrome://extensions/shortcuts 里改成自己顺手的键。
 */
async function focusOrOpenDashboard() {
  const dashboardUrl = chrome.runtime.getURL('index.html');

  const tabs = await chrome.tabs.query({});
  const existing = tabs.find(t => t.url === dashboardUrl || t.url === 'chrome://newtab/');

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
chrome.tabs.onUpdated.addListener(() => {
  updateBadge();
});

// ─── Initial run ─────────────────────────────────────────────────────────────

// Run once immediately when the service worker first loads
updateBadge();
