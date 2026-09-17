/* ================================================================
   归拢 — Dashboard App (Pure Extension Edition)

   This file is the brain of the dashboard. Now that the dashboard
   IS the extension page (not inside an iframe), it can call
   chrome.tabs and chrome.storage directly — no postMessage bridge needed.

   What this file does:
   1. Reads open browser tabs directly via chrome.tabs.query()
   2. Groups tabs by domain with a landing pages category
   3. Renders domain cards, banners, and stats
   4. Handles all user actions (close tabs, save for later, focus tab)
   5. Stores "Saved for Later" tabs in chrome.storage.local (no server)
   ================================================================ */

'use strict';


/* ----------------------------------------------------------------
   CHROME TABS — Direct API Access

   Since this page IS the extension's new tab page, it has full
   access to chrome.tabs and chrome.storage. No middleman needed.
   ---------------------------------------------------------------- */

// All open tabs — populated by fetchOpenTabs()
let openTabs = [];

/**
 * fetchOpenTabs()
 *
 * Reads all currently open browser tabs directly from Chrome.
 * Sets the extensionId flag so we can identify Guilong's own pages.
 */
async function fetchOpenTabs() {
  try {
    const extensionId = chrome.runtime.id;
    // The new URL for this page is now index.html (not newtab.html)
    const newtabUrl = `chrome-extension://${extensionId}/index.html`;

    const tabs = await chrome.tabs.query({});
    openTabs = tabs.map(t => ({
      id:       t.id,
      url:      t.url,
      title:    t.title,
      windowId: t.windowId,
      active:   t.active,
      // Flag Guilong's own pages so we can detect duplicate new tabs
      isTabOut: t.url === newtabUrl || t.url === 'chrome://newtab/',
    }));
  } catch {
    // chrome.tabs API unavailable (shouldn't happen in an extension page)
    openTabs = [];
  }
}

/**
 * closeTabsByUrls(urls)
 *
 * Closes all open tabs whose hostname matches any of the given URLs.
 * After closing, re-fetches the tab list to keep our state accurate.
 *
 * Special case: file:// URLs are matched exactly (they have no hostname).
 */
async function closeTabsByUrls(urls) {
  if (!urls || urls.length === 0) return;

  // Separate file:// URLs (exact match) from regular URLs (hostname match)
  const targetHostnames = [];
  const exactUrls = new Set();

  for (const u of urls) {
    if (u.startsWith('file://')) {
      exactUrls.add(u);
    } else {
      try { targetHostnames.push(new URL(u).hostname); }
      catch { /* skip unparseable */ }
    }
  }

  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs
    .filter(tab => {
      const tabUrl = tab.url || '';
      if (tabUrl.startsWith('file://') && exactUrls.has(tabUrl)) return true;
      try {
        const tabHostname = new URL(tabUrl).hostname;
        return tabHostname && targetHostnames.includes(tabHostname);
      } catch { return false; }
    })
    .map(tab => tab.id);

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabsExact(urls)
 *
 * Closes tabs by exact URL match (not hostname). Used for landing pages
 * so closing "Gmail inbox" doesn't also close individual email threads.
 */
async function closeTabsExact(urls) {
  if (!urls || urls.length === 0) return;
  const urlSet = new Set(urls);
  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs.filter(t => urlSet.has(t.url)).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * focusTab(url)
 *
 * Switches Chrome to the tab with the given URL (exact match first,
 * then hostname fallback). Also brings the window to the front.
 */
async function focusTab(url) {
  if (!url) return;
  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();

  // Try exact URL match first
  let matches = allTabs.filter(t => t.url === url);

  // Fall back to hostname match
  if (matches.length === 0) {
    try {
      const targetHost = new URL(url).hostname;
      matches = allTabs.filter(t => {
        try { return new URL(t.url).hostname === targetHost; }
        catch { return false; }
      });
    } catch {}
  }

  if (matches.length === 0) return;

  // Prefer a match in a different window so it actually switches windows
  const match = matches.find(t => t.windowId !== currentWindow.id) || matches[0];
  await chrome.tabs.update(match.id, { active: true });
  await chrome.windows.update(match.windowId, { focused: true });
}

/**
 * closeDuplicateTabs(urls, keepOne)
 *
 * Closes duplicate tabs for the given list of URLs.
 * keepOne=true → keep one copy of each, close the rest.
 * keepOne=false → close all copies.
 */
async function closeDuplicateTabs(urls, keepOne = true) {
  const allTabs = await chrome.tabs.query({});
  const toClose = [];

  for (const url of urls) {
    const matching = allTabs.filter(t => t.url === url);
    if (keepOne) {
      const keep = matching.find(t => t.active) || matching[0];
      for (const tab of matching) {
        if (tab.id !== keep.id) toClose.push(tab.id);
      }
    } else {
      for (const tab of matching) toClose.push(tab.id);
    }
  }

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabOutDupes()
 *
 * Closes all duplicate Guilong new-tab pages except the current one.
 */
async function closeTabOutDupes() {
  const extensionId = chrome.runtime.id;
  const newtabUrl = `chrome-extension://${extensionId}/index.html`;

  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();
  const tabOutTabs = allTabs.filter(t =>
    t.url === newtabUrl || t.url === 'chrome://newtab/'
  );

  if (tabOutTabs.length <= 1) return;

  // Keep the active Guilong tab in the CURRENT window — that's the one the
  // user is looking at right now. Falls back to any active one, then the first.
  const keep =
    tabOutTabs.find(t => t.active && t.windowId === currentWindow.id) ||
    tabOutTabs.find(t => t.active) ||
    tabOutTabs[0];
  const toClose = tabOutTabs.filter(t => t.id !== keep.id).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — chrome.storage.local

   Replaces the old server-side SQLite + REST API with Chrome's
   built-in key-value storage. Data persists across browser sessions
   and doesn't require a running server.

   Data shape stored under the "deferred" key:
   [
     {
       id: "1712345678901",          // timestamp-based unique ID
       url: "https://example.com",
       title: "Example Page",
       savedAt: "2026-04-04T10:00:00.000Z",  // ISO date string
       completed: false,             // true = checked off (archived)
       dismissed: false              // true = dismissed without reading
     },
     ...
   ]
   ---------------------------------------------------------------- */

/**
 * saveTabForLater(tab)
 *
 * Saves a single tab to the "Saved for Later" list in chrome.storage.local.
 * @param {{ url: string, title: string }} tab
 */
async function saveTabForLater(tab) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  deferred.push({
    id:        Date.now().toString(),
    url:       tab.url,
    title:     tab.title,
    savedAt:   new Date().toISOString(),
    completed: false,
    dismissed: false,
  });
  await chrome.storage.local.set({ deferred });
}

/**
 * getSavedTabs()
 *
 * Returns all saved tabs from chrome.storage.local.
 * Filters out dismissed items (those are gone for good).
 * Splits into active (not completed) and archived (completed).
 */
async function getSavedTabs() {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const visible = deferred.filter(t => !t.dismissed);
  return {
    active:   visible.filter(t => !t.completed),
    archived: visible.filter(t => t.completed),
  };
}

/**
 * checkOffSavedTab(id)
 *
 * Marks a saved tab as completed (checked off). It moves to the archive.
 */
async function checkOffSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.completed = true;
    tab.completedAt = new Date().toISOString();
    await chrome.storage.local.set({ deferred });
  }
}

/**
 * dismissSavedTab(id)
 *
 * Marks a saved tab as dismissed (removed from all lists).
 */
async function dismissSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.dismissed = true;
    await chrome.storage.local.set({ deferred });
  }
}

/**
 * openAllSavedTabs()
 *
 * 一键打开「Saved for later」里所有还没打勾的条目。
 *
 * 全部用 active:false 在后台打开，刻意不抢焦点 —— 用户点这个按钮通常是
 * 在仪表盘上「播种」，希望自己还留在仪表盘上继续整理，而不是被甩到最后一个
 * 标签页里。返回实际打开的条数，交给调用方决定 toast 文案。
 */
async function openAllSavedTabs() {
  const { active } = await getSavedTabs();
  if (active.length === 0) return 0;

  for (const item of active) {
    await chrome.tabs.create({ url: item.url, active: false });
  }
  return active.length;
}

/**
 * saveAllOpenTabs(options)
 *
 * 把当前所有「真实网页」标签页批量存进 Saved for later。
 *
 * 去重规则：只跟 active（未打勾）列表比 URL。已归档 / 已删除的 URL 允许重新
 * 存进来 —— 用户把它划掉或删掉，说明那一轮结束了，再存一次是新一轮的待办。
 *
 * @param {{ closeAfter?: boolean }} [options] closeAfter=true 时存完顺手关掉这些标签页。
 * @returns {Promise<{ added: number, skipped: number, closed: number }>}
 *          skipped = 因重复而跳过的数量（它已经在待办里，不重复入库）。
 */
async function saveAllOpenTabs({ closeAfter = false } = {}) {
  const { active } = await getSavedTabs();
  const pending   = new Set(active.map(t => t.url));

  // 只处理真实网页，顺手排除归拢自己（getRealTabs 已滤掉 chrome-extension://）
  const candidates = getRealTabs().filter(t => !t.isTabOut && t.url);

  const base  = Date.now();
  const fresh = [];
  let   skipped = 0;

  candidates.forEach((t, i) => {
    if (pending.has(t.url)) { skipped += 1; return; }
    pending.add(t.url);
    fresh.push({
      // 用 `${base}-${i}` 而不是 Date.now()：批量写入时毫秒级时间戳会撞车，
      // 撞了就变成同一个 id，之后打勾/删除会误伤到别人。
      id:        `${base}-${i}`,
      url:       t.url,
      title:     t.title || t.url,
      savedAt:   new Date().toISOString(),
      completed: false,
      dismissed: false,
    });
  });

  if (fresh.length > 0) {
    const { deferred = [] } = await chrome.storage.local.get('deferred');
    deferred.push(...fresh);
    await chrome.storage.local.set({ deferred });
  }

  let closed = 0;

  // 「存入并关闭」关的是**全部候选标签页**，不只是这次新存的那几条。
  // 因为被 skip 的候选只有一个原因：它的 URL 早就在待办里了 —— 关掉不丢任何东西，
  // 而用户点这个按钮的心理预期就是「标签栏清干净」，留几个重复的在会很困惑。
  //
  // 关闭走精确 URL 匹配（closeTabsExact），不能用 closeTabsByUrls ——
  // 后者按 hostname 关，会顺手干掉同站其他没被列为候选的页面。
  if (closeAfter && candidates.length > 0) {
    closed = candidates.length;
    await closeTabsExact(candidates.map(t => t.url));
  }

  return { added: fresh.length, skipped, closed };
}


/* ----------------------------------------------------------------
   常用站点（手动钉住 + chrome.topSites 自动补足）

   为什么要有这一块：归拢接管新标签页之后，Chrome 原生的那排
   「快捷方式」就没了，用户原来靠它一键到常用网站，现在无路可走。
   这里把那个能力找回来：手动钉的排前面并固定顺序，剩下的用
   chrome.topSites 的历史热度自动补。

   两个存储键：
     pinnedSites    手动钉住，[{ url, title, addedAt }]
     hiddenTopSites 自动部分里被用户叉掉的，存 siteKey 字符串数组
   ---------------------------------------------------------------- */

const PINNED_SITES_KEY     = 'pinnedSites';
const HIDDEN_TOP_SITES_KEY = 'hiddenTopSites';
const MAX_AUTO_SITES       = 10;
// 新标签页上各模块的开关（设置面板里那几个 toggle）
const UI_PREFS_KEY         = 'uiPrefs';

/** hostnameOf(url) — 取不到就返回空串，绝不抛 */
function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return ''; }
}

/**
 * siteKey(url) — 一个站点的身份，用于去重
 *
 * 用 hostname 而不是完整 URL：这一条里的图标代表的是「站点」，
 * 不是「某个页面」。同一个站的不同页面只该有一个图标。
 */
function siteKey(url) {
  return hostnameOf(url).toLowerCase();
}

/**
 * originOf(url) — 站点入口地址（协议 + 主机 + /），取不到返回空串
 *
 * 自动部分（topSites）要把深链削成入口：历史热度里很可能躺着
 * `github.com/someone/some-repo` 这种具体页面，但这一行图标底下写的是
 * 「GitHub」，点下去却进到某个仓库，就跟标签对不上了。
 * 手动钉住的不削 —— 用户明确给的深链要尊重。
 */
function originOf(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/i.test(u.protocol)) return '';
    return u.origin + '/';
  } catch {
    return '';
  }
}

/**
 * sameEntryUrl(a, b) — 两个 URL 是不是「同一个入口」
 *
 * 比精确相等松一点：忽略 www. 的有无、忽略协议、忽略末尾斜杠、忽略 hash 和
 * utm_* 追踪参数。但**绝不忽略路径**：主页就是主页，视频页就是视频页。
 *
 * 这条规则是踩出来的：早先站点条按 hostname 找已开标签页，结果点「B站」
 * 会切到你正开着的某个 B 站视频页，而不是主页；点「GitHub」会切到某个仓库页。
 * 按 hostname 匹配是给「关闭该站全部标签页」那种批量语义用的，不是给
 * 「去这个网站的入口」用的。
 */
function sameEntryUrl(a, b) {
  const norm = u => {
    try {
      const x = new URL(u);
      for (const k of [...x.searchParams.keys()]) {
        if (/^utm_/i.test(k)) x.searchParams.delete(k);
      }
      return (
        x.hostname.replace(/^www\./, '').toLowerCase() +
        x.pathname.replace(/\/+$/, '') +
        (x.search || '')
      );
    } catch {
      return '';
    }
  };
  const na = norm(a);
  return Boolean(na) && na === norm(b);
}

/**
 * isSiteRoot(url) — 这是不是「网站首页」
 *
 * 只有裸主域才算（github.com、www.bilibili.com/）。带路径或查询的一律不算：
 * douyu.com/6657?dyshid=... 是「玩机器直播间」，不是斗鱼首页。
 * 这一条是区分「官网」和「个性化页面」的依据 —— 两者的默认名称来源不一样。
 */
function isSiteRoot(url) {
  try {
    const u = new URL(url);
    return u.pathname.replace(/\/+$/, '') === '' && !u.search && !u.hash;
  } catch {
    return false;
  }
}

/**
 * pathHintOf(url) — 从路径 / 查询里抠一个能看的提示词
 *   github.com/features/actions → 'features/actions'
 *   douyu.com/6657?dyshid=xxx   → '6657'
 */
function pathHintOf(url) {
  const clip = s => (s.length > 24 ? s.slice(0, 24) + '…' : s);
  try {
    const u = new URL(url);
    let path = '';
    try { path = decodeURIComponent(u.pathname); } catch { path = u.pathname; }
    path = path.replace(/^\/+|\/+$/g, '');
    if (path) return clip(path);

    for (const [, v] of u.searchParams) {
      if (v) return clip(v);
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * suggestSiteName(url) — 自动抓一个建议名称
 *
 * 优先级：
 *   1. 网站首页     → FRIENDLY_DOMAINS 的友好名（github.com → GitHub、bilibili.com → B站）
 *   2. 具体页面且正开着 → 用那一页的网页标题（最贴近「这页到底是什么」）
 *   3. 兜底         → 友好名 + 路径提示（Douyu · 6657）
 *
 * 第 3 条的意义是**不要让人误以为这是首页**：光写「Douyu」，用户点下去发现是
 * 某个直播间会莫名其妙。带上路径提示至少诚实。
 *
 * @returns {Promise<{name: string, source: 'root'|'tab'|'guess'}>}
 */
async function suggestSiteName(url) {
  const host     = hostnameOf(url);
  const friendly = friendlyDomain(host);

  if (isSiteRoot(url)) {
    return { name: friendly || host, source: 'root' };
  }

  // 这一页要是正开着，它的标题是最好的名称来源，且不需要任何额外权限
  await fetchOpenTabs();
  const open     = openTabs.find(t => t.url && sameEntryUrl(t.url, url));
  const tabTitle = open ? stripTitleNoise(open.title || '').trim() : '';
  if (tabTitle) return { name: tabTitle, source: 'tab' };

  const hint = pathHintOf(url);
  return { name: hint ? `${friendly} · ${hint}` : friendly, source: 'guess' };
}

/**
 * normalizeSiteUrl(raw) — 把用户随手输的东西凑成一个能用的 URL
 *
 * 「github.com」→「https://github.com/」
 * 「https://a.com/x」原样（规范化后）返回
 * 凑不出来（空、只有空格、伪协议、没有点的裸词）→ null
 */
function normalizeSiteUrl(raw) {
  let s = (raw || '').trim();
  if (!s) return null;

  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    // 已经带协议了，但只放行 http(s)，避免钉住 javascript: / data: 之类的伪协议
    if (!/^https?:/i.test(s)) return null;
  } else {
    s = 'https://' + s;
  }

  try {
    const u = new URL(s);
    // 裸词（localhost、随便打的字）不算站点
    if (!u.hostname || !u.hostname.includes('.')) return null;
    return u.href;
  } catch {
    return null;
  }
}

/**
 * siteLabel(site) — 图标下面那行字
 *
 * 两类来源的取名逻辑不一样：
 *
 * **手动钉住的**：名称是用户填过（或系统抓来给他改过）的，直接用它 ——
 * 这是用户对这个入口的称呼，不能被域名猜出来的名字顶掉。
 *
 * **自动补的**：title 是网页标题，又长又带噪音（"哔哩哔哩 (゜-゜)つロ 干杯~"），
 * 优先用 FRIENDLY_DOMAINS 的友好名。认不出的长域名正好是 friendlyDomain 猜得
 * 最难看的（news.ycombinator.co.uk → "News Ycombinator"），这时候退回网页标题。
 *
 * 图标底下只有 76px 宽，超过 12 个字符会被 CSS 截成省略号，这里先手动截一道，
 * 免得截断位置落在半个字上。
 */
function siteLabel(site) {
  const host  = hostnameOf(site.url);
  const title = (site.title || '').trim();
  const clip  = s => (s.length > 12 ? s.slice(0, 12) + '…' : s);

  if (site.pinned) {
    return clip(title) || friendlyDomain(host) || host;
  }

  const friendly = friendlyDomain(host);
  if (friendly && friendly.length <= 12) return friendly;
  return clip(title) || friendly || host;
}

/**
 * resolveSiteIcon(site, label) — 算出这个站点该显示什么图标
 *
 * site.icon 有三种含义：
 *   留空          → 自动，用站点 favicon
 *   http(s) 地址  → 用这张图
 *   1-2 个字符    → 拿文字当图标
 *
 * @returns {{ img: string, letter: string, host: string }}
 *          host 只在自动 favicon 时才给（失败要退到 google s2 才需要它）
 */
function resolveSiteIcon(site, label) {
  const icon  = (site.icon || '').trim();
  const first = ((label || '?').match(/[A-Za-z0-9\u4e00-\u9fa5]/) || ['?'])[0].toUpperCase();

  if (!icon) {
    return { img: faviconUrlFor(site.url, 32), letter: first, host: hostnameOf(site.url) };
  }
  if (/^https?:\/\//i.test(icon)) {
    // 自定义图挂了就直接删掉，别退 s2 —— 那是给站点 favicon 用的服务，
    // 拿它去查这张自定义图的域名只会得到一张更不相干的图。
    return { img: icon, letter: first, host: '' };
  }
  return { img: '', letter: icon.slice(0, 2), host: '' };
}

/**
 * faviconUrlFor(url, size) — 图标地址
 *
 * 走 MV3 自带的 _favicon 端点：读的是**浏览器本地**的图标缓存，不发网络请求、
 * 不受墙影响。需要一个 favicon 权限，已在 manifest.json 里声明。
 *
 * 注意它「读不到」的两种表现完全不同：
 *   - 真出错（比如 URL 压根不合法）→ 图片 onerror，退到 google s2，再退首字母色块
 *   - 本地没有这个站的缓存 → **返回一张默认地球图，不报错**
 * 第二种才是「有的网站怎么没有图标」的常见原因，靠 dropIfDefaultFavicon 处理。
 */
function faviconUrlFor(url, size = 32) {
  return `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(url)}&size=${size}`;
}

/**
 * handleFaviconError(img) — favicon 加载失败时的兜底
 *
 * 第一步退到 google s2，第二步直接删掉 <img>，露出底下那层首字母色块
 * （没有色块的地方就是干净地什么都不显示，不会留个「破图」）。
 *
 * 注意：**不能**写成 HTML 里的 onerror="..." —— MV3 扩展页面的默认 CSP 是
 * `script-src 'self'`，内联事件处理器会被拦掉（控制台报 Refused to execute
 * inline event handler），兜底等于没有。所以统一在渲染后用 JS 挂 onerror 属性。
 */
function handleFaviconError(img) {
  const host = img.dataset.host;

  if (img.dataset.fb !== '1' && host) {
    img.dataset.fb = '1';
    img.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`;
    return;
  }
  img.remove();
}

/**
 * wireFaviconFallbacks(root) — 给 root 里所有 favicon 挂上失败兜底
 *
 * 渲染完同步调用即可：innerHTML 只是把 src 排进加载队列，图片的 error 事件
 * 一定在之后的宏任务里才触发，所以这里挂监听不会漏掉。
 *
 * 两条兜底路都要挂：
 *   - 加载**出错** → onerror（见 handleFaviconError）
 *   - 加载**成功但给的是张默认占位图** → dropIfDefaultFavicon
 */
function wireFaviconFallbacks(root) {
  if (!root) return;
  root.querySelectorAll('img[data-favicon]').forEach(img => {
    if (img.dataset.fbWired === '1') return;
    img.dataset.fbWired = '1';
    img.onerror = () => handleFaviconError(img);
    dropIfDefaultFavicon(img);
  });
}

/* ---------------- 「这图标其实是张占位图」的识别 ----------------
   Chrome 的 _favicon 端点在本地**没有**这个站的图标缓存时，不会返回 404，
   而是返回一张默认的「地球」占位图（未加载完的标签页就是那张）。
   所以 onerror 根本不会触发 —— 底下垫的首字母色块永远露不出来，
   用户看到的是一个灰扑扑的地球，读起来就是「这个网站没有图标」。

   唯一的办法是把图读进 canvas 比像素。_favicon 跟扩展页面同源，
   不会被 canvas 的跨域保护打上 tainted 标记，getImageData 读得出来。

   基准图的指纹是**运行时现求**的：拿一个必然不存在的域名去问一次 _favicon，
   它返回什么就记下来当基准。这样 Chrome 换版本、换平台改动了这张占位图，
   识别也不会失效 —— 不要去硬编码某张图的哈希。

   读不出像素时一律当作「不知道」，保持现状不删图：宁可多显示一个地球，
   也不要因为猜错而把真图标删掉。
   ------------------------------------------------------------------ */

const DEFAULT_FAVICON_PROBE = 'https://guilong-no-such-site.invalid/';
let   defaultFaviconSig     = null;   // Promise<string|null>，只求一次

/**
 * faviconSignature(source) — 给一张图算个便宜的内容指纹
 * @param {string|HTMLImageElement} source  图片地址，或一张已经加载好的 <img>
 * @returns {Promise<string|null>} 读不出来（未加载完 / tainted / 无尺寸）时给 null
 */
function faviconSignature(source) {
  return new Promise(resolve => {
    const isEl = source && typeof source !== 'string';
    const img  = isEl ? source : new Image();

    const read = () => {
      try {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        if (!w || !h) return resolve(null);

        const canvas = document.createElement('canvas');
        canvas.width  = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        const data = ctx.getImageData(0, 0, w, h).data;
        // FNV-1a。这里只需要「同一张图给出同一个值、不同图基本不会撞」，
        // 不涉及安全，不需要抗碰撞的哈希。
        let hash = 2166136261;
        for (let i = 0; i < data.length; i += 4) {
          hash = ((hash ^ data[i])     * 16777619) >>> 0;
          hash = ((hash ^ data[i + 3]) * 16777619) >>> 0;   // 顺带带上 alpha
        }
        resolve(`${w}x${h}#${hash}`);
      } catch (err) {
        resolve(null);
      }
    };

    if (isEl) {
      // 已经在页面上的 <img>：加载完了就直接读，没完就等它
      if (img.complete) return img.naturalWidth ? read() : resolve(null);
      img.addEventListener('load',  read, () => resolve(null), { once: true });
      img.addEventListener('error', () => resolve(null), { once: true });
      return;
    }

    img.onload  = read;
    img.onerror = () => resolve(null);
    img.src     = source;
  });
}

function getDefaultFaviconSignature() {
  if (!defaultFaviconSig) {
    defaultFaviconSig = faviconSignature(faviconUrlFor(DEFAULT_FAVICON_PROBE, 32));
  }
  return defaultFaviconSig;
}

/**
 * dropIfDefaultFavicon(img) — _favicon 给的是默认占位图时，删掉它，
 * 让底下的首字母色块露出来。onerror 那条路走不到这种情况（见上）。
 */
async function dropIfDefaultFavicon(img) {
  const [sig, def] = await Promise.all([
    faviconSignature(img),
    getDefaultFaviconSignature(),
  ]);
  if (!sig || !def || sig !== def) return;
  if (img.isConnected === false) return;   // 这中间已经被 onerror 删掉了
  img.remove();
}

/** escapeAttr(str) — 塞进 HTML 属性/文本前的转义。topSites 的标题来自任意网页，必须转 */
function escapeAttr(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function getPinnedSites() {
  const { pinnedSites = [] } = await chrome.storage.local.get(PINNED_SITES_KEY);
  return Array.isArray(pinnedSites) ? pinnedSites : [];
}

async function getHiddenTopSiteKeys() {
  const { hiddenTopSites = [] } = await chrome.storage.local.get(HIDDEN_TOP_SITES_KEY);
  return Array.isArray(hiddenTopSites) ? hiddenTopSites : [];
}

/**
 * pinSite({url, title, icon}) — 手动钉住一个入口
 *
 * @returns {Promise<{ok: boolean, reason?: 'bad-url'|'duplicate'}>}
 */
async function pinSite({ url, title, icon } = {}) {
  const href = normalizeSiteUrl(url);
  if (!href) return { ok: false, reason: 'bad-url' };

  const pinned = await getPinnedSites();

  // 去重按「入口」而不是按 hostname。按 hostname 去重会把同站的具体页面全部挡掉：
  // 钉了 github.com 之后 github.com/features/actions 就再也钉不上来了（用户实测报过）。
  // 官网和它的某个具体页面是两个不同的入口，都该允许存在。
  if (pinned.some(s => sameEntryUrl(s.url, href))) return { ok: false, reason: 'duplicate' };

  pinned.push({
    url:     href,
    title:   (title || '').trim(),
    icon:    (icon || '').trim(),
    addedAt: new Date().toISOString(),
  });
  await chrome.storage.local.set({ [PINNED_SITES_KEY]: pinned });

  // 钉住等于「我想看见它」，所以顺手把该站从「不再显示」名单里放出来
  const key    = siteKey(href);
  const hidden = await getHiddenTopSiteKeys();
  if (hidden.includes(key)) {
    await chrome.storage.local.set({ [HIDDEN_TOP_SITES_KEY]: hidden.filter(k => k !== key) });
  }
  return { ok: true };
}

/**
 * unpinSite(url) — 取消钉住
 *
 * 同样按「入口」匹配：同时钉了 github.com 和 github.com/features/actions 时，
 * 点其中一个的 × 只该删掉那一个，不能按 hostname 把两个一起删了。
 */
async function unpinSite(url) {
  const pinned = await getPinnedSites();
  await chrome.storage.local.set({
    [PINNED_SITES_KEY]: pinned.filter(s => !sameEntryUrl(s.url, url)),
  });
}

/**
 * updatePinnedSite(originalUrl, {url, title, icon}) — 改一条已钉住的
 *
 * 就地改，**不移动数组位置** —— 用户改的是内容不是顺序，顺序由拖拽负责，
 * 改个名字就跳到末尾会很莫名其妙。
 *
 * @returns {Promise<{ok: boolean, reason?: 'bad-url'|'missing'|'duplicate'}>}
 */
async function updatePinnedSite(originalUrl, { url, title, icon } = {}) {
  const href = normalizeSiteUrl(url);
  if (!href) return { ok: false, reason: 'bad-url' };

  const pinned = await getPinnedSites();
  const idx    = pinned.findIndex(s => sameEntryUrl(s.url, originalUrl));
  if (idx === -1) return { ok: false, reason: 'missing' };

  // 改了链接之后可能跟别人撞上（自己除外）
  if (pinned.some((s, i) => i !== idx && sameEntryUrl(s.url, href))) {
    return { ok: false, reason: 'duplicate' };
  }

  pinned[idx] = {
    ...pinned[idx],
    url:   href,
    title: (title || '').trim(),
    icon:  (icon || '').trim(),
  };
  await chrome.storage.local.set({ [PINNED_SITES_KEY]: pinned });

  // 换了个站点之后，新站如果原本在「不再显示」名单里，得放出来
  const key    = siteKey(href);
  const hidden = await getHiddenTopSiteKeys();
  if (hidden.includes(key)) {
    await chrome.storage.local.set({ [HIDDEN_TOP_SITES_KEY]: hidden.filter(k => k !== key) });
  }
  return { ok: true };
}

/**
 * movePinnedSite(fromUrl, targetUrl, after) — 拖拽重排
 *
 * 只动 pinnedSites 数组的顺序；每一项的 title / icon / addedAt 原样保留。
 * 拖到某个自动补的站点上时，targetUrl 在 pinnedSites 里找不到，插入位置自然
 * 落到末尾 —— 也就是「钉住的都在前、自动的都在后」这条规则。
 *
 * @returns {Promise<boolean>} 顺序是否真的变了
 */
async function movePinnedSite(fromUrl, targetUrl, after) {
  const pinned = await getPinnedSites();
  const order  = pinned.map(s => s.url);

  const fromIdx = order.findIndex(u => sameEntryUrl(u, fromUrl));
  if (fromIdx === -1) return false;

  const [moved] = order.splice(fromIdx, 1);

  let insertAt = order.length;   // 默认落到钉住区末尾
  if (targetUrl) {
    const tIdx = order.findIndex(u => sameEntryUrl(u, targetUrl));
    if (tIdx !== -1) insertAt = after ? tIdx + 1 : tIdx;
  }
  order.splice(insertAt, 0, moved);

  if (order.every((u, i) => u === pinned[i].url)) return false;   // 位置没变，别白写一次

  const next = order.map(u => pinned.find(s => s.url === u)).filter(Boolean);
  await chrome.storage.local.set({ [PINNED_SITES_KEY]: next });
  return true;
}

/**
 * promoteTopSite(url) — 把自动补的站点钉下来（顺序追加到末尾）
 * 钉完之后它就能拖了。
 */
async function promoteTopSite(url) {
  const href = normalizeSiteUrl(url);
  if (!href) return { ok: false, reason: 'bad-url' };

  const pinned = await getPinnedSites();
  if (pinned.some(s => sameEntryUrl(s.url, href))) return { ok: false, reason: 'duplicate' };

  // 名称沿用当前显示的，图标留空（继续吃站点 favicon）
  const shown = (await getQuickSites()).find(s => sameEntryUrl(s.url, href));

  pinned.push({
    url:     href,
    title:   shown ? shown.title : '',
    icon:    shown ? shown.icon : '',
    addedAt: new Date().toISOString(),
  });
  await chrome.storage.local.set({ [PINNED_SITES_KEY]: pinned });
  return { ok: true };
}

async function hideTopSite(url) {
  const key = siteKey(url);
  if (!key) return;
  const hidden = await getHiddenTopSiteKeys();
  if (!hidden.includes(key)) {
    hidden.push(key);
    await chrome.storage.local.set({ [HIDDEN_TOP_SITES_KEY]: hidden });
  }
}

/**
 * getQuickSites() — 拼出站点条要显示的全部站点
 * 手动钉住的在前（顺序就是用户钉的顺序），自动部分按 topSites 的热度顺序补足。
 */
async function getQuickSites() {
  const [pinned, hiddenKeys] = await Promise.all([getPinnedSites(), getHiddenTopSiteKeys()]);

  const seenEntries = new Set();   // 已显示的入口 URL，防手动钉重
  const seenKeys    = new Set();   // 已显示的站点 hostname，防自动部分重复补
  const sites       = [];

  for (const s of pinned) {
    const href = normalizeSiteUrl(s.url);
    if (!href || seenEntries.has(href)) continue;   // 存量数据可能有重复，渲染时挡一道
    seenEntries.add(href);
    seenKeys.add(siteKey(href));
    sites.push({ url: href, title: s.title, icon: s.icon || '', pinned: true });
  }

  let top = [];
  try {
    top = (await chrome.topSites.get()) || [];
  } catch (err) {
    // 没授予 topSites 权限 / API 不可用 —— 降级成「只显示手动钉住的」，不要报错吓人
    console.warn('[guilong] 读不到 topSites，只显示手动钉住的站点:', err);
    top = [];
  }

  let autoAdded = 0;
  for (const item of top) {
    if (autoAdded >= MAX_AUTO_SITES) break;

    // topSites 给的可能是深链（github.com/someone/repo、某个视频页）。
    // 这一行图标底下写的是站点名，所以削成入口，让「标签」和「点下去到哪」
    // 对得上。用户想要深链的话自己钉一个就是了，钉住的不会被削。
    const url = originOf(item && item.url);
    if (!url) continue;

    const key = siteKey(url);
    if (!key || seenKeys.has(key) || hiddenKeys.includes(key)) continue;

    seenKeys.add(key);
    autoAdded += 1;
    sites.push({ url, title: item.title || '', icon: '', pinned: false });
  }

  return sites;
}


/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

/**
 * playCloseSound()
 *
 * Plays a clean "swoosh" sound when tabs are closed.
 * Built entirely with the Web Audio API — no sound files needed.
 * A filtered noise sweep that descends in pitch, like air moving.
 */
function playCloseSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;

    // Swoosh: shaped white noise through a sweeping bandpass filter
    const duration = 0.25;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // Generate noise with a natural envelope (quick attack, smooth decay)
    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      // Envelope: ramps up fast in first 10%, then fades out smoothly
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Bandpass filter sweeps from high to low — creates the "swoosh" character
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    // Volume
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);

    setTimeout(() => ctx.close(), 500);
  } catch {
    // Audio not supported — fail silently
  }
}

/**
 * shootConfetti(x, y)
 *
 * Shoots a burst of colorful confetti particles from the given screen
 * coordinates (typically the center of a card being closed).
 * Pure CSS + JS, no libraries.
 */
function shootConfetti(x, y) {
  const colors = [
    '#c8713a', // amber
    '#e8a070', // amber light
    '#5a7a62', // sage
    '#8aaa92', // sage light
    '#5a6b7a', // slate
    '#8a9baa', // slate light
    '#d4b896', // warm paper
    '#b35a5a', // rose
  ];

  const particleCount = 17;

  for (let i = 0; i < particleCount; i++) {
    const el = document.createElement('div');

    const isCircle = Math.random() > 0.5;
    const size = 5 + Math.random() * 6; // 5–11px
    const color = colors[Math.floor(Math.random() * colors.length)];

    el.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${isCircle ? '50%' : '2px'};
      pointer-events: none;
      z-index: 9999;
      transform: translate(-50%, -50%);
      opacity: 1;
    `;
    document.body.appendChild(el);

    // Physics: random angle and speed for the outward burst
    const angle   = Math.random() * Math.PI * 2;
    const speed   = 60 + Math.random() * 120;
    const vx      = Math.cos(angle) * speed;
    const vy      = Math.sin(angle) * speed - 80; // bias upward
    const gravity = 200;

    const startTime = performance.now();
    const duration  = 700 + Math.random() * 200; // 700–900ms

    function frame(now) {
      const elapsed  = (now - startTime) / 1000;
      const progress = elapsed / (duration / 1000);

      if (progress >= 1) { el.remove(); return; }

      const px = vx * elapsed;
      const py = vy * elapsed + 0.5 * gravity * elapsed * elapsed;
      const opacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;
      const rotate  = elapsed * 200 * (isCircle ? 0 : 1);

      el.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px)) rotate(${rotate}deg)`;
      el.style.opacity = opacity;

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }
}

/**
 * animateCardOut(card)
 *
 * Smoothly removes a mission card: fade + scale down, then confetti.
 * After the animation, checks if the grid is now empty.
 */
function animateCardOut(card) {
  if (!card) return;

  const rect = card.getBoundingClientRect();
  shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);

  card.classList.add('closing');
  setTimeout(() => {
    card.remove();
    checkAndShowEmptyState();
  }, 300);
}

/**
 * showToast(message)
 *
 * Brief pop-up notification at the bottom of the screen.
 */
function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toastText').textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 2500);
}

/**
 * checkAndShowEmptyState()
 *
 * Shows a cheerful "Inbox zero" message when all domain cards are gone.
 */
function checkAndShowEmptyState() {
  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;

  const remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
  if (remaining > 0) return;

  missionsEl.innerHTML = `
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">Inbox zero, but for tabs.</div>
      <div class="empty-subtitle">You're free.</div>
    </div>
  `;

  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.textContent = '0 domains';
}

/**
 * timeAgo(dateStr)
 *
 * Converts an ISO date string into a human-friendly relative time.
 * "2026-04-04T10:00:00Z" → "2 hrs ago" or "yesterday"
 */
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const then = new Date(dateStr);
  const now  = new Date();
  const diffMins  = Math.floor((now - then) / 60000);
  const diffHours = Math.floor((now - then) / 3600000);
  const diffDays  = Math.floor((now - then) / 86400000);

  if (diffMins < 1)   return T('time.justNow');
  if (diffMins < 60)  return T('time.minutesAgo', { n: diffMins });
  if (diffHours < 24) return Tn('time.hourAgo', 'time.hoursAgo', diffHours);
  if (diffDays === 1) return T('time.yesterday');
  return T('time.daysAgo', { n: diffDays });
}

/**
 * getGreeting() — "Good morning / afternoon / evening"
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return T('greeting.morning');
  if (hour < 17) return T('greeting.afternoon');
  return T('greeting.evening');
}

/**
 * getDateDisplay() — "Friday, April 4, 2026"
 */
function getDateDisplay() {
  return new Date().toLocaleDateString(localeOf(), {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  });
}


/* ----------------------------------------------------------------
   DOMAIN & TITLE CLEANUP HELPERS
   ---------------------------------------------------------------- */

// Map of known hostnames → friendly display names.
const FRIENDLY_DOMAINS = {
  'github.com':           'GitHub',
  'www.github.com':       'GitHub',
  'gist.github.com':      'GitHub Gist',
  'youtube.com':          'YouTube',
  'www.youtube.com':      'YouTube',
  'music.youtube.com':    'YouTube Music',
  'x.com':                'X',
  'www.x.com':            'X',
  'twitter.com':          'X',
  'www.twitter.com':      'X',
  'reddit.com':           'Reddit',
  'www.reddit.com':       'Reddit',
  'old.reddit.com':       'Reddit',
  'substack.com':         'Substack',
  'www.substack.com':     'Substack',
  'medium.com':           'Medium',
  'www.medium.com':       'Medium',
  'linkedin.com':         'LinkedIn',
  'www.linkedin.com':     'LinkedIn',
  'stackoverflow.com':    'Stack Overflow',
  'www.stackoverflow.com':'Stack Overflow',
  'news.ycombinator.com': 'Hacker News',
  'google.com':           'Google',
  'www.google.com':       'Google',
  'mail.google.com':      'Gmail',
  'docs.google.com':      'Google Docs',
  'drive.google.com':     'Google Drive',
  'calendar.google.com':  'Google Calendar',
  'meet.google.com':      'Google Meet',
  'gemini.google.com':    'Gemini',
  'chatgpt.com':          'ChatGPT',
  'www.chatgpt.com':      'ChatGPT',
  'chat.openai.com':      'ChatGPT',
  'claude.ai':            'Claude',
  'www.claude.ai':        'Claude',
  'code.claude.com':      'Claude Code',
  'notion.so':            'Notion',
  'www.notion.so':        'Notion',
  'figma.com':            'Figma',
  'www.figma.com':        'Figma',
  'slack.com':            'Slack',
  'app.slack.com':        'Slack',
  'discord.com':          'Discord',
  'www.discord.com':      'Discord',
  'wikipedia.org':        'Wikipedia',
  'en.wikipedia.org':     'Wikipedia',
  'amazon.com':           'Amazon',
  'www.amazon.com':       'Amazon',
  'netflix.com':          'Netflix',
  'www.netflix.com':      'Netflix',
  'spotify.com':          'Spotify',
  'open.spotify.com':     'Spotify',
  'vercel.com':           'Vercel',
  'www.vercel.com':       'Vercel',
  'npmjs.com':            'npm',
  'www.npmjs.com':        'npm',
  'developer.mozilla.org':'MDN',
  'arxiv.org':            'arXiv',
  'www.arxiv.org':        'arXiv',
  'huggingface.co':       'Hugging Face',
  'www.huggingface.co':   'Hugging Face',
  'producthunt.com':      'Product Hunt',
  'www.producthunt.com':  'Product Hunt',

  // ---- 中文站点 ----
  // 这些站点的子域由下面的 SITE_MERGE_RULES 归并成一张卡，
  // 所以主域名的显示名在这里定义一次就够了。
  'bilibili.com':         'B站',
  'zhihu.com':            '知乎',
  'weibo.com':            '微博',
  'douban.com':           '豆瓣',
  'juejin.cn':            '掘金',
  'sspai.com':            '少数派',
  'csdn.net':             'CSDN',
  '36kr.com':             '36氪',
  'jianshu.com':          '简书',
  'taobao.com':           '淘宝',
  'jd.com':               '京东',
  'baidu.com':            '百度',
  'tieba.baidu.com':      '百度贴吧',
  'pan.baidu.com':        '百度网盘',
  'music.163.com':        '网易云音乐',
  'y.qq.com':             'QQ音乐',
  'weread.qq.com':        '微信读书',
  'mp.weixin.qq.com':     '公众号后台',
  'docs.qq.com':          '腾讯文档',
  'xiaohongshu.com':      '小红书',
  'www.xiaohongshu.com':  '小红书',

  // 这一条和上面那些不一样：它不是某个网站的名字，是 file:// 那批标签页的归类名，
  // 属于**界面文案**而不是对照数据，所以跟着语言走。
  // 上面 'B站' / 'GitHub' 那些是网站自己的名字，不翻译，也不进文案表。
  'local-files':          T('section.localFiles'),
};

function friendlyDomain(hostname) {
  if (!hostname) return '';
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

  if (hostname.endsWith('.substack.com') && hostname !== 'substack.com') {
    return capitalize(hostname.replace('.substack.com', '')) + "'s Substack";
  }
  if (hostname.endsWith('.github.io')) {
    return capitalize(hostname.replace('.github.io', '')) + ' (GitHub Pages)';
  }

  // 注意：长后缀必须排在短后缀前面，否则 juejin.com.cn 会只被剥掉 .cn，
  // 剩下的 "juejin.com" 会被拆成 "Juejin Com"。原来的列表还缺 .cn，
  // 导致所有中文站显示成 "Juejin Cn" 这种观感。
  let clean = hostname
    .replace(/^www\./, '')
    .replace(/\.(com\.cn|net\.cn|org\.cn|gov\.cn|co\.uk|co\.jp|com|org|net|io|co|ai|dev|app|so|me|xyz|info|tech|site|shop|club|live|cloud|top|vip|fun|cc|tv|us|uk|cn)$/, '');

  return clean.split('.').map(part => capitalize(part)).join(' ');
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * SITE_MERGE_RULES — 把同一站点的不同子域归并成一张卡片
 *
 * 为什么需要：分组是按 hostname 做的，所以 www.bilibili.com 和
 * search.bilibili.com 会变成两张卡，内容却属于同一个站点。
 *
 * 匹配用最长后缀（hostnameEndsWith），所以一条 '.bilibili.com'
 * 就覆盖 www / search / space / t / message / live 全部子域。
 * 显示名走 FRIENDLY_DOMAINS[groupKey]，也就是上面定义的「B站」。
 *
 * 想加自己的规则不用改这个文件：写进 config.local.js 的
 * LOCAL_CUSTOM_GROUPS 即可，那里优先级更高，能覆盖这里的规则。
 */
const SITE_MERGE_RULES = [
  { hostnameEndsWith: '.bilibili.com',     groupKey: 'bilibili.com'    },
  { hostnameEndsWith: '.zhihu.com',        groupKey: 'zhihu.com'       },
  { hostnameEndsWith: '.weibo.com',        groupKey: 'weibo.com'       },
  { hostnameEndsWith: '.douban.com',       groupKey: 'douban.com'      },
  { hostnameEndsWith: '.juejin.cn',        groupKey: 'juejin.cn'       },
  { hostnameEndsWith: '.sspai.com',        groupKey: 'sspai.com'       },
  { hostnameEndsWith: '.csdn.net',         groupKey: 'csdn.net'        },
  { hostnameEndsWith: '.36kr.com',         groupKey: '36kr.com'        },
  { hostnameEndsWith: '.jianshu.com',      groupKey: 'jianshu.com'     },
  { hostnameEndsWith: '.taobao.com',       groupKey: 'taobao.com'      },
  { hostnameEndsWith: '.jd.com',           groupKey: 'jd.com'          },
  { hostnameEndsWith: '.xiaohongshu.com',  groupKey: 'xiaohongshu.com' },
];

/**
 * matchSiteMerge(url) — 命中归并规则时返回规则本身，否则返回 null
 */
function matchSiteMerge(url) {
  let hostname;
  try { hostname = new URL(url).hostname; }
  catch { return null; }

  return SITE_MERGE_RULES.find(r =>
    r.hostname
      ? hostname === r.hostname
      // 裸主域（bilibili.com）本身也要命中，不能只匹配 '.bilibili.com'
      : hostname === r.hostnameEndsWith.slice(1) ||
        hostname.endsWith(r.hostnameEndsWith)
  ) || null;
}

function stripTitleNoise(title) {
  if (!title) return '';
  // Strip leading notification count: "(2) Title"
  title = title.replace(/^\(\d+\+?\)\s*/, '');
  // Strip inline counts like "Inbox (16,359)"
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, ' ');
  // Strip email addresses (privacy + cleaner display)
  title = title.replace(/\s*[\-\u2010-\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  title = title.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  // Clean X/Twitter format
  title = title.replace(/\s+on X:\s*/, ': ');
  title = title.replace(/\s*\/\s*X\s*$/, '');
  return title.trim();
}

function cleanTitle(title, hostname) {
  if (!title || !hostname) return title || '';

  const friendly = friendlyDomain(hostname);
  const domain   = hostname.replace(/^www\./, '');
  const seps     = [' - ', ' | ', ' — ', ' · ', ' – '];

  for (const sep of seps) {
    const idx = title.lastIndexOf(sep);
    if (idx === -1) continue;
    const suffix     = title.slice(idx + sep.length).trim();
    const suffixLow  = suffix.toLowerCase();
    if (
      suffixLow === domain.toLowerCase() ||
      suffixLow === friendly.toLowerCase() ||
      suffixLow === domain.replace(/\.\w+$/, '').toLowerCase() ||
      domain.toLowerCase().includes(suffixLow) ||
      friendly.toLowerCase().includes(suffixLow)
    ) {
      const cleaned = title.slice(0, idx).trim();
      if (cleaned.length >= 5) return cleaned;
    }
  }
  return title;
}

function smartTitle(title, url) {
  if (!url) return title || '';
  let pathname = '', hostname = '';
  try { const u = new URL(url); pathname = u.pathname; hostname = u.hostname; }
  catch { return title || ''; }

  const titleIsUrl = !title || title === url || title.startsWith(hostname) || title.startsWith('http');

  if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.x.com') && pathname.includes('/status/')) {
    const username = pathname.split('/')[1];
    if (username) return titleIsUrl ? `Post by @${username}` : title;
  }

  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const [owner, repo, ...rest] = parts;
      if (rest[0] === 'issues' && rest[1]) return `${owner}/${repo} Issue #${rest[1]}`;
      if (rest[0] === 'pull'   && rest[1]) return `${owner}/${repo} PR #${rest[1]}`;
      if (rest[0] === 'blob' || rest[0] === 'tree') return `${owner}/${repo} — ${rest.slice(2).join('/')}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }

  if ((hostname === 'www.youtube.com' || hostname === 'youtube.com') && pathname === '/watch') {
    if (titleIsUrl) return 'YouTube Video';
  }

  if ((hostname === 'www.reddit.com' || hostname === 'reddit.com' || hostname === 'old.reddit.com') && pathname.includes('/comments/')) {
    const parts  = pathname.split('/').filter(Boolean);
    const subIdx = parts.indexOf('r');
    if (subIdx !== -1 && parts[subIdx + 1]) {
      if (titleIsUrl) return `r/${parts[subIdx + 1]} post`;
    }
  }

  return title || url;
}


/* ----------------------------------------------------------------
   SVG ICON STRINGS
   ---------------------------------------------------------------- */
const ICONS = {
  tabs:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,
  close:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,
  focus:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>`,
  // 「存入待办」—— 收件箱箭头朝下，比 focus 那个朝右上角的箭头贴题
  save:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9 3.75H6.912a2.25 2.25 0 0 0-2.15 1.588L2.35 13.177a2.25 2.25 0 0 0-.1.661V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 0 0-2.15-1.588H15M2.25 13.5h3.86a2.25 2.25 0 0 1 2.012 1.244l.256.512a2.25 2.25 0 0 0 2.013 1.244h3.218a2.25 2.25 0 0 0 2.013-1.244l.256-.512a2.25 2.25 0 0 1 2.013-1.244h3.859M12 3v8.25m0 0-3-3m3 3 3-3" /></svg>`,
  plus:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>`,
  // 「钉住」用书签，比地图图钉更贴近「收进自己的收藏」
  pin:     `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>`,
  edit:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10" /></svg>`,
};


/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB GROUPS
   ---------------------------------------------------------------- */
let domainGroups = [];


/* ----------------------------------------------------------------
   HELPER: filter out browser-internal pages
   ---------------------------------------------------------------- */

/**
 * getRealTabs()
 *
 * Returns tabs that are real web pages — no chrome://, extension
 * pages, about:blank, etc.
 */
function getRealTabs() {
  return openTabs.filter(t => {
    const url = t.url || '';
    return (
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });
}

/**
 * checkTabOutDupes()
 *
 * Counts how many Guilong pages are open. If more than 1,
 * shows a banner offering to close the extras.
 */
function checkTabOutDupes() {
  const tabOutTabs = openTabs.filter(t => t.isTabOut);
  const banner  = document.getElementById('tabOutDupeBanner');
  const textEl  = document.getElementById('tabOutDupeText');
  if (!banner) return;

  if (tabOutTabs.length > 1) {
    // 整句都从文案表来：中文和英文的语序不同，数字在句里的位置也不同，
    // 所以不能只换数字、留着外面的英文壳子。数字由 {count} 套进 <strong>。
    if (textEl) textEl.innerHTML = T('dupeBanner.text', { count: tabOutTabs.length });
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}


/* ----------------------------------------------------------------
   OVERFLOW CHIPS ("+N more" expand button in domain cards)
   ---------------------------------------------------------------- */

function buildOverflowChips(hiddenTabs, urlCounts = {}) {
  const hiddenChips = hiddenTabs.map(tab => {
    const label    = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), '');
    const count    = urlCounts[tab.url] || 1;
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" data-favicon>` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="${T('action.saveForLater')}">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="${T('action.closeThisTab')}">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  return `
    <div class="page-chips-overflow" style="display:none">${hiddenChips}</div>
    <div class="page-chip page-chip-overflow clickable" data-action="expand-chips">
      <span class="chip-text">${T('badge.more', { n: hiddenTabs.length })}</span>
    </div>`;
}


/* ----------------------------------------------------------------
   DOMAIN CARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderDomainCard(group, groupIndex)
 *
 * Builds the HTML for one domain group card.
 * group = { domain: string, tabs: [{ url, title, id, windowId, active }] }
 */
function renderDomainCard(group) {
  const tabs      = group.tabs || [];
  const tabCount  = tabs.length;
  const isLanding = group.domain === '__landing-pages__';
  const stableId  = 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-');

  // Count duplicates (exact URL match)
  const urlCounts = {};
  for (const tab of tabs) urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  const dupeUrls   = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const hasDupes   = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((s, [, c]) => s + c - 1, 0);

  const tabBadge = `<span class="open-tabs-badge">
    ${ICONS.tabs}
    ${Tn('badge.tabOpen', 'badge.tabsOpen', tabCount)}
  </span>`;

  // data-badge="dupes" 是给「关掉重复之后把这个徽章淡出」那段用的。
  // 那里原来是靠 badge.textContent.includes('duplicate') 认的 —— **拿文案做逻辑判断，
  // 文案一翻译就失效**，所以改成认结构（属性）。以后凡是这种地方都要这么改。
  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge" data-badge="dupes" style="color:var(--accent-amber);background:rgba(200,113,58,0.08);">
        ${Tn('badge.duplicate', 'badge.duplicates', totalExtras)}
      </span>`
    : '';

  // Deduplicate for display: show each URL once, with (Nx) badge if duped
  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) { seen.add(tab.url); uniqueTabs.push(tab); }
  }

  const visibleTabs = uniqueTabs.slice(0, 8);
  const extraCount  = uniqueTabs.length - visibleTabs.length;

  const pageChips = visibleTabs.map(tab => {
    let label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), group.domain);
    // For localhost tabs, prepend port number so you can tell projects apart
    try {
      const parsed = new URL(tab.url);
      if (parsed.hostname === 'localhost' && parsed.port) label = `${parsed.port} ${label}`;
    } catch {}
    const count    = urlCounts[tab.url];
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" data-favicon>` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="${T('action.saveForLater')}">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="${T('action.closeThisTab')}">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('') + (extraCount > 0 ? buildOverflowChips(uniqueTabs.slice(8), urlCounts) : '');

  let actionsHtml = `
    <button class="action-btn close-tabs" data-action="close-domain-tabs" data-domain-id="${stableId}">
      ${ICONS.close}
      ${Tn('action.closeAllTabsOne', 'action.closeAllTabs', tabCount)}
    </button>`;

  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
        ${T('action.closeDupes', { n: totalExtras })}
      </button>`;
  }

  return `
    <div class="mission-card domain-card ${hasDupes ? 'has-amber-bar' : 'has-neutral-bar'}" data-domain-id="${stableId}">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${isLanding ? T('section.homepages') : (group.label || friendlyDomain(group.domain))}</span>
          ${tabBadge}
          ${dupeBadge}
        </div>
        <div class="mission-pages">${pageChips}</div>
        <div class="actions">${actionsHtml}</div>
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">${T('badge.tabsUnit')}</div>
      </div>
    </div>`;
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — Render Checklist Column
   ---------------------------------------------------------------- */

/**
 * renderDeferredColumn()
 *
 * Reads saved tabs from chrome.storage.local and renders the right-side
 * "Saved for Later" checklist column. Shows active items as a checklist
 * and completed items in a collapsible archive.
 */
async function renderDeferredColumn() {
  const column         = document.getElementById('deferredColumn');
  const list           = document.getElementById('deferredList');
  const empty          = document.getElementById('deferredEmpty');
  const countEl        = document.getElementById('deferredCount');
  const archiveEl      = document.getElementById('deferredArchive');
  const archiveCountEl = document.getElementById('archiveCount');
  const archiveList    = document.getElementById('archiveList');
  const actionsEl      = document.getElementById('deferredActions');

  if (!column) return;

  try {
    const { active, archived } = await getSavedTabs();

    // Hide the entire column if there's nothing to show
    if (active.length === 0 && archived.length === 0) {
      column.style.display = 'none';
      return;
    }

    column.style.display = 'block';

    // Render active checklist items
    if (active.length > 0) {
      countEl.textContent = Tn('deferred.itemOne', 'deferred.items', active.length);
      list.innerHTML = active.map(item => renderDeferredItem(item)).join('');
      wireFaviconFallbacks(list);
      list.style.display = 'block';
      empty.style.display = 'none';
    } else {
      list.style.display = 'none';
      countEl.textContent = '';
      empty.style.display = 'block';
    }

    // 批量操作按钮 —— 只在有未打勾条目时出现
    if (actionsEl) {
      if (active.length > 0) {
        actionsEl.innerHTML = `
          <button class="action-btn save-tabs" data-action="open-all-saved">
            ${ICONS.tabs} ${T('deferred.openAll', { n: active.length })}
          </button>`;
        actionsEl.style.display = 'flex';
      } else {
        actionsEl.innerHTML = '';
        actionsEl.style.display = 'none';
      }
    }

    // Render archive section
    if (archived.length > 0) {
      archiveCountEl.textContent = `(${archived.length})`;
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      archiveEl.style.display = 'block';
    } else {
      archiveEl.style.display = 'none';
    }

  } catch (err) {
    console.warn('[guilong] Could not load saved tabs:', err);
    column.style.display = 'none';
  }
}

/**
 * renderDeferredItem(item)
 *
 * Builds HTML for one active checklist item: checkbox, title link,
 * domain, time ago, dismiss button.
 */
function renderDeferredItem(item) {
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
  const ago = timeAgo(item.savedAt);

  return `
    <div class="deferred-item" data-deferred-id="${item.id}">
      <input type="checkbox" class="deferred-checkbox" data-action="check-deferred" data-deferred-id="${item.id}">
      <div class="deferred-info">
        <a href="${item.url}" target="_blank" rel="noopener" class="deferred-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
          <img src="${faviconUrl}" alt="" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px" data-favicon>${item.title || item.url}
        </a>
        <div class="deferred-meta">
          <span>${domain}</span>
          <span>${ago}</span>
        </div>
      </div>
      <button class="deferred-dismiss" data-action="dismiss-deferred" data-deferred-id="${item.id}" title="${T('deferred.dismiss')}">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}

/**
 * renderArchiveItem(item)
 *
 * Builds HTML for one completed/archived item (simpler: just title + date).
 */
function renderArchiveItem(item) {
  const ago = item.completedAt ? timeAgo(item.completedAt) : timeAgo(item.savedAt);
  return `
    <div class="archive-item">
      <a href="${item.url}" target="_blank" rel="noopener" class="archive-item-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
        ${item.title || item.url}
      </a>
      <span class="archive-item-date">${ago}</span>
      <button class="archive-delete" data-action="delete-archived" data-deferred-id="${item.id}" title="${T('archive.delete')}">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}


/* ----------------------------------------------------------------
   QUICK SITES — 常用站点条

   一行图标 + 名字，点击就到。顺序：手动钉住的在前，topSites 自动补足。
   每个图标右上角有个 ×，hover 才出现：手动钉的取消钉住，自动的加进隐藏名单。
   ---------------------------------------------------------------- */

/**
 * renderQuickSites()
 *
 * 把站点条整个重画一遍。挂在 init 和每次钉住/移除之后 ——
 * 打开/关闭标签页不影响这一条，所以不用跟着仪表盘一起重画。
 */
async function renderQuickSites() {
  const listEl = document.getElementById('quickSitesList');
  if (!listEl) return;

  // 开关关掉时直接不渲染，连 topSites 都不用去查。
  // 注意只是不画，pinnedSites 一条都没动 —— 打开开关就原样回来。
  const { showQuickSites } = await getUiPrefs();
  if (!showQuickSites) return;

  let sites = [];
  try {
    sites = await getQuickSites();
  } catch (err) {
    console.warn('[guilong] 常用站点渲染失败:', err);
  }

  const addTile = `
    <button class="quick-site-add" data-action="toggle-pin-input" title="${T('pin.addTitle')}">
      ${ICONS.plus}
      <span class="quick-site-add-label">${T('pin.add')}</span>
    </button>`;

  if (sites.length === 0) {
    listEl.innerHTML =
      `<span class="quick-sites-hint">${T('pin.hintEmpty')}</span>` + addTile;
    return;
  }

  listEl.innerHTML = sites.map(s => renderQuickSite(s)).join('') + addTile;
  wireFaviconFallbacks(listEl);
}

/**
 * renderQuickSite(site) — 一个站点图标
 *
 * 图标底下垫一层首字母色块，favicon 两条路都读不到时会露出来，
 * 不会出现「破图」那种观感。
 */
function renderQuickSite(site) {
  const label     = siteLabel(site);
  const { img, letter, host } = resolveSiteIcon(site, label);
  const safeLabel = escapeAttr(label);
  const safeUrl   = escapeAttr(site.url);

  // 只有手动钉住的能拖：整行的顺序就是 pinnedSites 数组的顺序，
  // 自动补的那些来自 Chrome 的历史热度，用户没「拥有」它们，顺序也就不该由拖拽决定。
  //
  // 属性同时挂在外层 .quick-site 和里层 .quick-site-open 上：抓手区域基本被这个
  // 大按钮盖满，而浏览器在 <button> 上按下时不一定愿意往上找可拖拽的祖先。
  // 里层自己声明了 draggable，无论浏览器走不走那条「向上查找」，拖拽都能起来；
  // dragstart 冒泡到 document，处理器再 closest('.quick-site') 取回整张卡片。
  const dragAttrs = site.pinned ? ' draggable="true"' : '';

  // 同一个位置按类型放不同的第一个按钮：钉住的给「编辑」，自动的给「钉住」
  // （自动项没有可编辑的东西，而用户想让它留在这一行就得先钉下来）。
  const primaryBtn = site.pinned
    ? `<button class="quick-site-tool" data-action="edit-pinned-site"
               data-site-url="${safeUrl}" title="${T('pin.editTitle')}">${ICONS.edit}</button>`
    : `<button class="quick-site-tool" data-action="pin-auto-site"
               data-site-url="${safeUrl}" title="${T('pin.pinTitle')}">${ICONS.pin}</button>`;

  return `
    <div class="quick-site" data-site-url="${safeUrl}"${dragAttrs}>
      <button class="quick-site-open" data-action="open-quick-site"
              data-site-url="${safeUrl}"${dragAttrs}
              title="${escapeAttr(T('pin.openTooltip', { label, url: site.url }))}">
        <span class="quick-site-icon">
          <span class="quick-site-letter${letter.length > 1 ? ' is-text' : ''}">${escapeAttr(letter)}</span>
          ${img ? `<img src="${escapeAttr(img)}" data-favicon${host ? ` data-host="${escapeAttr(host)}"` : ''} alt="">` : ''}
        </span>
        <span class="quick-site-label">${safeLabel}</span>
      </button>
      ${primaryBtn}
      <button class="quick-site-tool quick-site-remove" data-action="remove-quick-site"
              data-site-url="${safeUrl}"
              data-site-pinned="${site.pinned ? '1' : '0'}"
              title="${site.pinned ? T('pin.unpinTitle') : T('pin.hideTitle')}">
        ${ICONS.close}
      </button>
    </div>`;
}

/**
 * openQuickSite(url) — 站点条点击 = 永远新开一个标签页
 *
 * **不要**在这里做「已经开着这个入口就切过去」。用户在站点条上点一个图标，
 * 意思是「我要去这个站」，不是「帮我把那个已经开着的页面找出来」。
 * 他之所以停在这个标签页上，就是因为这里是个落脚点；把它替掉、或者被丢去
 * 一个早就忘了内容的页面，都不是他要的。要复用已开的页面，Chrome 的
 * 地址栏和标签栏本来就能干这件事。
 *
 * 这也顺带绕开了之前那个坑：早先按 hostname 找「已开的该站标签页」，
 * 会把该站某个视频页 / 仓库页当成入口切过去。按 hostname 匹配是
 * 「关闭该站全部标签页」那类批量操作的语义，不能用在「去入口」上。
 */
async function openQuickSite(url) {
  if (!url) return 'none';
  await chrome.tabs.create({ url });
  return 'opened';
}


/* ---------------- 钉住表单 ----------------
   三个字段：链接 / 名称 / 图标。
   填入链接后自动抓名称和图标填进去，用户想改随时改。
   「链接」变了才会重新抓，用户手改过的字段不被覆盖 —— 改一半被后台抓取冲掉
   会很想打人。
   ------------------------------------------ */

let pinSuggestTimer = null;

function resetPinForm() {
  ['quickSiteInput', 'pinNameInput', 'pinIconInput'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = '';
    delete el.dataset.touched;   // 清掉「用户改过」标记，下一个链接重新抓
  });
  const form = document.getElementById('quickSiteForm');
  if (form) delete form.dataset.editingUrl;
  setPinHint('');
  renderPinIconPreview();
}

/**
 * openPinForm(entry)
 *
 * entry 省略 = 新增一个钉住；给了就是编辑那一张已经钉住的卡片。
 * 两种模式共用同一个表单，靠 form.dataset.editingUrl 区分：
 * 有值说明在编辑，提交时走 updatePinnedSite 而不是 pinSite。
 */
function openPinForm(entry) {
  const form = document.getElementById('quickSiteForm');
  if (!form) return;

  resetPinForm();

  const btn      = document.getElementById('pinSubmitBtn');
  const titleEl  = document.getElementById('pinFormTitle');
  const nameEl   = document.getElementById('pinNameInput');

  if (entry) {
    form.dataset.editingUrl = entry.url;
    const urlEl = document.getElementById('quickSiteInput');
    if (urlEl) urlEl.value = entry.url;
    if (nameEl) {
      nameEl.value = entry.title || '';
      // 编辑时名称是既成事实，别让自动抓取把它冲掉
      nameEl.dataset.touched = '1';
    }
    const icoEl = document.getElementById('pinIconInput');
    if (icoEl) icoEl.value = entry.icon || '';

    if (btn)     btn.textContent     = T('pin.submitEdit');
    if (titleEl) titleEl.textContent = T('pin.formTitleEdit');

    // 名称和图标都是用户已有的内容，只提示链接可以改
    setPinHint(T('pin.hintEdit'));
  } else {
    if (btn)     btn.textContent     = T('pin.submitNew');
    if (titleEl) titleEl.textContent = T('pin.formTitleNew');
  }

  renderPinIconPreview();
  form.style.display = 'flex';

  if (!entry) {
    const urlEl = document.getElementById('quickSiteInput');
    if (urlEl) urlEl.focus();
  }
}

function closePinForm() {
  const form = document.getElementById('quickSiteForm');
  if (form) form.style.display = 'none';
  resetPinForm();
}

function setPinHint(text) {
  const el = document.getElementById('pinHint');
  if (el) el.textContent = text || '';
}

/** 图标预览 —— 把「图标」字段的值 + 当前链接解析成一个小方块，所见即所得 */
function renderPinIconPreview() {
  const box    = document.getElementById('pinIconPreview');
  if (!box) return;

  const urlEl  = document.getElementById('quickSiteInput');
  const icoEl  = document.getElementById('pinIconInput');
  const nameEl = document.getElementById('pinNameInput');

  const href  = urlEl  ? urlEl.value.trim()  : '';
  const raw   = icoEl  ? icoEl.value.trim()  : '';
  const label = nameEl ? nameEl.value.trim() : '';
  const first = ((label.match(/[A-Za-z0-9\u4e00-\u9fa5]/) || ['?'])[0]).toUpperCase();

  let img = '';
  let letter = first;

  if (/^https?:\/\//i.test(raw)) {
    img = raw;
  } else if (raw) {
    letter = raw.slice(0, 2);
  } else if (normalizeSiteUrl(href)) {
    // 只有链接能解析成合法站点时才去取 favicon，否则会发一个必然失败的请求
    img = faviconUrlFor(href, 32);
  }

  box.innerHTML =
    `<span class="quick-site-letter${letter.length > 1 ? ' is-text' : ''}">${escapeAttr(letter)}</span>` +
    (img ? `<img src="${escapeAttr(img)}" alt="">` : '');

  const imgEl = box.querySelector('img');
  if (imgEl) {
    imgEl.onerror = () => imgEl.remove();
    // 预览用的是同一套 favicon 来源，同样可能拿到 Chrome 那张默认地球图
    dropIfDefaultFavicon(imgEl);
  }
}

/**
 * applyPinSuggestion() — 链接字段变化后，抓一份建议的名称填进去
 *
 * 名称只在用户没手动改过时才覆盖。图标字段永远不自动填 ——
 * 它留空就代表「自动」，预览里已经显示了自动抓到的图标，填进去反而变成
 * 「强制用这张图」，之后站点换图标就跟不上了。
 */
async function applyPinSuggestion() {
  const urlEl  = document.getElementById('quickSiteInput');
  const nameEl = document.getElementById('pinNameInput');
  if (!urlEl || !nameEl) return;

  const raw  = urlEl.value.trim();
  if (!raw) {
    if (nameEl.dataset.touched !== '1') nameEl.value = '';
    setPinHint('');
    renderPinIconPreview();
    return;
  }

  const href = normalizeSiteUrl(raw);
  if (!href) {
    if (nameEl.dataset.touched !== '1') nameEl.value = '';
    setPinHint(T('pin.badUrl'));
    renderPinIconPreview();
    return;
  }

  // 这个函数由 setTimeout 调起，抛出去没人接，所以自己兜住
  let suggestion;
  try {
    suggestion = await suggestSiteName(href);
  } catch (err) {
    console.warn('[guilong] 自动抓取站点名称失败:', err);
    return;
  }

  if (nameEl.dataset.touched !== '1') nameEl.value = suggestion.name;
  renderPinIconPreview();

  setPinHint(
    suggestion.source === 'root'  ? T('pin.sourceRoot')
  : suggestion.source === 'tab'   ? T('pin.sourceTab')
  :                                 T('pin.sourcePage')
  );
}


/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderStaticDashboard()
 *
 * The main render function:
 * 1. Paints greeting + date
 * 2. Fetches open tabs via chrome.tabs.query()
 * 3. Groups tabs by domain (with landing pages pulled out to their own group)
 * 4. Renders domain cards
 * 5. Updates footer stats
 * 6. Renders the "Saved for Later" checklist
 */
async function renderStaticDashboard() {
  // --- Header ---
  const greetingEl = document.getElementById('greeting');
  const dateEl     = document.getElementById('dateDisplay');
  if (greetingEl) greetingEl.textContent = getGreeting();
  if (dateEl)     dateEl.textContent     = getDateDisplay();

  // --- Fetch tabs ---
  await fetchOpenTabs();
  const realTabs = getRealTabs();

  // --- Group tabs by domain ---
  // Landing pages (Gmail inbox, Twitter home, etc.) get their own special group
  // so they can be closed together without affecting content tabs on the same domain.
  const LANDING_PAGE_PATTERNS = [
    { hostname: 'mail.google.com', test: (p, h) =>
        !h.includes('#inbox/') && !h.includes('#sent/') && !h.includes('#search/') },
    { hostname: 'x.com',               pathExact: ['/home'] },
    { hostname: 'www.linkedin.com',    pathExact: ['/'] },
    { hostname: 'github.com',          pathExact: ['/'] },
    { hostname: 'www.youtube.com',     pathExact: ['/'] },
    // Merge personal patterns from config.local.js (if it exists)
    ...(typeof LOCAL_LANDING_PAGE_PATTERNS !== 'undefined' ? LOCAL_LANDING_PAGE_PATTERNS : []),
  ];

  function isLandingPage(url) {
    try {
      const parsed = new URL(url);
      return LANDING_PAGE_PATTERNS.some(p => {
        // Support both exact hostname and suffix matching (for wildcard subdomains)
        const hostnameMatch = p.hostname
          ? parsed.hostname === p.hostname
          : p.hostnameEndsWith
            ? parsed.hostname.endsWith(p.hostnameEndsWith)
            : false;
        if (!hostnameMatch) return false;
        if (p.test)       return p.test(parsed.pathname, url);
        if (p.pathPrefix) return parsed.pathname.startsWith(p.pathPrefix);
        if (p.pathExact)  return p.pathExact.includes(parsed.pathname);
        return parsed.pathname === '/';
      });
    } catch { return false; }
  }

  domainGroups = [];
  const groupMap    = {};
  const landingTabs = [];

  // Custom group rules from config.local.js (if any)
  const customGroups = typeof LOCAL_CUSTOM_GROUPS !== 'undefined' ? LOCAL_CUSTOM_GROUPS : [];

  // Check if a URL matches a custom group rule; returns the rule or null
  function matchCustomGroup(url) {
    try {
      const parsed = new URL(url);
      return customGroups.find(r => {
        const hostMatch = r.hostname
          ? parsed.hostname === r.hostname
          : r.hostnameEndsWith
            ? parsed.hostname.endsWith(r.hostnameEndsWith)
            : false;
        if (!hostMatch) return false;
        if (r.pathPrefix) return parsed.pathname.startsWith(r.pathPrefix);
        return true; // hostname matched, no path filter
      }) || null;
    } catch { return null; }
  }

  for (const tab of realTabs) {
    try {
      if (isLandingPage(tab.url)) {
        landingTabs.push(tab);
        continue;
      }

      // Check custom group rules first (e.g. merge subdomains, split by path)
      const customRule = matchCustomGroup(tab.url);
      if (customRule) {
        const key = customRule.groupKey;
        if (!groupMap[key]) groupMap[key] = { domain: key, label: customRule.groupLabel, tabs: [] };
        groupMap[key].tabs.push(tab);
        continue;
      }

      // 然后是内置的子域归并规则（www.bilibili.com + search.bilibili.com
      // 合成一张「B站」卡）。放在自定义规则之后，所以 config.local.js
      // 里的规则可以覆盖内置规则。
      const mergeRule = matchSiteMerge(tab.url);
      if (mergeRule) {
        const key = mergeRule.groupKey;
        if (!groupMap[key]) groupMap[key] = { domain: key, merged: true, tabs: [] };
        groupMap[key].tabs.push(tab);
        continue;
      }

      let hostname;
      if (tab.url && tab.url.startsWith('file://')) {
        hostname = 'local-files';
      } else {
        hostname = new URL(tab.url).hostname;
      }
      if (!hostname) continue;

      if (!groupMap[hostname]) groupMap[hostname] = { domain: hostname, tabs: [] };
      groupMap[hostname].tabs.push(tab);
    } catch {
      // Skip malformed URLs
    }
  }

  if (landingTabs.length > 0) {
    groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
  }

  // Sort: landing pages first, then domains from landing page sites, then by tab count
  // Collect exact hostnames and suffix patterns for priority sorting
  const landingHostnames = new Set(LANDING_PAGE_PATTERNS.map(p => p.hostname).filter(Boolean));
  const landingSuffixes = LANDING_PAGE_PATTERNS.map(p => p.hostnameEndsWith).filter(Boolean);
  function isLandingDomain(domain) {
    if (landingHostnames.has(domain)) return true;
    return landingSuffixes.some(s => domain.endsWith(s));
  }
  domainGroups = Object.values(groupMap).sort((a, b) => {
    const aIsLanding = a.domain === '__landing-pages__';
    const bIsLanding = b.domain === '__landing-pages__';
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;

    const aIsPriority = isLandingDomain(a.domain);
    const bIsPriority = isLandingDomain(b.domain);
    if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;

    return b.tabs.length - a.tabs.length;
  });

  // --- Render domain cards ---
  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl   = document.getElementById('openTabsMissions');
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');
  const openTabsSectionTitle = document.getElementById('openTabsSectionTitle');
  const openTabsActionsEl    = document.getElementById('openTabsActions');

  if (domainGroups.length > 0 && openTabsSection) {
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = T('section.openTabs');
    openTabsSectionCount.textContent = Tn('badge.domain', 'badge.domains', domainGroups.length);

    // 批量操作按钮。原先「Close all」是塞在 count 那一行里的，现在三种批量动作
    // 一起挪到独立的一行，否则 nowrap 的 count 行在窄窗口下会挤爆。
    if (openTabsActionsEl) {
      openTabsActionsEl.innerHTML = `
        <button class="action-btn save-tabs" data-action="save-all-open-tabs" data-close-after="0">
          ${ICONS.save} ${T('action.saveAll')}
        </button>
        <button class="action-btn save-tabs" data-action="save-all-open-tabs" data-close-after="1">
          ${ICONS.save} ${T('action.saveAllAndClose')}
        </button>
        <button class="action-btn close-tabs" data-action="close-all-open-tabs">
          ${ICONS.close} ${T('action.closeAllTabs', { n: realTabs.length })}
        </button>`;
      openTabsActionsEl.style.display = 'flex';
    }
    openTabsMissionsEl.innerHTML = domainGroups.map(g => renderDomainCard(g)).join('');
    wireFaviconFallbacks(openTabsMissionsEl);
    openTabsSection.style.display = 'block';
  } else if (openTabsSection) {
    openTabsSection.style.display = 'none';
  }

  // --- Footer stats ---
  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = openTabs.length;

  // --- Check for duplicate Guilong tabs ---
  checkTabOutDupes();

  // --- Render "Saved for Later" column ---
  await renderDeferredColumn();
}

/* ----------------------------------------------------------------
   新标签页模块开关 + 搜索框

   开关只控制「显示不显示」，**绝不删数据** —— 关掉站点条之后，pinnedSites 和
   hiddenTopSites 原样留在 storage 里，重新打开就都回来了。
   ---------------------------------------------------------------- */

/** 开关的默认值。以后要加新开关，在这里补一行就行（见 getUiPrefs 的合并逻辑） */
const UI_PREFS_DEFAULTS = {
  showQuickSites: true,   // 常用站点条
  showSearchBox:  true,   // 搜索框
  showWeather:    true,   // 当地天气（默认地点见 DEFAULT_WEATHER_LOCATION）
};

/**
 * getUiPrefs() — 读出开关状态
 *
 * 跟默认值合并一层：这样以后新增开关时，老用户的存储里没有那个键，
 * 读到的会是默认值而不是 undefined（undefined 会让 checkbox 处于半死状态）。
 */
async function getUiPrefs() {
  const { [UI_PREFS_KEY]: saved } = await chrome.storage.local.get(UI_PREFS_KEY);
  const prefs = (saved && typeof saved === 'object') ? saved : {};
  return { ...UI_PREFS_DEFAULTS, ...prefs };
}

async function setUiPref(key, value) {
  if (!(key in UI_PREFS_DEFAULTS)) return;   // 只认自己声明过的开关
  const prefs = await getUiPrefs();
  prefs[key] = !!value;
  await chrome.storage.local.set({ [UI_PREFS_KEY]: prefs });
}

/** applyUiPrefs() — 把开关状态落到 DOM 上（显示/隐藏 + 同步开关自己的位置） */
async function applyUiPrefs() {
  const prefs = await getUiPrefs();

  const quickBlock = document.getElementById('quickSites');
  if (quickBlock) quickBlock.style.display = prefs.showQuickSites ? '' : 'none';

  const searchBar = document.getElementById('searchBar');
  if (searchBar) searchBar.style.display = prefs.showSearchBox ? '' : 'none';

  // 天气条同理：开关只管「露不露」。weatherLocation 和 weatherCache 原样留着，
  // 关掉再打开，还是你之前选的那个城市，温度也不用重新等一次网络。
  applyWeatherVisibility(prefs);

  // 开关自己的勾选状态也要跟上，否则重开页面时勾的位置和实际情况不符
  document.querySelectorAll('input[data-setting]').forEach(input => {
    const key = input.dataset.setting;
    if (key in prefs) input.checked = !!prefs[key];
  });

  return prefs;
}

/* ----------------------------------------------------------------
   呼出快捷键（设置面板里那一行）

   ⚠️ Chrome 的 commands API **只能读，不能写**。commands.update() 和
   commands.reset() 是 Firefox 才有的东西，Chrome 这边扩展没有任何办法
   设定或修改自己的快捷键。所以这一行能做的只有两件事：

     把 Chrome 当前绑的组合读出来显示 + 一个按钮跳到 Chrome 自己的
     快捷键页面让用户改。

   这不是「绕开限制失败」，是唯一存在的路子。而且那个页面能录的组合比
   manifest 里的 suggested_key 宽松得多 —— 用户想要的「自由修改组合」
   真正发生在那里，不在我们这边。
   ---------------------------------------------------------------- */

const COMMAND_NAME  = 'open-dashboard';
const SHORTCUTS_URL = 'chrome://extensions/shortcuts';

// navigator 在 Node 的冒烟测试沙箱里不存在，判一下再读，别让加载直接炸
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');

/**
 * formatShortcutParts(parts, isMac) — 把拆好的按键拼成好认的样子
 *
 * parts 来自 Chrome 给的组合串，例如 ['Command','Shift','K']。
 * 单独拆成一个函数是为了**可测**：真机是 Mac 还是 Windows 造不出来，
 * 但 isMac 可以当参数传进去。
 */
function formatShortcutParts(parts, isMac) {
  const glyph = {
    Command: '⌘', Cmd: '⌘', MacCtrl: '⌃', Ctrl: '⌃', Control: '⌃',
    Alt: '⌥', Option: '⌥', Shift: '⇧', Space: T('key.space'),
  };
  const word = {
    Command: 'Cmd', Cmd: 'Cmd', MacCtrl: 'Ctrl', Ctrl: 'Ctrl', Control: 'Ctrl',
    Alt: 'Alt', Option: 'Option', Shift: 'Shift', Space: T('key.space'),
  };
  const table = isMac ? glyph : word;
  return parts.map(p => table[p] || p).join(isMac ? '' : ' + ');
}

/**
 * formatShortcut(combo) — "Command+Shift+K" 或 "⌘⇧K" → 好认的显示形式
 *
 * 两种输入都要接住：Windows / Linux 上 getAll() 给的是 "Ctrl+Shift+K"
 * 这种写法，macOS 上常常直接给 "⌘⇧K" 这种符号串。符号串里没有 "+"，
 * 拆出来只有一个 token —— 那就原样用它，别再拿英文名去拼一遍。
 */
function formatShortcut(combo) {
  if (!combo) return '';
  const parts = combo.split('+').map(s => s.trim()).filter(Boolean);
  if (parts.length <= 1) return combo;
  return formatShortcutParts(parts, IS_MAC);
}

/**
 * renderShortcutSetting() — 读出当前绑定并显示出来
 *
 * 读不到就显示「未设置」，**不往外抛** —— 快捷键没绑上不该把整个设置面板带崩。
 */
async function renderShortcutSetting() {
  const box = document.getElementById('shortcutKeys');
  if (!box) return;

  let combo = '';
  try {
    const all = await chrome.commands.getAll();
    const cmd = (all || []).find(c => c.name === COMMAND_NAME);
    combo = (cmd && cmd.shortcut) || '';
  } catch {
    combo = '';
  }

  box.textContent = combo ? formatShortcut(combo) : T('settings.shortcut.unset');
  box.classList.toggle('shortcut-keys-unset', !combo);
}

/** openShortcutSettings() — 跳到 Chrome 自己的快捷键页面（扩展不能替你改） */
async function openShortcutSettings() {
  try {
    await chrome.tabs.create({ url: SHORTCUTS_URL });
  } catch {
    showToast(T('toast.shortcutUnavailable'));
  }
}

/* 用户去 Chrome 那边改完快捷键、切回这个标签页时，把显示刷新一下。
   少了这一步，他会一直看着打开面板那一刻的旧值，然后以为没设成功。 */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  renderShortcutSetting();
  // 顺手刷一次天气：这个标签页可能开着挂了很久，回来时温度早变了。
  renderWeather();
});


/* ----------------------------------------------------------------
   当地天气（设置面板里的开关 + 城市选择）

   ── 数据从哪来 ─────────────────────────────────────────────────
   Open-Meteo。选它有三个理由，都是查过的：
     · **免费且不要 API key**。要 key 的方案意味着每个用的人得自己配一个，
       fork 出去还得替别人的额度负责，不适合一个开源小扩展。
     · 响应头里带 `access-control-allow-origin: *`。所以扩展页可以直接
       跨域取，manifest 里**一个 host_permissions 都不用加** ——
       用户重载时不会突然多一个权限确认框。这条是实测出来的（带了
       Origin 头问过），不是推测。代价是：哪天这个 CORS 头没了，这里会
       静默失败，而不是报个错。所以失败路径必须做得干净（见 renderWeather）。
     · 地理编码接口支持 language=zh，能直接拿回中文地名。

   ── 拿不到数据时的行为（这条最重要）────────────────────────────
   **不报错、不弹提示条、不删缓存。** 有旧数据显示旧的，没有就保持空白。
   新标签页是最不该出现错误提示的地方 —— 断网、被墙、接口挂了，用户该
   看到的只是「这里没有天气」，而不是一个他看不懂也修不了的红条。
   ---------------------------------------------------------------- */

const WEATHER_API_HOST     = 'https://api.open-meteo.com';
const WEATHER_GEOCODE_HOST = 'https://geocoding-api.open-meteo.com';

// 超过这个时长就回源刷新。缓存本身**永不主动删**：过期只是让它重新拉一次，
// 拉不到就继续用这份旧的，总比空着强。
const WEATHER_TTL_MS      = 20 * 60 * 1000;
const WEATHER_TIMEOUT_MS  = 8000;
const WEATHER_PLACE_LIMIT = 6;

const WEATHER_LOCATION_KEY = 'weatherLocation';
const WEATHER_CACHE_KEY    = 'weatherCache';

/* 默认地点。**只存坐标，不存名字** —— 显示用的名字走文案表
   weather.defaultCity，这样它跟着界面语言变（英文界面显示 Shanghai），
   而不是卡死在中文里。 */
const DEFAULT_WEATHER_LOCATION = { latitude: 31.22222, longitude: 121.45806 };

/**
 * 天气码 → 种别。Open-Meteo 用的是 WMO 那套数字码（0=晴、3=阴、61=雨…）。
 *
 * 归成 11 个种别，而不是把 28 个码原样显示出来：码本身用户看不懂，
 * 而给每个码配一条中英文案，维护成本远大于收益。强度差别
 * （毛毛雨 / 中雨 / 大雨）也一并抹平了 —— 那一行字没那么大地方，
 * 而且「外面在下雨」这个信息量已经够决定要不要带伞。
 */
const WEATHER_CODE_KINDS = {
  0: 'clear', 1: 'mostlyClear', 2: 'partly', 3: 'overcast',
  45: 'fog', 48: 'fog',
  51: 'drizzle', 53: 'drizzle', 55: 'drizzle', 56: 'drizzle', 57: 'drizzle',
  61: 'rain', 63: 'rain', 65: 'rain', 66: 'rain', 67: 'rain',
  71: 'snow', 73: 'snow', 75: 'snow', 77: 'snow',
  80: 'showers', 81: 'showers', 82: 'showers',
  85: 'snowShowers', 86: 'snowShowers',
  95: 'storm', 96: 'storm', 99: 'storm',
};

/** 种别 → 文案词目 + 图标。图标只有 7 个，所以几个种别共用一张图 */
const WEATHER_KINDS = {
  clear:       { text: 'weather.clear',       icon: 'sun' },
  mostlyClear: { text: 'weather.mostlyClear', icon: 'sun' },
  partly:      { text: 'weather.partly',      icon: 'cloudSun' },
  overcast:    { text: 'weather.overcast',    icon: 'cloud' },
  fog:         { text: 'weather.fog',         icon: 'fog' },
  drizzle:     { text: 'weather.drizzle',     icon: 'rain' },
  rain:        { text: 'weather.rain',        icon: 'rain' },
  showers:     { text: 'weather.showers',     icon: 'rain' },
  snow:        { text: 'weather.snow',        icon: 'snow' },
  snowShowers: { text: 'weather.snowShowers', icon: 'snow' },
  storm:       { text: 'weather.storm',       icon: 'storm' },
};

/* 图标全部用圆 / 矩形 / 直线拼，**不抄弧线路径**：小尺寸下我要能靠自己
   把这几个图元算出来长什么样，而不是赌一段没法验证的 d 属性是对的。
   每一个都在 16px 真渲染出来看过（resvg）。
   云有「抬起」和「放下」两版：下雨下雪打雷的用抬起那版，云往上挪 2px，
   下面留出位置给雨丝 / 雪点 / 闪电，不然会跟底部挤成一坨。 */
const weatherSvg = (inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">${inner}</svg>`;

const weatherCloud = (dy = 0) =>
  `<circle cx="14.1" cy="${10.9 + dy}" r="4.2"/>`
  + `<circle cx="9.1" cy="${12.9 + dy}" r="3.2"/>`
  + `<rect x="6.1" y="${12.9 + dy}" width="12" height="4.2" rx="2.1"/>`;

const weatherStroke = (w, d) =>
  `<path fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" d="${d}"/>`;

const WEATHER_ICONS = {
  sun:      weatherSvg(`<circle cx="12" cy="12" r="5"/>`
            + weatherStroke(1.8, 'M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.55 1.55M17.05 17.05l1.55 1.55M5.4 18.6l1.55-1.55M17.05 6.95l1.55-1.55')),
  cloudSun: weatherSvg(`<circle cx="8.2" cy="8.2" r="3.1"/>`
            + weatherStroke(1.6, 'M8.2 2.4v1.6M2.4 8.2h1.6M4.15 4.15l1.1 1.1M12.25 4.15l-1.1 1.1')
            + `<circle cx="15" cy="13.2" r="3.9"/><circle cx="10.4" cy="15" r="3"/><rect x="7.4" y="15" width="11.2" height="3.9" rx="1.95"/>`),
  cloud:    weatherSvg(weatherCloud()),
  fog:      weatherSvg(weatherCloud(-2) + weatherStroke(1.8, 'M7.3 18.4h9.4M8.8 21.6h6.4')),
  rain:     weatherSvg(weatherCloud(-2) + weatherStroke(1.9, 'M9.4 18.6l-1 2.1M13.2 18.6l-1 2.1M17 18.6l-1 2.1')),
  snow:     weatherSvg(weatherCloud(-2) + weatherStroke(2, 'M9.3 19.2h.01M13.1 19.2h.01M16.9 19.2h.01')),
  storm:    weatherSvg(weatherCloud(-2) + `<path d="M13.4 16 9.5 20.9h2.9l-1.1 2.5 4.1-4.6h-2.9z"/>`),
};

/**
 * 天气码 → 给人看的种别文案。认不出的码不报错，退回一个中性的说法 ——
 * 接口哪天加个新码，页面上最差也只是显示「天气」，不会变成 undefined。
 */
function weatherText(code) {
  const kind = WEATHER_CODE_KINDS[code];
  const def  = kind && WEATHER_KINDS[kind];
  return T(def ? def.text : 'weather.unknown');
}

/** 天气码 → 图标 SVG。认不出的码退回一朵云 */
function weatherIcon(code) {
  const kind = WEATHER_CODE_KINDS[code];
  const def  = kind && WEATHER_KINDS[kind];
  return WEATHER_ICONS[(def && def.icon) || 'cloud'] || WEATHER_ICONS.cloud;
}

/** 地理编码接口认 zh / en 这种两字母码，从界面语言推出来 */
function weatherLangCode() {
  return String(localeOf() || 'zh').split('-')[0];
}

/** 温度：取整 + 套模板。不是数字就返回空串（宁可空着，也不要显示 "NaN°"） */
function formatTemperature(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return T('weather.temp', { t: Math.round(value) });
}

/** 今天的最高 / 最低。缺任何一个就整条不显示 —— 只报一半比不报更让人困惑 */
function formatWeatherRange(min, max) {
  const ok = (v) => typeof v === 'number' && Number.isFinite(v);
  if (!ok(min) || !ok(max)) return '';
  return T('weather.range', { min: Math.round(min), max: Math.round(max) });
}

/**
 * placeSubtitle(place) — 搜索结果里那行小字
 *
 * 地理编码接口对「上海」会同时给 name='上海'、admin1='上海市'、country='中国'。
 * 直接拼就成了「上海 · 上海市 · 中国」，前两个根本是一回事。
 * 所以 admin1 以 name 开头的就丢掉，只留真正有信息量的部分（省份 / 国家）。
 */
function placeSubtitle(place) {
  const name    = String((place && place.name)    || '');
  const admin1  = String((place && place.admin1)  || '');
  const country = String((place && place.country) || '');
  const parts   = [];
  if (admin1 && !admin1.startsWith(name)) parts.push(admin1);
  if (country && !parts.includes(country)) parts.push(country);
  return parts.join(' · ');
}

/** 界面上显示的城市名。没选过就用默认那个，名字从文案表取 */
function weatherCityLabel(loc) {
  const name = (loc && typeof loc.name === 'string') ? loc.name.trim() : '';
  return name || T('weather.defaultCity');
}

/**
 * weatherShouldShow(prefs, ready) — 天气条到底露不露
 *
 * 抽成纯函数是为了**能测**：真机上「开关开没开」×「有没有画过」的组合
 * 要在浏览器里一个个点出来太慢，但这三种组合都必须是对的。
 * ready 是元素上的 dataset.ready，'1' 表示已经成功画过一次。
 * **没画过就不露** —— 否则会先闪一个空盒子出来，新标签页上这一下特别扎眼。
 */
function weatherShouldShow(prefs, ready) {
  return !!(prefs && prefs.showWeather && ready === '1');
}

/**
 * 缓存还新不新鲜。age < 0（系统时间被往回调过）一律当过期：
 * 拿「未来的」时间戳去算年龄会得出负数，那种缓存不可信，宁可重拉一次。
 */
function isWeatherCacheFresh(cache, now) {
  if (!cache || typeof cache.at !== 'number' || !Number.isFinite(cache.at)) return false;
  const t = (typeof now === 'number') ? now : Date.now();
  const age = t - cache.at;
  return age >= 0 && age < WEATHER_TTL_MS;
}

/**
 * fetchJson(url) — 带超时的取 JSON
 *
 * **任何失败都回 null**：断网、被墙、超时、非 200、返回的不是 JSON，
 * 全部归成同一件事「这次没拿到」。调用方因此只需要处理两种情况，
 * 而不是给每种网络错误写一套分支 —— 反正对用户的含义是一样的。
 */
async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEATHER_TIMEOUT_MS);
  try {
    // no-store：新标签页不该显示 HTTP 缓存里那份几小时前的温度。
    // 我们自己的缓存策略在 weatherCache 那边，比 HTTP 缓存精细。
    const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Open-Meteo 的每日值是单元素数组，取不出来就当没有 */
function firstNumber(maybeArray) {
  return (Array.isArray(maybeArray) && typeof maybeArray[0] === 'number') ? maybeArray[0] : null;
}

/**
 * fetchWeather(loc) — 拉一次实况
 *
 * 形状不对（没有 current.temperature_2m，或者它不是数字）一律当失败：
 * 宁可什么都不显示，也不要画一个 0° 出来 —— 那比没有更糟，
 * 因为它看起来是真的。
 */
async function fetchWeather(loc) {
  const lat = Number(loc && loc.latitude);
  const lon = Number(loc && loc.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const url = `${WEATHER_API_HOST}/v1/forecast?latitude=${lat}&longitude=${lon}`
    + '&current=temperature_2m,weather_code'
    + '&daily=temperature_2m_max,temperature_2m_min'
    + '&timezone=auto&forecast_days=1';

  const json = await fetchJson(url);
  const cur  = json && json.current;
  if (!cur || typeof cur.temperature_2m !== 'number' || !Number.isFinite(cur.temperature_2m)) return null;

  const day = (json && json.daily) || {};
  return {
    at:          Date.now(),
    temperature: cur.temperature_2m,
    weatherCode: cur.weather_code,
    tempMax:     firstNumber(day.temperature_2m_max),
    tempMin:     firstNumber(day.temperature_2m_min),
  };
}

/**
 * searchPlaces(query) — 按名字找城市
 *
 * 返回值把三件事分得很清楚，调用方要据此给不同的提示：
 *   null  → 请求本身没成（断网 / 超时 / 接口挂了）
 *   []    → 请求成了，但没这个地名
 *   [...]  → 找到了
 * 合并成 `[]` 是不行的：那两句话该说的东西完全不同 ——
 * 一个让人换关键词，一个让人查网络。
 *
 * language 跟着界面语言走：中文界面搜「上海」拿回「上海」，英文界面
 * 搜 shanghai 拿回 Shanghai。**城市名是接口数据，不进 strings.js** ——
 * 判断标准还是那句：换语言时它该不该变？该变，而且它会自己变。
 */
async function searchPlaces(query) {
  const q = String(query == null ? '' : query).trim();
  if (!q) return [];

  const url = `${WEATHER_GEOCODE_HOST}/v1/search?name=${encodeURIComponent(q)}`
    + `&count=${WEATHER_PLACE_LIMIT}&language=${weatherLangCode()}&format=json`;

  const json = await fetchJson(url);
  if (!json) return null;   // 拿不到 ≠ 没找到

  const list = Array.isArray(json.results) ? json.results : [];
  return list
    .filter(r => r && typeof r.latitude === 'number' && typeof r.longitude === 'number')
    .map(r => ({
      name:      String(r.name || ''),
      latitude:  r.latitude,
      longitude: r.longitude,
      admin1:    String(r.admin1  || ''),
      country:   String(r.country || ''),
    }))
    .filter(p => p.name);
}

async function getWeatherLocation() {
  const { [WEATHER_LOCATION_KEY]: saved } = await chrome.storage.local.get(WEATHER_LOCATION_KEY);
  if (saved && typeof saved.latitude === 'number' && typeof saved.longitude === 'number') return saved;
  return { ...DEFAULT_WEATHER_LOCATION };
}

/**
 * 记下选中的城市。
 * .slice(0, 80) 是给外部数据上一道长度闸：地名再长也不该撑破那一行字，
 * 更不该跟着一起存进 storage。
 */
async function setWeatherLocation(place) {
  if (!place || typeof place.latitude !== 'number' || typeof place.longitude !== 'number') return;
  await chrome.storage.local.set({
    [WEATHER_LOCATION_KEY]: {
      name:      String(place.name    || '').slice(0, 80),
      latitude:  place.latitude,
      longitude: place.longitude,
      admin1:    String(place.admin1  || '').slice(0, 80),
      country:   String(place.country || '').slice(0, 80),
    },
  });
}

async function getWeatherCache() {
  const { [WEATHER_CACHE_KEY]: cache } = await chrome.storage.local.get(WEATHER_CACHE_KEY);
  return (cache && typeof cache === 'object') ? cache : null;
}

/**
 * paintWeather(el, data, loc) — 把一份天气数据画到条上
 *
 * 返回 true 表示真画出东西了。温度不可用就**整个不画**（返回 false）：
 * 缓存里那条可能是别的版本写的，形状不一定对得上，而半画的状态
 * （有图标没温度之类）比不画更难看。
 */
function paintWeather(el, data, loc) {
  if (!el || !data) return false;
  if (typeof data.temperature !== 'number' || !Number.isFinite(data.temperature)) return false;

  const iconEl  = document.getElementById('weatherIcon');
  const descEl  = document.getElementById('weatherDesc');
  const tempEl  = document.getElementById('weatherTemp');
  const cityEl  = document.getElementById('weatherCity');
  const rangeEl = document.getElementById('weatherRange');

  // 图标是我们自己代码里的常量，不是外部数据，所以 innerHTML 是安全的
  if (iconEl) iconEl.innerHTML    = weatherIcon(data.weatherCode);
  if (descEl) descEl.textContent  = weatherText(data.weatherCode);
  if (tempEl) tempEl.textContent  = formatTemperature(data.temperature);
  if (cityEl) cityEl.textContent  = weatherCityLabel(loc);

  const range = formatWeatherRange(data.tempMin, data.tempMax);
  if (rangeEl) {
    rangeEl.textContent   = range;
    rangeEl.style.display = range ? '' : 'none';
  }

  el.dataset.ready = '1';
  return true;
}

/** 天气条露不露。applyUiPrefs 和 renderWeather 都走这里，免得两处判断走岔 */
function applyWeatherVisibility(prefs) {
  const el = document.getElementById('weather');
  if (!el) return;
  el.style.display = weatherShouldShow(prefs, el.dataset.ready) ? '' : 'none';
}

/**
 * renderWeather() — 把天气条画出来
 *
 * 策略是**缓存优先**，因为新标签页会被反复打开，而这个页面上每次打开
 * 都打一次网络是不可接受的：
 *   1. 有缓存就先画（哪怕已过期）—— 页面一出现就有内容，不用等网络
 *   2. 缓存还新鲜就直接收工，一次网络都不打
 *   3. 过期才回源；拿到就覆盖缓存重画，拿不到就**什么都不做**
 *
 * 返回 'painted' | 'hidden' | 'unavailable'。让调用方能区分
 * 「开关关着」和「真没拿到」—— 这两种情况下用户该被告诉的事情完全不同。
 */
async function renderWeather() {
  const el = document.getElementById('weather');
  if (!el) return 'unavailable';

  try {
    const prefs = await getUiPrefs();
    applyWeatherVisibility(prefs);
    if (!prefs.showWeather) return 'hidden';

    const loc   = await getWeatherLocation();
    const cache = await getWeatherCache();

    if (cache && paintWeather(el, cache, loc)) applyWeatherVisibility(prefs);
    const painted = el.dataset.ready === '1';
    if (isWeatherCacheFresh(cache)) return painted ? 'painted' : 'unavailable';

    const fresh = await fetchWeather(loc);
    if (!fresh) return painted ? 'painted' : 'unavailable';

    await chrome.storage.local.set({ [WEATHER_CACHE_KEY]: fresh });
    paintWeather(el, fresh, loc);
    applyWeatherVisibility(prefs);
    return 'painted';
  } catch (err) {
    // storage 读不出来、扩展上下文失效之类。天气拉不到**不该**把新标签页搞崩，
    // 所以这里只是咽下去 + 留一行日志。
    console.warn('[guilong] 天气渲染失败:', err);
    return 'unavailable';
  }
}

/** 设置面板里那句「当前：上海」 */
async function renderWeatherPlaceSetting() {
  const el = document.getElementById('weatherPlaceCurrent');
  if (!el) return;
  try {
    const loc = await getWeatherLocation();
    el.textContent = T('settings.weatherPlace.current', { city: weatherCityLabel(loc) });
  } catch (err) {
    el.textContent = '';
  }
}


/* ---------------- 城市搜索（设置面板里那一行） ----------------
   上一次的结果存在这里，点选时按**下标**取回，而不是把城市名塞进
   data- 属性里再读出来：塞进去就得转义，还得防着页面上的字符被反过来
   当代码看。存下标没有这个问题。 */
let lastPlaceResults = [];

function hideWeatherResults() {
  const box = document.getElementById('weatherResults');
  if (!box) return;
  box.style.display = 'none';
  box.innerHTML = '';
}

function showWeatherHint(key) {
  const box = document.getElementById('weatherResults');
  if (!box) return;
  box.innerHTML = `<div class="weather-result-hint">${escapeAttr(T(key))}</div>`;
  box.style.display = '';
}

/**
 * runPlaceSearch() — 拿输入框里的字去搜城市
 *
 * 「搜不动」和「没找到」给的是**不同**的提示，因为用户要采取的行动不同：
 * 一个是换个关键词，一个是去查网络。searchPlaces 用 null / [] 把这两件事
 * 分开了，这里照着翻译成提示条。
 */
async function runPlaceSearch() {
  const input = document.getElementById('weatherPlaceInput');
  if (!input) return;

  const q = input.value.trim();
  if (!q) { hideWeatherResults(); return; }

  showWeatherHint('settings.weatherPlace.busy');

  const results = await searchPlaces(q);
  lastPlaceResults = results || [];

  if (results === null)     { showWeatherHint('settings.weatherPlace.failed'); return; }
  if (!results.length)      { showWeatherHint('settings.weatherPlace.empty');  return; }

  const box = document.getElementById('weatherResults');
  if (!box) return;

  // 城市名来自外部接口，必须转义 —— 和 topSites 的标题是同一类东西
  box.innerHTML = lastPlaceResults.map((p, i) =>
    `<button type="button" class="weather-result" data-action="pick-weather-place" data-place-index="${i}">`
    + `<span class="weather-result-name">${escapeAttr(p.name)}</span>`
    + `<span class="weather-result-sub">${escapeAttr(placeSubtitle(p))}</span>`
    + `</button>`).join('');
  box.style.display = '';
}

// 城市输入框：回车即搜。它不在任何 <form> 里，所以不会被浏览器的
// 默认提交行为带走 —— 但 preventDefault 还是留着，免得以后被套进表单。
document.addEventListener('keydown', (e) => {
  if (!e.target || e.target.id !== 'weatherPlaceInput') return;
  if (e.key !== 'Enter') return;
  e.preventDefault();
  runPlaceSearch().catch(err => console.warn('[guilong] 城市搜索失败:', err));
});


/**
 * focusSearchBox() — 把光标放进搜索框
 *
 * 只在「打开一个新标签页」时调（见 renderDashboard），**不放在 applyUiPrefs 里** ——
 * 后者也会被设置面板的开关触发，用户正点着开关时光标被抢到搜索框去很讨厌。
 * 分工是：applyUiPrefs 管「显示成什么样」，聚焦管「打开时的默认动作」。
 */
function focusSearchBox() {
  const input = document.getElementById('searchInput');
  if (input) input.focus();
}

/** looksLikeUrl(text) — 输入的是网址还是搜索词 */
function looksLikeUrl(text) {
  if (/^https?:\/\//i.test(text)) return true;
  if (/^localhost(:\d+)?(\/\S*)?$/i.test(text)) return true;
  if (/\s/.test(text)) return false;                   // 带空格的一定不是网址
  return /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(text);     // a.com / a.com/path
}

/**
 * runSearch(raw) — 搜索框提交
 *
 * 输入的是网址就直接打开，否则交给**用户自己设置的默认搜索引擎** ——
 * 用 chrome.search，不硬编码任何一家。换默认引擎、换浏览器都跟着走，
 * 也不替用户决定该用哪家（这件事墙内墙外差别很大）。
 */
async function runSearch(raw) {
  const text = (raw || '').trim();
  if (!text) return;

  if (looksLikeUrl(text)) {
    const href = /^https?:\/\//i.test(text) ? text : `https://${text}`;
    await chrome.tabs.create({ url: href });
    return;
  }

  if (chrome.search && chrome.search.query) {
    try {
      // NEW_TAB：跟站点条的点击行为保持一致，不悄悄把当前这个仪表盘替掉
      await chrome.search.query({ text, disposition: 'NEW_TAB' });
      return;
    } catch (err) {
      console.warn('[guilong] chrome.search 失败，退回必应:', err);
    }
  }

  // chrome.search 是 Chrome 87+ 才有的。真取不到就退到必应 ——
  // 不用 Google，国内直连打不开。
  await chrome.tabs.create({ url: `https://www.bing.com/search?q=${encodeURIComponent(text)}` });
}

async function renderDashboard() {
  // 先把 index.html 里带 data-i18n 的静态文案填上（按钮、label、placeholder 那些）
  applyStaticStrings();

  // 再把开关状态落到 DOM 上：站点条可能整个被关掉，那样连渲染都不用做
  const prefs = await applyUiPrefs();

  // 快捷键那一行：读 Chrome 当前给它绑的组合（读不到就显示「未设置」）
  await renderShortcutSetting();

  // 天气城市那一行：「当前：上海」
  await renderWeatherPlaceSetting();

  // 光标尽早进去，别等下面那两步渲染完 —— 用户开了新标签页可能立刻就开始打字
  if (prefs.showSearchBox) focusSearchBox();

  // 站点条和打开的标签页无关，单独渲染一次就好，不用跟着仪表盘反复重画
  await renderQuickSites();
  await renderStaticDashboard();

  // 天气放**最后**，而且故意不 await：它可能要等网络（最坏 8 秒超时），
  // 主内容不该被它拖着。它自己内部会先用缓存画一遍，所以视觉上不慢。
  renderWeather();
}


/* ----------------------------------------------------------------
   EVENT HANDLERS — using event delegation

   One listener on document handles ALL button clicks.
   Think of it as one security guard watching the whole building
   instead of one per door.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  // Walk up the DOM to find the nearest element with data-action
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;

  const action = actionEl.dataset.action;

  // ---- Close duplicate Guilong tabs ----
  if (action === 'close-tabout-dupes') {
    await closeTabOutDupes();
    playCloseSound();
    const banner = document.getElementById('tabOutDupeBanner');
    if (banner) {
      banner.style.transition = 'opacity 0.4s';
      banner.style.opacity = '0';
      setTimeout(() => { banner.style.display = 'none'; banner.style.opacity = '1'; }, 400);
    }
    showToast(T('toast.closedExtras'));
    return;
  }

  // ---- 设置面板：展开 / 收起 ----
  if (action === 'toggle-settings') {
    const panel  = document.getElementById('settingsPanel');
    const toggle = document.getElementById('settingsToggle');
    if (!panel) return;

    const open = !panel.classList.contains('open');
    panel.classList.toggle('open', open);
    if (toggle) toggle.classList.toggle('open', open);
    // 面板是刚展开的，顺手把快捷键和天气城市都读一次 —— 上次看之后可能改过了
    if (open) {
      await renderShortcutSetting();
      await renderWeatherPlaceSetting();
    }
    return;
  }

  // ---- 快捷键：跳到 Chrome 自己的快捷键页面（我们改不了，只能送他过去）----
  if (action === 'change-shortcut') {
    await openShortcutSettings();
    return;
  }

  // ---- 天气：搜城市 ----
  if (action === 'search-weather-place') {
    await runPlaceSearch();
    return;
  }

  // ---- 天气：选中一个城市 ----
  if (action === 'pick-weather-place') {
    const idx   = Number(actionEl.dataset.placeIndex);
    const place = Number.isInteger(idx) ? lastPlaceResults[idx] : null;
    if (!place) { showToast(T('toast.itemGone')); return; }

    await setWeatherLocation(place);
    await renderWeatherPlaceSetting();
    hideWeatherResults();
    const placeInput = document.getElementById('weatherPlaceInput');
    if (placeInput) placeInput.value = '';

    /* ⚠️ 换城市**必须**把缓存丢掉：那份数据是上一个城市的。
       不丢的话，页面会拿「上海的 26°」配着「北京」这个新名字显示出来 ——
       看着一切正常，但它是错的。这类错最难发现，因为没有任何报错。 */
    await chrome.storage.local.remove(WEATHER_CACHE_KEY);

    // 只在「真没拿到」的时候说坏消息。开关关着时用户看不到天气条，
    // 那时候报「没查到」只会让他一头雾水。
    const status = await renderWeather();
    showToast(T(status === 'unavailable' ? 'toast.weatherPlaceFailed' : 'toast.weatherPlaceSet',
                 { city: place.name }));
    return;
  }

  // ---- 常用站点：打开（永远是开一个新的，不去复用已开的页面）----
  if (action === 'open-quick-site') {
    // 拖完手一松，浏览器还可能补一个 click，别让它把站点打开了
    if (Date.now() - siteDragEndedAt < 400) return;

    const url = actionEl.dataset.siteUrl;
    if (!url) return;
    await openQuickSite(url);
    return;
  }

  // ---- 常用站点：从这一行移除 ----
  if (action === 'remove-quick-site') {
    const url = actionEl.dataset.siteUrl;
    if (!url) return;

    if (actionEl.dataset.sitePinned === '1') {
      await unpinSite(url);
      showToast(T('toast.unpinned'));
    } else {
      // 自动补进来的没有「钉住」可取消，只能记进隐藏名单，不然下次刷新又冒出来
      await hideTopSite(url);
      showToast(T('toast.siteHidden'));
    }
    await renderQuickSites();
    return;
  }

  // ---- 常用站点：展开 / 收起表单（新增） ----
  if (action === 'toggle-pin-input') {
    const form = document.getElementById('quickSiteForm');
    if (!form) return;

    if (form.style.display === 'none') openPinForm(null);
    else closePinForm();
    return;
  }

  if (action === 'cancel-pin-site') {
    closePinForm();
    return;
  }

  // ---- 常用站点：编辑一个已钉住的入口 ----
  if (action === 'edit-pinned-site') {
    const url    = actionEl.dataset.siteUrl;
    const pinned = await getPinnedSites();
    const entry  = pinned.find(s => sameEntryUrl(s.url, url));
    if (entry) openPinForm(entry);
    return;
  }

  // ---- 常用站点：把自动补的站点钉下来（钉完就能拖了）----
  if (action === 'pin-auto-site') {
    const res = await promoteTopSite(actionEl.dataset.siteUrl);
    if (!res.ok) {
      showToast(res.reason === 'duplicate' ? T('toast.alreadyPinned') : T('pin.badUrl'));
      return;
    }
    await renderQuickSites();
    showToast(T('toast.pinnedCanDrag'));
    return;
  }

  // ---- 常用站点：提交表单（新增或编辑）----
  if (action === 'pin-site') {
    const form   = document.getElementById('quickSiteForm');
    const urlEl  = document.getElementById('quickSiteInput');
    const nameEl = document.getElementById('pinNameInput');
    const icoEl  = document.getElementById('pinIconInput');
    const editingUrl = form ? form.dataset.editingUrl : '';

    const href = normalizeSiteUrl(urlEl ? urlEl.value : '');
    if (!href) {
      showToast(T('pin.badUrl'));
      return;
    }

    // 名称留空就现抓一次：用户可能在自动抓取的防抖还没跑完时就按了回车
    let name = nameEl ? nameEl.value.trim() : '';
    if (!name) name = (await suggestSiteName(href)).name;

    const payload = { url: href, title: name, icon: icoEl ? icoEl.value.trim() : '' };

    const res = editingUrl
      ? await updatePinnedSite(editingUrl, payload)
      : await pinSite(payload);

    if (!res.ok) {
      showToast(
        res.reason === 'duplicate' ? T('toast.alreadyListed')
      : res.reason === 'missing'   ? T('toast.itemGone')
      :                              T('pin.badUrl')
      );
      return;
    }

    closePinForm();
    await renderQuickSites();
    showToast(editingUrl ? T('toast.saved') : T('toast.pinned'));
    return;
  }

  const card = actionEl.closest('.mission-card');

  // ---- Expand overflow chips ("+N more") ----
  if (action === 'expand-chips') {
    const overflowContainer = actionEl.parentElement.querySelector('.page-chips-overflow');
    if (overflowContainer) {
      overflowContainer.style.display = 'contents';
      actionEl.remove();
    }
    return;
  }

  // ---- Focus a specific tab ----
  if (action === 'focus-tab') {
    const tabUrl = actionEl.dataset.tabUrl;
    if (tabUrl) await focusTab(tabUrl);
    return;
  }

  // ---- Close a single tab ----
  if (action === 'close-single-tab') {
    e.stopPropagation(); // don't trigger parent chip's focus-tab
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;

    // Close the tab in Chrome directly
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    playCloseSound();

    // Animate the chip row out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      const rect = chip.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => {
        chip.remove();
        // If the card now has no tabs, remove it too
        const parentCard = document.querySelector('.mission-card:has(.mission-pages:empty)');
        if (parentCard) animateCardOut(parentCard);
        document.querySelectorAll('.mission-card').forEach(c => {
          if (c.querySelectorAll('.page-chip[data-action="focus-tab"]').length === 0) {
            animateCardOut(c);
          }
        });
      }, 200);
    }

    // Update footer
    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;

    showToast(T('toast.tabClosed'));
    return;
  }

  // ---- Save a single tab for later (then close it) ----
  if (action === 'defer-single-tab') {
    e.stopPropagation();
    const tabUrl   = actionEl.dataset.tabUrl;
    const tabTitle = actionEl.dataset.tabTitle || tabUrl;
    if (!tabUrl) return;

    // Save to chrome.storage.local
    try {
      await saveTabForLater({ url: tabUrl, title: tabTitle });
    } catch (err) {
      console.error('[guilong] Failed to save tab:', err);
      showToast(T('toast.saveFailed'));
      return;
    }

    // Close the tab in Chrome
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    // Animate chip out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => chip.remove(), 200);
    }

    showToast(T('toast.savedForLater'));
    await renderDeferredColumn();
    return;
  }

  // ---- Check off a saved tab (moves it to archive) ----
  if (action === 'check-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await checkOffSavedTab(id);

    // Animate: strikethrough first, then slide out
    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('checked');
      setTimeout(() => {
        item.classList.add('removing');
        setTimeout(() => {
          item.remove();
          renderDeferredColumn(); // refresh counts and archive
        }, 300);
      }, 800);
    }
    return;
  }

  // ---- Dismiss a saved tab (removes it entirely) ----
  if (action === 'dismiss-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await dismissSavedTab(id);

    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        renderDeferredColumn();
      }, 300);
    }
    return;
  }

  // ---- 从归档里删除一条 ----
  // 复用现成的 dismissed 字段：getSavedTabs() 会把 dismissed 的条目从
  // active 和 archived 两个列表里同时过滤掉，所以这里不需要新的数据逻辑。
  if (action === 'delete-archived') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await dismissSavedTab(id);

    const item = actionEl.closest('.archive-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        renderDeferredColumn(); // 归档清空时整块会自动收起来
      }, 300);
    }
    showToast(T('toast.archivedDeleted'));
    return;
  }

  // ---- 批量：一键打开 saved for later 里所有未打勾的条目 ----
  if (action === 'open-all-saved') {
    const opened = await openAllSavedTabs();
    showToast(opened === 0 ? T('toast.noItemsToOpen') : T('toast.openedInBackground', { n: opened }));
    return;
  }

  // ---- 批量：把当前所有标签页存进 saved for later（data-close-after=1 时存完就关）----
  if (action === 'save-all-open-tabs') {
    const closeAfter = actionEl.dataset.closeAfter === '1';

    let result;
    try {
      result = await saveAllOpenTabs({ closeAfter });
    } catch (err) {
      console.error('[guilong] 批量存入失败:', err);
      showToast(T('toast.batchSaveFailed'));
      return;
    }

    if (result.added === 0 && result.closed === 0) {
      showToast(result.skipped > 0 ? T('toast.batchAllSkipped') : T('toast.nothingToSave'));
      return;
    }

    // 存完就关 → 卡片也得跟着消失，整页重画；只存不关 → 只需要刷新右侧清单
    if (closeAfter) await renderStaticDashboard();
    else            await renderDeferredColumn();

    if (closeAfter) {
      showToast(T('toast.batchSavedAndClosed', { added: result.added, closed: result.closed }));
    } else {
      showToast(
        T('toast.batchSaved', { n: result.added })
          + (result.skipped ? T('toast.batchSkipped', { n: result.skipped }) : '')
      );
    }
    return;
  }

  // ---- Close all tabs in a domain group ----
  if (action === 'close-domain-tabs') {
    const domainId = actionEl.dataset.domainId;
    const group    = domainGroups.find(g => {
      return 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === domainId;
    });
    if (!group) return;

    const urls      = group.tabs.map(t => t.url);
    // Landing pages and custom groups (whose domain key isn't a real hostname)
    // must use exact URL matching to avoid closing unrelated tabs.
    // merged=true 是子域归并出来的组：组名是主域，但组内的 tabs 只覆盖
    // 该站点的部分子域。若按 hostname 匹配，会连带关掉同一站点下没被
    // 归并进来的标签页（例如同站的 landing page），所以也必须精确匹配。
    const useExact  = group.domain === '__landing-pages__' || group.merged || !!group.label;

    if (useExact) {
      await closeTabsExact(urls);
    } else {
      await closeTabsByUrls(urls);
    }

    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    // Remove from in-memory groups
    const idx = domainGroups.indexOf(group);
    if (idx !== -1) domainGroups.splice(idx, 1);

    const groupLabel = group.domain === '__landing-pages__' ? T('section.homepages') : (group.label || friendlyDomain(group.domain));
    showToast(Tn('toast.closedFromOne', 'toast.closedFrom', urls.length, { group: groupLabel }));

    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;
    return;
  }

  // ---- Close duplicates, keep one copy ----
  if (action === 'dedup-keep-one') {
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    await closeDuplicateTabs(urls, true);
    playCloseSound();

    // Hide the dedup button
    actionEl.style.transition = 'opacity 0.2s';
    actionEl.style.opacity    = '0';
    setTimeout(() => actionEl.remove(), 200);

    // Remove dupe badges from the card
    if (card) {
      card.querySelectorAll('.chip-dupe-badge').forEach(b => {
        b.style.transition = 'opacity 0.2s';
        b.style.opacity    = '0';
        setTimeout(() => b.remove(), 200);
      });
      card.querySelectorAll('.open-tabs-badge').forEach(badge => {
        // 认 data-badge，不认文案 —— 文案要翻译，逻辑判断不能挂在它上面
        if (badge.dataset.badge === 'dupes') {
          badge.style.transition = 'opacity 0.2s';
          badge.style.opacity    = '0';
          setTimeout(() => badge.remove(), 200);
        }
      });
      card.classList.remove('has-amber-bar');
      card.classList.add('has-neutral-bar');
    }

    showToast(T('toast.deduped'));
    return;
  }

  // ---- Close ALL open tabs（两段式确认，防误触）----
  if (action === 'close-all-open-tabs') {
    const targets = openTabs.filter(t => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about:'));

    // 第一次点击：只进入确认态，一个标签页都不动
    if (actionEl.dataset.confirming !== '1') {
      const originalHtml = actionEl.innerHTML;
      actionEl.dataset.confirming = '1';
      actionEl.classList.add('confirming');
      actionEl.innerHTML = `${ICONS.close}${T('toast.confirmCloseAll', { n: targets.length })}`;

      // 5 秒无操作自动复位，避免按钮一直挂在危险状态上
      setTimeout(() => {
        if (!actionEl.isConnected) return;
        actionEl.dataset.confirming = '';
        actionEl.classList.remove('confirming');
        actionEl.innerHTML = originalHtml;
      }, 5000);
      return;
    }

    // 第二次点击：才真的关
    const allUrls = targets.map(t => t.url);
    await closeTabsByUrls(allUrls);
    playCloseSound();

    document.querySelectorAll('#openTabsMissions .mission-card').forEach(c => {
      shootConfetti(
        c.getBoundingClientRect().left + c.offsetWidth / 2,
        c.getBoundingClientRect().top  + c.offsetHeight / 2
      );
      animateCardOut(c);
    });

    showToast(T('toast.closedAll', { n: allUrls.length }));
    return;
  }
});

// ---- 常用站点：表单里回车提交、Esc 收起 ----
const PIN_FIELD_IDS = ['quickSiteInput', 'pinNameInput', 'pinIconInput'];

document.addEventListener('keydown', (e) => {
  if (!e.target || !PIN_FIELD_IDS.includes(e.target.id)) return;

  if (e.key === 'Enter') {
    e.preventDefault();
    const btn = document.querySelector('.quick-site-form [data-action="pin-site"]');
    if (btn) btn.click();
  } else if (e.key === 'Escape') {
    // 走 closePinForm 而不是只隐藏：它还会清空字段和 form.dataset.editingUrl，
    // 否则「编辑到一半按 Esc」会把陈旧的编辑目标留到下一次打开表单
    closePinForm();
  }
});

// ---- 常用站点：填链接时自动抓名称和图标 ----
document.addEventListener('input', (e) => {
  const id = e.target && e.target.id;

  // 链接变了才重新抓。防抖是因为这个过程中要查一次标签页，不适合每敲一个字跑一次。
  if (id === 'quickSiteInput') {
    clearTimeout(pinSuggestTimer);
    pinSuggestTimer = setTimeout(applyPinSuggestion, 300);
    renderPinIconPreview();
    return;
  }

  // 名称：用户一动手就记下「改过了」，之后链接再怎么变都不覆盖它
  if (id === 'pinNameInput') {
    e.target.dataset.touched = '1';
    renderPinIconPreview();
    return;
  }

  if (id === 'pinIconInput') renderPinIconPreview();
});

// ---- 设置面板：开关一动就落盘并立刻生效 ----
document.addEventListener('change', async (e) => {
  const input = e.target;
  if (!input || !input.dataset || !input.dataset.setting) return;

  await setUiPref(input.dataset.setting, input.checked);
  await applyUiPrefs();

  // 站点条从「关」切回「开」时要补一次渲染 —— 关着的时候根本没画过
  if (input.dataset.setting === 'showQuickSites') {
    if (!input.checked) closePinForm();   // 顺手收起展开的表单，免得下次打开还挂着
    await renderQuickSites();
  }

  // 天气同理：关着的时候一次都没画过，切回「开」得去补一次（可能要打网络）
  if (input.dataset.setting === 'showWeather' && input.checked) {
    await renderWeather();
  }
});

// ---- 搜索框：回车提交 ----
document.addEventListener('submit', (e) => {
  const form = e.target;
  if (!form || form.id !== 'searchForm') return;

  // 不拦的话扩展页面会带着查询参数自己导航一次
  e.preventDefault();
  const input = document.getElementById('searchInput');
  runSearch(input ? input.value : '')
    .catch(err => console.warn('[guilong] 搜索失败:', err));
});


/* ---------------- 站点条拖拽排序 ----------------
   只有手动钉住的卡片带 draggable="true"（见 renderQuickSite）。
   拖动过程中**不移动 DOM**：把正在被拖的节点挪走会让浏览器取消这次拖拽，
   所以改成在目标位置画一根竖线（.drop-before / .drop-after），松手了再落盘重排。
   ------------------------------------------------ */

let dragEntryUrl   = null;
let siteDragEndedAt = 0;

function quickSiteTile(node) {
  return node && node.closest ? node.closest('.quick-site') : null;
}

function clearDropMarks() {
  document.querySelectorAll('.quick-site.drop-before, .quick-site.drop-after')
    .forEach(t => t.classList.remove('drop-before', 'drop-after'));
}

function endSiteDrag() {
  dragEntryUrl = null;
  clearDropMarks();
  document.body.classList.remove('dragging-site');
  document.querySelectorAll('.quick-site.dragging').forEach(t => t.classList.remove('dragging'));
  siteDragEndedAt = Date.now();
}

document.addEventListener('dragstart', (e) => {
  const tile = quickSiteTile(e.target);
  if (!tile || tile.getAttribute('draggable') !== 'true') return;

  dragEntryUrl = tile.dataset.siteUrl || '';
  if (!dragEntryUrl) return;

  tile.classList.add('dragging');
  document.body.classList.add('dragging-site');
  try {
    e.dataTransfer.setData('text/plain', dragEntryUrl);
    e.dataTransfer.effectAllowed = 'move';
  } catch { /* 某些环境没给 dataTransfer，不影响后面的重排 */ }
});

document.addEventListener('dragover', (e) => {
  if (!dragEntryUrl) return;

  const tile = quickSiteTile(e.target);
  if (!tile || tile.dataset.siteUrl === dragEntryUrl) return;

  // 不 preventDefault 就不允许 drop
  e.preventDefault();
  try { e.dataTransfer.dropEffect = 'move'; } catch {}

  clearDropMarks();
  const r = tile.getBoundingClientRect();
  tile.classList.add(e.clientX > r.left + r.width / 2 ? 'drop-after' : 'drop-before');
});

document.addEventListener('drop', async (e) => {
  if (!dragEntryUrl) return;
  e.preventDefault();

  const tile   = quickSiteTile(e.target);
  const from   = dragEntryUrl;
  const target = tile ? (tile.dataset.siteUrl || '') : '';
  const after  = tile ? tile.classList.contains('drop-after') : false;

  endSiteDrag();

  if (!target || target === from) return;   // 拖回原位，不动

  const moved = await movePinnedSite(from, target, after);
  if (moved) {
    await renderQuickSites();
    showToast(T('toast.reordered'));
  }
});

document.addEventListener('dragend', endSiteDrag);

// ---- Archive toggle — expand/collapse the archive section ----
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#archiveToggle');
  if (!toggle) return;

  toggle.classList.toggle('open');
  const body = document.getElementById('archiveBody');
  if (body) {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
});

// ---- Archive search — filter archived items as user types ----
document.addEventListener('input', async (e) => {
  if (e.target.id !== 'archiveSearch') return;

  const q = e.target.value.trim().toLowerCase();
  const archiveList = document.getElementById('archiveList');
  if (!archiveList) return;

  try {
    const { archived } = await getSavedTabs();

    if (q.length < 2) {
      // Show all archived items
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      return;
    }

    // Filter by title or URL containing the query string
    const results = archived.filter(item =>
      (item.title || '').toLowerCase().includes(q) ||
      (item.url  || '').toLowerCase().includes(q)
    );

    archiveList.innerHTML = results.map(item => renderArchiveItem(item)).join('')
      || `<div style="font-size:12px;color:var(--muted);padding:8px 0">${T('archive.noResults')}</div>`;
  } catch (err) {
    console.warn('[guilong] Archive search failed:', err);
  }
});


/* ----------------------------------------------------------------
   INITIALIZE
   ---------------------------------------------------------------- */
renderDashboard();
