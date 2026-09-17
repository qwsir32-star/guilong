/* ================================================================
   Tab Out — Dashboard App (Pure Extension Edition)

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
 * Sets the extensionId flag so we can identify Tab Out's own pages.
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
      // Flag Tab Out's own pages so we can detect duplicate new tabs
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
 * Closes all duplicate Tab Out new-tab pages except the current one.
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

  // Keep the active Tab Out tab in the CURRENT window — that's the one the
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

  // 只处理真实网页，顺手排除 Tab Out 自己（getRealTabs 已滤掉 chrome-extension://）
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

   为什么要有这一块：Tab Out 接管新标签页之后，Chrome 原生的那排
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

const DEFAULT_FAVICON_PROBE = 'https://tab-out-no-such-site.invalid/';
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
    console.warn('[tab-out] 读不到 topSites，只显示手动钉住的站点:', err);
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

  if (diffMins < 1)   return 'just now';
  if (diffMins < 60)  return diffMins + ' min ago';
  if (diffHours < 24) return diffHours + ' hr' + (diffHours !== 1 ? 's' : '') + ' ago';
  if (diffDays === 1) return 'yesterday';
  return diffDays + ' days ago';
}

/**
 * getGreeting() — "Good morning / afternoon / evening"
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * getDateDisplay() — "Friday, April 4, 2026"
 */
function getDateDisplay() {
  return new Date().toLocaleDateString('en-US', {
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

  'local-files':          '本地文件',
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
 * Counts how many Tab Out pages are open. If more than 1,
 * shows a banner offering to close the extras.
 */
function checkTabOutDupes() {
  const tabOutTabs = openTabs.filter(t => t.isTabOut);
  const banner  = document.getElementById('tabOutDupeBanner');
  const countEl = document.getElementById('tabOutDupeCount');
  if (!banner) return;

  if (tabOutTabs.length > 1) {
    if (countEl) countEl.textContent = tabOutTabs.length;
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
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  return `
    <div class="page-chips-overflow" style="display:none">${hiddenChips}</div>
    <div class="page-chip page-chip-overflow clickable" data-action="expand-chips">
      <span class="chip-text">+${hiddenTabs.length} more</span>
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
    ${tabCount} tab${tabCount !== 1 ? 's' : ''} open
  </span>`;

  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge" style="color:var(--accent-amber);background:rgba(200,113,58,0.08);">
        ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
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
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('') + (extraCount > 0 ? buildOverflowChips(uniqueTabs.slice(8), urlCounts) : '');

  let actionsHtml = `
    <button class="action-btn close-tabs" data-action="close-domain-tabs" data-domain-id="${stableId}">
      ${ICONS.close}
      Close all ${tabCount} tab${tabCount !== 1 ? 's' : ''}
    </button>`;

  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
        Close ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </button>`;
  }

  return `
    <div class="mission-card domain-card ${hasDupes ? 'has-amber-bar' : 'has-neutral-bar'}" data-domain-id="${stableId}">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${isLanding ? 'Homepages' : (group.label || friendlyDomain(group.domain))}</span>
          ${tabBadge}
          ${dupeBadge}
        </div>
        <div class="mission-pages">${pageChips}</div>
        <div class="actions">${actionsHtml}</div>
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">tabs</div>
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
      countEl.textContent = `${active.length} item${active.length !== 1 ? 's' : ''}`;
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
            ${ICONS.tabs} 全部打开 ${active.length} 个
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
    console.warn('[tab-out] Could not load saved tabs:', err);
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
      <button class="deferred-dismiss" data-action="dismiss-deferred" data-deferred-id="${item.id}" title="Dismiss">
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
      <button class="archive-delete" data-action="delete-archived" data-deferred-id="${item.id}" title="从归档中删除">
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
    console.warn('[tab-out] 常用站点渲染失败:', err);
  }

  const addTile = `
    <button class="quick-site-add" data-action="toggle-pin-input" title="钉住一个网站">
      ${ICONS.plus}
      <span class="quick-site-add-label">钉住</span>
    </button>`;

  if (sites.length === 0) {
    listEl.innerHTML =
      `<span class="quick-sites-hint">把常用网站钉在这里，以后一点就到</span>` + addTile;
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
               data-site-url="${safeUrl}" title="编辑">${ICONS.edit}</button>`
    : `<button class="quick-site-tool" data-action="pin-auto-site"
               data-site-url="${safeUrl}" title="钉住这个网站">${ICONS.pin}</button>`;

  return `
    <div class="quick-site" data-site-url="${safeUrl}"${dragAttrs}>
      <button class="quick-site-open" data-action="open-quick-site"
              data-site-url="${safeUrl}"${dragAttrs}
              title="${safeLabel} · 打开 ${safeUrl}">
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
              title="${site.pinned ? '取消钉住' : '不再显示'}">
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

    if (btn)     btn.textContent     = '保存';
    if (titleEl) titleEl.textContent = '编辑这个入口';

    // 名称和图标都是用户已有的内容，只提示链接可以改
    setPinHint('链接、名称、图标都能改。改了链接会把这一项指到新地址。');
  } else {
    if (btn)     btn.textContent     = '钉住';
    if (titleEl) titleEl.textContent = '钉住一个网站';
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
    setPinHint('网址看起来不太对');
    renderPinIconPreview();
    return;
  }

  // 这个函数由 setTimeout 调起，抛出去没人接，所以自己兜住
  let suggestion;
  try {
    suggestion = await suggestSiteName(href);
  } catch (err) {
    console.warn('[tab-out] 自动抓取站点名称失败:', err);
    return;
  }

  if (nameEl.dataset.touched !== '1') nameEl.value = suggestion.name;
  renderPinIconPreview();

  setPinHint(
    suggestion.source === 'root'  ? '识别为网站首页，名称和图标都是自动抓的'
  : suggestion.source === 'tab'   ? '识别为具体页面，已用它的网页标题当名称'
  :                                 '识别为具体页面，建议改个名字，免得看起来像首页'
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
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = 'Open tabs';
    openTabsSectionCount.textContent = `${domainGroups.length} domain${domainGroups.length !== 1 ? 's' : ''}`;

    // 批量操作按钮。原先「Close all」是塞在 count 那一行里的，现在三种批量动作
    // 一起挪到独立的一行，否则 nowrap 的 count 行在窄窗口下会挤爆。
    if (openTabsActionsEl) {
      openTabsActionsEl.innerHTML = `
        <button class="action-btn save-tabs" data-action="save-all-open-tabs" data-close-after="0">
          ${ICONS.save} 全部存入
        </button>
        <button class="action-btn save-tabs" data-action="save-all-open-tabs" data-close-after="1">
          ${ICONS.save} 存入并关闭
        </button>
        <button class="action-btn close-tabs" data-action="close-all-open-tabs">
          ${ICONS.close} 关闭全部 ${realTabs.length} 个
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

  // --- Check for duplicate Tab Out tabs ---
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

  // 开关自己的勾选状态也要跟上，否则重开页面时勾的位置和实际情况不符
  document.querySelectorAll('input[data-setting]').forEach(input => {
    const key = input.dataset.setting;
    if (key in prefs) input.checked = !!prefs[key];
  });

  return prefs;
}

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
      console.warn('[tab-out] chrome.search 失败，退回必应:', err);
    }
  }

  // chrome.search 是 Chrome 87+ 才有的。真取不到就退到必应 ——
  // 不用 Google，国内直连打不开。
  await chrome.tabs.create({ url: `https://www.bing.com/search?q=${encodeURIComponent(text)}` });
}

async function renderDashboard() {
  // 先把开关状态落到 DOM 上：站点条可能整个被关掉，那样连渲染都不用做
  const prefs = await applyUiPrefs();

  // 光标尽早进去，别等下面那两步渲染完 —— 用户开了新标签页可能立刻就开始打字
  if (prefs.showSearchBox) focusSearchBox();

  // 站点条和打开的标签页无关，单独渲染一次就好，不用跟着仪表盘反复重画
  await renderQuickSites();
  await renderStaticDashboard();
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

  // ---- Close duplicate Tab Out tabs ----
  if (action === 'close-tabout-dupes') {
    await closeTabOutDupes();
    playCloseSound();
    const banner = document.getElementById('tabOutDupeBanner');
    if (banner) {
      banner.style.transition = 'opacity 0.4s';
      banner.style.opacity = '0';
      setTimeout(() => { banner.style.display = 'none'; banner.style.opacity = '1'; }, 400);
    }
    showToast('Closed extra Tab Out tabs');
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
      showToast('已取消钉住');
    } else {
      // 自动补进来的没有「钉住」可取消，只能记进隐藏名单，不然下次刷新又冒出来
      await hideTopSite(url);
      showToast('不再显示这个站点');
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
      showToast(res.reason === 'duplicate' ? '这个入口已经钉住了' : '网址看起来不太对');
      return;
    }
    await renderQuickSites();
    showToast('已钉住，现在可以拖动排序');
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
      showToast('网址看起来不太对');
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
        res.reason === 'duplicate' ? '这个入口已经在上面了'
      : res.reason === 'missing'   ? '这一项已经不在了'
      :                              '网址看起来不太对'
      );
      return;
    }

    closePinForm();
    await renderQuickSites();
    showToast(editingUrl ? '已保存' : '已钉住');
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

    showToast('Tab closed');
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
      console.error('[tab-out] Failed to save tab:', err);
      showToast('Failed to save tab');
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

    showToast('Saved for later');
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
    showToast('已从归档删除');
    return;
  }

  // ---- 批量：一键打开 saved for later 里所有未打勾的条目 ----
  if (action === 'open-all-saved') {
    const opened = await openAllSavedTabs();
    showToast(opened === 0 ? '没有可打开的条目' : `已在后台打开 ${opened} 个标签页`);
    return;
  }

  // ---- 批量：把当前所有标签页存进 saved for later（data-close-after=1 时存完就关）----
  if (action === 'save-all-open-tabs') {
    const closeAfter = actionEl.dataset.closeAfter === '1';

    let result;
    try {
      result = await saveAllOpenTabs({ closeAfter });
    } catch (err) {
      console.error('[tab-out] 批量存入失败:', err);
      showToast('批量存入失败');
      return;
    }

    if (result.added === 0 && result.closed === 0) {
      showToast(result.skipped > 0 ? '这些标签页都已经在待办里了' : '没有可存入的标签页');
      return;
    }

    // 存完就关 → 卡片也得跟着消失，整页重画；只存不关 → 只需要刷新右侧清单
    if (closeAfter) await renderStaticDashboard();
    else            await renderDeferredColumn();

    if (closeAfter) {
      showToast(`已存入 ${result.added} 个、关闭 ${result.closed} 个标签页`);
    } else {
      showToast(
        `已存入 ${result.added} 个标签页` + (result.skipped ? `，跳过 ${result.skipped} 个重复` : '')
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

    const groupLabel = group.domain === '__landing-pages__' ? 'Homepages' : (group.label || friendlyDomain(group.domain));
    showToast(`Closed ${urls.length} tab${urls.length !== 1 ? 's' : ''} from ${groupLabel}`);

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
        if (badge.textContent.includes('duplicate')) {
          badge.style.transition = 'opacity 0.2s';
          badge.style.opacity    = '0';
          setTimeout(() => badge.remove(), 200);
        }
      });
      card.classList.remove('has-amber-bar');
      card.classList.add('has-neutral-bar');
    }

    showToast('Closed duplicates, kept one copy each');
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
      actionEl.innerHTML = `${ICONS.close}确认关闭 ${targets.length} 个标签页？再点一次`;

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

    showToast(`已关闭 ${allUrls.length} 个标签页`);
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
});

// ---- 搜索框：回车提交 ----
document.addEventListener('submit', (e) => {
  const form = e.target;
  if (!form || form.id !== 'searchForm') return;

  // 不拦的话扩展页面会带着查询参数自己导航一次
  e.preventDefault();
  const input = document.getElementById('searchInput');
  runSearch(input ? input.value : '')
    .catch(err => console.warn('[tab-out] 搜索失败:', err));
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
    showToast('已调整顺序');
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
      || '<div style="font-size:12px;color:var(--muted);padding:8px 0">No results</div>';
  } catch (err) {
    console.warn('[tab-out] Archive search failed:', err);
  }
});


/* ----------------------------------------------------------------
   INITIALIZE
   ---------------------------------------------------------------- */
renderDashboard();
