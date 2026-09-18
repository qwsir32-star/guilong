/**
 * 归拢 · 改动冒烟测试
 *
 * 跑法：在仓库根目录执行 `node tests/smoke.js`（无依赖、无网络、不到 1 秒）。
 *
 * 它做两件事：
 *   一、用最小 stub 把 app.js 装进 vm 里，然后直接调用**内部纯函数**验证行为；
 *   二、对源码做**静态扫描**，守住「文案必须走 strings.js」「版式不变量」
 *       和「旧品牌名不许回流」这几条约定。
 *
 * 注意它的边界：它不点界面、不验证真实 Chrome API 行为。stub 写错了它会假绿。
 * 它是「逻辑 + 源码约束」的网，不是端到端测试。
 *
 *   PART 1  子域归并 matchSiteMerge / 中文友好名 friendlyDomain
 *   PART 2  批量存入 saveAllOpenTabs 的去重、id 唯一性、精确关闭
 *   PART 3  常用站点 normalizeSiteUrl / siteKey / siteLabel / getQuickSites / 钉住移除
 *   PART 4  批量打开 openAllSavedTabs
 *   PART 5  编辑已钉住条目 / 拖拽重排 / 钉下自动项
 *   PART 6  Chrome 默认「地球」占位图的识别（canvas 指纹比对）
 *   PART 7  设置开关 uiPrefs 读写 / 搜索框 looksLikeUrl / chrome.search 兜底
 *   PART 8  页头三栏版式回归守卫（孩子必须显式 grid-column）
 *   PART 9  文案表（中英对应 / T 与 Tn / data-i18n 落 DOM / 不许绕开表写死文案 /
 *           旧品牌名不许回流 / manifest 用新名字与图标 / LICENSE 保留原始署名）
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// 相对脚本自身定位，不写死绝对路径 —— 换个目录、换台机器都能跑
const ROOT = path.join(__dirname, '..');
const EXT  = path.join(ROOT, 'extension');
const APP  = path.join(EXT, 'app.js');
const srcOf = n => fs.readFileSync(path.join(EXT, n), 'utf8');

const code = fs.readFileSync(APP, 'utf8') + `
;globalThis.__t = {
  matchSiteMerge, friendlyDomain, SITE_MERGE_RULES,
  saveAllOpenTabs, openAllSavedTabs, getSavedTabs, fetchOpenTabs,
  normalizeSiteUrl, siteKey, siteLabel, getQuickSites, sameEntryUrl, originOf,
  isSiteRoot, pathHintOf, suggestSiteName, resolveSiteIcon,
  pinSite, unpinSite, hideTopSite, openQuickSite,
  updatePinnedSite, movePinnedSite, promoteTopSite,
  faviconSignature, dropIfDefaultFavicon,
  getUiPrefs, setUiPref, applyUiPrefs, looksLikeUrl, runSearch, focusSearchBox,
  formatShortcut, formatShortcutParts, COMMAND_NAME, SHORTCUTS_URL,
  weatherText, weatherIcon, formatTemperature, formatWeatherRange, placeSubtitle,
  weatherCityLabel, weatherShouldShow, isWeatherCacheFresh,
  fetchWeather, searchLocalPlaces, runPlaceSearch, renderWeather,
  getWeatherLocation, setWeatherLocation, getWeatherCache, paintWeather,
  applyWeatherVisibility,
  WEATHER_CODE_KINDS, WEATHER_KINDS, WEATHER_ICONS, WEATHER_TTL_MS,
  WEATHER_PLACE_SHOW,
  WEATHER_LOCATION_KEY, WEATHER_CACHE_KEY, DEFAULT_WEATHER_LOCATION,
  WEATHER_API_HOST,
  getLastPlaceResults: () => lastPlaceResults,
};`;

/* ---------------- 假 chrome / 假存储 ---------------- */
const EXT_ID = 'smoke-test-id';
const store  = { deferred: [] };
let   fakeTabs = [];      // 当前「打开的标签页」
const created  = [];      // chrome.tabs.create 收到的参数
let   focused  = [];      // chrome.tabs.update 记录的激活操作
let   topSites = [];      // chrome.topSites.get 的返回值

const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/* ---------------- 受控的假网络 ----------------
   天气是这套代码里唯一会往外网伸手的地方。测试要能精确地造出
   「正常」「HTTP 404」「返回的不是 JSON」「连都连不上」「超时」这几种情况，
   因为它们的处理**必须**归到同一个结果上，否则页面上会出现
   用户看不懂又修不了的错误状态。
   fetchImpl 由每个用例自己换。 */
let fetchCalls = [];
let fetchImpl  = async () => ({ ok: true, json: async () => ({}) });

const jsonResponse = (body, ok = true) => ({ ok, json: async () => body });
const badResponse  = (ok = false)        => ({ ok, json: async () => { throw new Error('not json'); } });

/* ---------------- 受控的假图片环境 ----------------
   用来验证「Chrome 给的是默认占位图，不是真图标」这条识别逻辑。
   imgPixels 登记的是「这个 src 会拿到什么像素」；没登记的 src 当加载失败处理。 */
const DEFAULT_KEY = '__chrome_default_globe__';
const imgPixels   = new Map([[DEFAULT_KEY, [9, 9, 9, 255, 9, 9, 9, 255]]]);

function pixelsForSrc(src) {
  const s = String(src);
  // 探测用的必然不存在的域名，Chrome 一定返回默认占位图
  if (s.includes('no-such-site.invalid')) return imgPixels.get(DEFAULT_KEY);
  for (const [key, px] of imgPixels) {
    if (key !== DEFAULT_KEY && s.includes(key)) return px;
  }
  return null;   // 未登记 → 当作加载失败（走 onerror）
}

class FakeImage {
  constructor() {
    this.naturalWidth  = 0;
    this.naturalHeight = 0;
    this.complete      = false;
    this.onload        = null;
    this.onerror       = null;
    this._listeners    = {};
    this._src          = '';
  }
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  get src() { return this._src; }
  set src(value) {
    this._src = value;
    setTimeout(() => {
      const px = pixelsForSrc(value);
      this.complete = true;
      if (!px) {
        if (this.onerror) this.onerror();
        (this._listeners.error || []).forEach(f => f());
        return;
      }
      this.naturalWidth  = 2;
      this.naturalHeight = 1;
      this._pixels       = px;
      if (this.onload) this.onload();
      (this._listeners.load || []).forEach(f => f());
    }, 0);
  }
}

// 造一张「已经加载好、挂在页面上」的图，给 dropIfDefaultFavicon 用
const removedImages = [];
function fakeLoadedImage(src, pixels) {
  const el = new FakeImage();
  el._src          = src;
  el._pixels       = pixels;
  el.naturalWidth  = 2;
  el.naturalHeight = 1;
  el.complete      = true;
  el.isConnected   = true;
  el.dataset       = {};
  el.remove        = function () { removedImages.push(this._src); };
  return el;
}

/* ---------------- 受控的假 DOM ----------------
   只登记测试真正要摸的那几个 id，其余一律返回 null（和改之前的行为一致）。 */
const domNodes      = new Map();
const settingInputs = [];
const searchCalls   = [];
const selectorMap   = new Map();   // querySelectorAll 用：选择器 → 假元素数组
const fakeRoot      = { lang: '' }; // 假的 <html>，applyStaticStrings 会改它的 lang

function fakeDomNode() {
  return {
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    focus() { this.focusCount = (this.focusCount || 0) + 1; },
  };
}

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  performance,
  requestAnimationFrame: () => {},
  URL,
  Image: FakeImage,
  document: {
    documentElement: fakeRoot,
    addEventListener: () => {},
    getElementById: (id) => domNodes.get(id) || null,
    querySelectorAll: (sel) => {
      if (sel === 'input[data-setting]') return settingInputs;
      return selectorMap.get(sel) || [];
    },
    querySelector: () => null,
    createElement: (tag) => {
      if (tag === 'canvas') {
        let drawn = null;
        return {
          width: 0,
          height: 0,
          getContext: () => ({
            drawImage: (img) => { drawn = (img && img._pixels) || null; },
            // 读不到像素就抛：模拟真实环境里 canvas 被污染 / 图没解码出来的情况
            getImageData: (x, y, w, h) => {
              if (!drawn) throw new Error('canvas is not readable');
              return { data: drawn };
            },
          }),
        };
      }
      return { style: {}, classList: { add() {}, remove() {} }, remove() {} };
    },
    body: { appendChild() {} },
  },
  chrome: {
    runtime: { id: EXT_ID, getURL: p => `chrome-extension://${EXT_ID}/${p}` },
    tabs: {
      query: async () => fakeTabs.map(clone),
      remove: async ids => {
        const arr = Array.isArray(ids) ? ids : [ids];
        fakeTabs = fakeTabs.filter(t => !arr.includes(t.id));
      },
      create: async opts => { created.push(opts); return { id: 900 + created.length }; },
      update: async (id, props) => { focused.push([id, props]); },
    },
    windows: { getCurrent: async () => ({ id: 1 }), update: async () => {} },
    topSites: { get: async () => topSites.map(clone) },
    search: { query: async info => { searchCalls.push(clone(info)); } },
    storage: {
      local: {
        // 真实 chrome.storage 返回的是拷贝，这里也用拷贝，能顺带抓出别名 bug
        get: async key => {
          if (typeof key === 'string') return { [key]: clone(store[key]) };
          return clone(store);
        },
        set: async obj => { Object.assign(store, clone(obj)); },
        // 换城市时要丢掉旧城市的天气缓存（见 pick-weather-place）
        remove: async key => { delete store[key]; },
      },
    },
  },
  window: {},
  globalThis: null,
  // 天气模块要用的：AbortController 做超时，fetch 走上面那个受控实现
  AbortController,
  fetch: (url, opts) => {
    fetchCalls.push({ url, opts });
    return Promise.resolve().then(() => fetchImpl(url, opts));
  },
};
sandbox.globalThis = sandbox;

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(
    (ok ? '  PASS  ' : '  FAIL  ') + label +
    (ok ? `  → ${JSON.stringify(actual)}` : `  → 实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`)
  );
}

/* ---------------- 加载 strings.js + app.js ----------------
   **strings.js 必须先加载。** app.js 在模块顶层就会用到 T()：
   FRIENDLY_DOMAINS 里那条 'local-files' 是 T('section.localFiles')，
   文件最后那行自启动的 renderDashboard() 也会走 applyStaticStrings()。
   少加载这一个文件，整套测试会因为 "T is not defined" 直接崩。 */
vm.createContext(sandbox);
const STRINGS_PATH = path.join(EXT, 'strings.js');
vm.runInContext(
  fs.readFileSync(STRINGS_PATH, 'utf8') +
  ';globalThis.__s={STRINGS,T,Tn,setLang,localeOf,applyStaticStrings,LANG_LOCALES,getLang:()=>LANG};',
  sandbox);
const S = sandbox.__s;

/* china-places.js 也要先加载：searchLocalPlaces 直接读 CHINA_PLACES 这个全局常量，
   跟 index.html 里 script 的先后顺序保持一致。加载后顺手把数据本身也暴露出来，
   PART 11 要对它做完整性断言。 */
vm.runInContext(
  fs.readFileSync(path.join(EXT, 'china-places.js'), 'utf8')
  + ';globalThis.__places=CHINA_PLACES;',
  sandbox);
const CHINA_PLACES = sandbox.__places;

vm.runInContext(code, sandbox);
const T = sandbox.__t;

/* =================================================================
   PART 1 — 子域归并 + 中文友好名
   ================================================================= */
console.log('\n[PART 1] 子域归并 / 友好域名');

const cases = [
  ['https://www.bilibili.com/video/BV1xx',       'bilibili.com',     'B站'],
  ['https://search.bilibili.com/all?kw=x',       'bilibili.com',     'B站'],
  ['https://space.bilibili.com/123',             'bilibili.com',     'B站'],
  ['https://t.bilibili.com/123',                 'bilibili.com',     'B站'],
  ['https://www.zhihu.com/question/1',           'zhihu.com',        '知乎'],
  ['https://zhuanlan.zhihu.com/p/1',             'zhihu.com',        '知乎'],
  ['https://juejin.cn/post/1',                   'juejin.cn',        '掘金'],
  ['https://www.juejin.cn/post/2',               'juejin.cn',        '掘金'],
  ['https://blog.csdn.net/x/article/details/1',  'csdn.net',         'CSDN'],
  ['https://www.xiaohongshu.com/explore',        'xiaohongshu.com',  '小红书'],
  // 不该被归并的对照组
  ['https://github.com/foo/bar',                 'github.com',       'GitHub'],
  ['https://mail.google.com/mail/u/0',           'mail.google.com',  'Gmail'],
  ['https://docs.google.com/document/d/1',       'docs.google.com',  'Google Docs'],
  ['https://news.ycombinator.com/item?id=1',     'news.ycombinator.com', 'Hacker News'],
  // TLD 剥离修复前的对照组：以前会显示成 "Example Cn"
  ['https://www.example.com.cn/a',               'www.example.com.cn', 'Example'],
];
for (const [url, wantKey, wantName] of cases) {
  const host = new URL(url).hostname;
  const rule = T.matchSiteMerge(url);
  const key  = rule ? rule.groupKey : host;
  const name = T.friendlyDomain(key);
  const ok   = key === wantKey && name === wantName;
  if (!ok) failed++;
  console.log(
    (ok ? '  PASS  ' : '  FAIL  ') + host.padEnd(26) +
    '| 分组键 ' + key.padEnd(22) + '| 显示名 ' + name.padEnd(14) +
    (ok ? '' : `期望: ${wantKey} / ${wantName}`)
  );
}
console.log('  归并规则条数:', T.SITE_MERGE_RULES.length);

/* =================================================================
   PART 2 — saveAllOpenTabs
   ================================================================= */
async function part2() {
  console.log('\n[PART 2] 批量存入 saveAllOpenTabs');

  const TO_URL = `chrome-extension://${EXT_ID}/index.html`;

  store.deferred = [
    // 已经在待办里 → 不该重复入库
    { id: 'old-a', url: 'https://a.com/1', title: 'A 已存在', savedAt: '2026-09-01T00:00:00Z', completed: false, dismissed: false },
    // 已删除 / 已归档 → 允许重新入库
    { id: 'old-d', url: 'https://d.com/4', title: 'D 曾删除', savedAt: '2026-09-01T00:00:00Z', completed: false, dismissed: true },
    { id: 'old-e', url: 'https://e.com/5', title: 'E 已归档', savedAt: '2026-09-01T00:00:00Z', completed: true,  dismissed: false },
  ];

  fakeTabs = [
    { id: 1, url: 'https://a.com/1',  title: 'A 已存在', windowId: 0 },
    { id: 2, url: 'https://b.com/2',  title: 'B',        windowId: 0 },
    { id: 3, url: 'https://c.com/3',  title: 'C',        windowId: 0 },
    { id: 4, url: 'https://c.com/3',  title: 'C 重复',   windowId: 0 },
    { id: 5, url: 'https://d.com/4',  title: 'D 曾删除', windowId: 0 },
    { id: 6, url: 'https://e.com/5',  title: 'E 已归档', windowId: 0 },
    { id: 7, url: 'chrome://newtab/', title: '新标签页', windowId: 0 },
    { id: 8, url: TO_URL,             title: '归拢',     windowId: 0 },
  ];
  await T.fetchOpenTabs();

  // 只存不关
  const r1 = await T.saveAllOpenTabs();
  // 候选 6 个（a/b/c/c重复/d/e），a 已存在跳过、c 第二次重复跳过 → 新增 4
  check('只存不关 added',   r1.added,   4);
  check('只存不关 skipped', r1.skipped, 2);

  const allIds = store.deferred.map(t => t.id);
  check('id 全局唯一', new Set(allIds).size, allIds.length);

  const activeUrls = (await T.getSavedTabs()).active.map(t => t.url).sort();
  check('待办 URL 集合', activeUrls, [
    'https://a.com/1', 'https://b.com/2', 'https://c.com/3',
    'https://d.com/4', 'https://e.com/5',
  ]);

  // 再来一次：全部已在待办里 → 一个都不加
  const r2 = await T.saveAllOpenTabs();
  check('重复调用 added', r2.added, 0);

  // 存完就关：候选标签页全部关掉（含因重复被 skip 的那条），
  // 但 chrome://newtab/ 和归拢自己不能动。
  fakeTabs.push({ id: 20, url: 'https://b.com/other-page', title: 'B 站的另一页', windowId: 0 });
  store.deferred = [];   // 清空待办，好让这次全部都能新存
  await T.fetchOpenTabs();
  const r3 = await T.saveAllOpenTabs({ closeAfter: true });

  check('存完就关 added',  r3.added,  6);
  check('存完就关 closed', r3.closed, 7);
  const leftIds = fakeTabs.map(t => t.id).sort((x, y) => x - y);
  check('关掉后剩下的 tab id（只剩非候选页）', leftIds, [7, 8]);

  // 已存在的重复也必须被关掉，否则标签栏清不干净
  store.deferred = [
    { id: 'pre', url: 'https://c.com/3', title: 'C 已在待办', savedAt: '2026-09-01T00:00:00Z', completed: false, dismissed: false },
  ];
  fakeTabs = [
    { id: 30, url: 'https://c.com/3', title: 'C 已在待办', windowId: 0 },   // 重复 → skip
    { id: 31, url: 'https://z.com/9', title: 'Z 新的',    windowId: 0 },   // 新存
    { id: 32, url: 'chrome://newtab/', title: '新标签页', windowId: 0 },
  ];
  await T.fetchOpenTabs();
  const r4 = await T.saveAllOpenTabs({ closeAfter: true });

  check('重复条目 added',  r4.added,   1);
  check('重复条目 skipped', r4.skipped, 1);
  check('重复条目 closed', r4.closed,  2);
  check('重复条目关闭后剩余', fakeTabs.map(t => t.id), [32]);

  // closeAfter=0 时一个都不许关
  store.deferred = [];
  fakeTabs = [{ id: 40, url: 'https://keep.com/1', title: 'Keep', windowId: 0 }];
  await T.fetchOpenTabs();
  await T.saveAllOpenTabs();
  check('只存不关时标签页原样保留', fakeTabs.map(t => t.id), [40]);
}

/* =================================================================
   PART 3 — 常用站点条（手动钉住 + topSites 自动补足）
   ================================================================= */
async function part3() {
  console.log('\n[PART 3] 常用站点');

  // --- 用户输入 → 可用 URL ---
  const norm = [
    ['github.com',                   'https://github.com/'],
    ['  juejin.cn/post/1  ',         'https://juejin.cn/post/1'],
    ['https://news.ycombinator.com', 'https://news.ycombinator.com/'],
    ['http://a.com',                 'http://a.com/'],
    ['javascript:alert(1)',          null],
    ['data:text/html,<h1>x</h1>',    null],
    ['',                             null],
    ['   ',                          null],
    ['localhost',                    null],
    ['随便打的字',                    null],
  ];
  for (const [input, want] of norm) {
    check('normalizeSiteUrl ' + JSON.stringify(input), T.normalizeSiteUrl(input), want);
  }

  // --- 站点身份：按 hostname，忽略 www. ---
  check('siteKey 忽略 www.',   T.siteKey('https://www.bilibili.com/video/BV1'), 'bilibili.com');
  check('siteKey 不跨子域',    T.siteKey('https://search.bilibili.com/x'),      'search.bilibili.com');

  // --- 显示名 ---
  check('友好名优先（B站）',
    T.siteLabel({ url: 'https://www.bilibili.com/', title: '哔哩哔哩 (゜-゜)つロ 干杯~' }), 'B站');
  check('友好名 ≤12 字符直接用',
    T.siteLabel({ url: 'https://news.ycombinator.com/', title: 'Hacker News' }), 'Hacker News');
  check('Gmail 不被页面标题顶掉',
    T.siteLabel({ url: 'https://mail.google.com/mail/u/0', title: '收件箱' }), 'Gmail');
  check('长友好名改用站点标题',
    T.siteLabel({ url: 'https://news.ycombinator.co.uk/', title: '我的博客' }), '我的博客');

  // --- 合并：钉住的在前，自动部分去重 + 排隐藏 ---
  store.pinnedSites   = [{ url: 'https://github.com/', title: 'GitHub', addedAt: '2026-09-01T00:00:00Z' }];
  store.hiddenTopSites = ['zhihu.com'];
  topSites = [
    { url: 'https://www.bilibili.com/', title: '哔哩哔哩' },
    { url: 'https://www.github.com/',   title: 'GitHub' },      // 与钉住的 hostname 等价 → 跳过
    { url: 'chrome://settings/',        title: '设置' },         // 非 http → 跳过
    { url: 'https://www.zhihu.com/hot', title: '知乎热榜' },      // 在隐藏名单 → 跳过
    { url: 'https://juejin.cn/',        title: '掘金' },
  ];

  let sites = await T.getQuickSites();
  check('合并后条数', sites.length, 3);
  check('钉住的排第一', sites[0].url, 'https://github.com/');
  check('钉住的带 pinned 标记', sites[0].pinned, true);
  check('自动补足的 URL', sites.slice(1).map(s => s.url),
    ['https://www.bilibili.com/', 'https://juejin.cn/']);
  check('自动项 pinned=false', sites[1].pinned, false);

  // --- 钉住 ---
  check('钉重复 → duplicate', (await T.pinSite({ url: 'www.github.com' })).reason, 'duplicate');
  check('钉伪协议 → bad-url', (await T.pinSite({ url: 'javascript:x' })).reason,   'bad-url');
  check('钉垃圾输入 → bad-url', (await T.pinSite({ url: '!!!' })).reason,           'bad-url');

  // 钉一个原本在隐藏名单里的站点，应该顺手把它放出来
  check('钉新站点成功', (await T.pinSite({ url: 'zhihu.com', title: '知乎' })).ok, true);
  check('钉住后从隐藏名单放出', store.hiddenTopSites, []);
  check('钉住的按加入顺序排在前',
    (await T.getQuickSites()).slice(0, 2).map(s => s.url),
    ['https://github.com/', 'https://zhihu.com/']);

  // --- 移除：按入口删，不能按 hostname 一删一串 ---
  await T.hideTopSite('https://juejin.cn/post/1');
  check('隐藏按 hostname 记', store.hiddenTopSites, ['juejin.cn']);
  check('隐藏后只剩 bilibili',
    (await T.getQuickSites()).map(s => s.url),
    ['https://github.com/', 'https://zhihu.com/', 'https://www.bilibili.com/']);

  await T.unpinSite('https://zhihu.com/');
  check('取消钉住删掉指定入口', store.pinnedSites.map(s => s.url), ['https://github.com/']);

  // --- 点击语义：只认「同一个入口」，不能把正文页当入口切过去 ---
  check('sameEntryUrl 忽略 www.',  T.sameEntryUrl('https://bilibili.com/', 'https://www.bilibili.com/'), true);
  check('sameEntryUrl 忽略末尾斜杠', T.sameEntryUrl('https://bilibili.com', 'https://bilibili.com/'), true);
  check('sameEntryUrl 忽略 hash',  T.sameEntryUrl('https://a.com/x', 'https://a.com/x#s'), true);
  check('sameEntryUrl 忽略 utm',   T.sameEntryUrl('https://a.com/x', 'https://a.com/x?utm_source=weibo'), true);
  check('sameEntryUrl 区分路径',   T.sameEntryUrl('https://bilibili.com/', 'https://bilibili.com/video/BV1'), false);
  check('sameEntryUrl 空值不匹配', T.sameEntryUrl('', 'https://bilibili.com/'), false);

  // 用户报的第一个 bug：图标钉的是主页，但正开着该站的一个视频页。
  // 以前按 hostname 找会切到视频页 —— 所以现在干脆永远新开。
  const createBefore1 = created.length;
  fakeTabs = [{ id: 77, url: 'https://www.bilibili.com/video/BV1', windowId: 3 }];
  check('同站正文页开着 → 还是新开', await T.openQuickSite('https://bilibili.com/'), 'opened');
  check('新开的是主页', created[createBefore1].url, 'https://bilibili.com/');

  // 用户报的第二个问题：入口本身已经开着，点站点条也不该跳过去，要新开一个
  const focusBefore  = focused.length;
  const createBefore2 = created.length;
  fakeTabs = [{ id: 78, url: 'https://www.bilibili.com/', windowId: 3 }];
  check('入口已开着 → 依然新开', await T.openQuickSite('https://bilibili.com/'), 'opened');
  check('确实新开了一个', created.length, createBefore2 + 1);
  check('没有去切已开的那个 tab', focused.length, focusBefore);

  const createBefore = created.length;
  fakeTabs = [];
  check('该站没开 → opened', await T.openQuickSite('https://sspai.com/'), 'opened');
  check('新开的 URL', created[createBefore].url, 'https://sspai.com/');

  const createBefore3 = created.length;
  check('空 url 不白开一个标签页', await T.openQuickSite(''), 'none');
  check('确实没开', created.length, createBefore3);

  // --- 自动部分削成入口：topSites 给的深链不能直接当图标目的地 ---
  // 图标底下写着「GitHub」，点下去却进到某个具体仓库，就跟标签对不上了。
  store.pinnedSites = [];
  store.hiddenTopSites = [];
  topSites = [
    { url: 'https://github.com/qwsir32-star/guilong', title: 'qwsir32-star/guilong' },
    { url: 'https://www.bilibili.com/video/BV1',      title: '某个视频' },
    { url: 'chrome://bookmarks/',                     title: '书签' },
  ];
  check('自动项削成站点入口',
    (await T.getQuickSites()).map(s => s.url),
    ['https://github.com/', 'https://www.bilibili.com/']);

  // --- 官网 vs 具体页面：识别 ---
  check('首页 github.com',        T.isSiteRoot('https://github.com/'),              true);
  check('首页带末尾斜杠',          T.isSiteRoot('https://www.bilibili.com/'),         true);
  check('带路径不算首页',          T.isSiteRoot('https://github.com/features/actions'), false);
  check('带查询不算首页',          T.isSiteRoot('https://www.douyu.com/6657?dyshid=x'), false);
  check('带 hash 不算首页',        T.isSiteRoot('https://a.com/#top'),               false);

  check('路径提示取路径',          T.pathHintOf('https://github.com/features/actions'), 'features/actions');
  check('路径提示取查询',          T.pathHintOf('https://www.douyu.com/6657?dyshid=abc'), '6657');

  // 官网 → 友好名
  fakeTabs = [];
  check('官网用友好名',            (await T.suggestSiteName('https://github.com/')).name, 'GitHub');
  check('官网标记 source=root',    (await T.suggestSiteName('https://bilibili.com/')).source, 'root');

  // 具体页面且正开着 → 用网页标题
  fakeTabs = [{ id: 5, url: 'https://www.douyu.com/6657?dyshid=c57416e', title: '玩机器直播间 - 斗鱼', windowId: 0 }];
  let sug = await T.suggestSiteName('https://www.douyu.com/6657?dyshid=c57416e');
  check('具体页面用网页标题', sug.name, '玩机器直播间 - 斗鱼');
  check('标记 source=tab',    sug.source, 'tab');

  // 具体页面但没开着 → 友好名 + 路径提示（至少要诚实，别看着像首页）
  fakeTabs = [];
  sug = await T.suggestSiteName('https://www.douyu.com/6657');
  check('没开着时带路径提示', sug.name, 'Douyu · 6657');
  check('标记 source=guess',  sug.source, 'guess');

  // --- 用户报的 bug：钉了官网之后，同站的具体页面也要能钉 ---
  store.pinnedSites = [{ url: 'https://github.com/', title: 'GitHub', icon: '', addedAt: '2026-09-01T00:00:00Z' }];
  const deepPin = await T.pinSite({
    url: 'https://github.com/features/actions', title: 'Actions 文档', icon: '',
  });
  check('官网之后同站深链仍可钉', deepPin.ok, true);
  check('两个入口都在', store.pinnedSites.map(s => s.url),
    ['https://github.com/', 'https://github.com/features/actions']);

  // 真正的重复还是得挡住（只有 www. / 末尾斜杠的差异）
  check('等价入口仍判重', (await T.pinSite({ url: 'https://www.github.com/' })).reason, 'duplicate');
  check('同站不同深链各自独立',
    (await T.pinSite({ url: 'https://github.com/features/copilot' })).ok, true);

  // 两个入口同时存在时，× 只该删掉点的那一个
  await T.unpinSite('https://github.com/features/actions');
  check('删深链不动官网', store.pinnedSites.map(s => s.url),
    ['https://github.com/', 'https://github.com/features/copilot']);

  // --- 显示名：手动钉住的名称以用户/抓取结果为准，不被域名猜的名字顶掉 ---
  check('钉住的用自己填的名称',
    T.siteLabel({ url: 'https://www.douyu.com/6657', title: '玩机器直播间', pinned: true }), '玩机器直播间');
  check('钉住的名称过长截断',
    T.siteLabel({ url: 'https://a.com/x', title: '这是一个超过十二个字的超长名称', pinned: true }), '这是一个超过十二个字的超…');
  check('钉住但名称为空时退回友好名',
    T.siteLabel({ url: 'https://bilibili.com/', title: '', pinned: true }), 'B站');

  // --- 图标：留空自动 / 图片地址 / 文字 ---
  let ico = T.resolveSiteIcon({ url: 'https://github.com/', icon: '' }, 'GitHub');
  check('图标留空 → 自动 favicon', ico.img.startsWith(`chrome-extension://${EXT_ID}/_favicon/`), true);
  check('图标留空 → 带回退 host',   ico.host, 'github.com');
  check('图标留空 → 首字母',        ico.letter, 'G');

  ico = T.resolveSiteIcon({ url: 'https://a.com/', icon: 'https://cdn.example/logo.png' }, 'A站');
  check('图标填图片地址 → 用这张图', ico.img, 'https://cdn.example/logo.png');
  check('自定义图不回退 s2',        ico.host, '');

  ico = T.resolveSiteIcon({ url: 'https://a.com/', icon: '播' }, '某某');
  check('图标填文字 → 无 img',      ico.img, '');
  check('图标填文字 → 用文字',      ico.letter, '播');

  ico = T.resolveSiteIcon({ url: 'https://a.com/', icon: 'AB' }, '某某');
  check('文字图标最多 2 个字符',    ico.letter, 'AB');

  // --- 合并渲染：同一 hostname 的手动入口不该被自动部分顶掉 ---
  store.pinnedSites = [{ url: 'https://github.com/features/actions', title: 'Actions', icon: '', addedAt: '2026-09-01T00:00:00Z' }];
  store.hiddenTopSites = [];
  topSites = [{ url: 'https://github.com/', title: 'GitHub' }];
  check('钉的是深链，自动的官网不再重复出现',
    (await T.getQuickSites()).map(s => s.url),
    ['https://github.com/features/actions']);

  // --- 没授予 topSites 权限时要降级，不能整条崩掉 ---
  store.pinnedSites = [{ url: 'https://sspai.com/', title: '', addedAt: '2026-09-01T00:00:00Z' }];
  const realTopSites = sandbox.chrome.topSites;
  sandbox.chrome.topSites = { get: async () => { throw new Error('no permission'); } };
  check('无 topSites 权限时只剩钉住的',
    (await T.getQuickSites()).map(s => s.url), ['https://sspai.com/']);
  sandbox.chrome.topSites = realTopSites;
}

/* =================================================================
   PART 4 — openAllSavedTabs
   ================================================================= */
async function part4() {
  console.log('\n[PART 4] 批量打开 openAllSavedTabs');

  const before = created.length;
  const opened = await T.openAllSavedTabs();

  const activeCount = (await T.getSavedTabs()).active.length;
  check('打开条数 = 待办条数', opened, activeCount);
  check('全部后台打开（不抢焦点）', created.slice(before).every(c => c.active === false), true);
}

/* =================================================================
   PART 5 — 编辑已钉住的条目 + 拖拽重排 + 把自动项钉下来
   ================================================================= */
const P = (url, title = '', icon = '') => ({ url, title, icon, addedAt: '2026-09-01T00:00:00Z' });
const urlsOf = () => store.pinnedSites.map(s => s.url);

async function part5() {
  console.log('\n[PART 5] 编辑 / 拖拽重排 / 钉下自动项');

  /* --- updatePinnedSite：改内容但不改顺序 --- */
  store.pinnedSites = [P('https://a.com/', 'A'), P('https://b.com/', 'B'), P('https://c.com/', 'C')];
  store.hiddenTopSites = [];

  let res = await T.updatePinnedSite('https://b.com/', { url: 'https://b.com/', title: 'B站改名了', icon: '播' });
  check('改中间一项 → 成功',            res.ok, true);
  check('改内容不挪位置',                urlsOf(), ['https://a.com/', 'https://b.com/', 'https://c.com/']);
  check('标题已更新',                    store.pinnedSites[1].title, 'B站改名了');
  check('图标已更新',                    store.pinnedSites[1].icon, '播');

  res = await T.updatePinnedSite('https://b.com/', { url: 'javascript:alert(1)', title: 'x' });
  check('改成一个非 http 地址 → bad-url', res.reason, 'bad-url');
  check('失败时不落盘',                   urlsOf(), ['https://a.com/', 'https://b.com/', 'https://c.com/']);

  res = await T.updatePinnedSite('https://nope.com/', { url: 'https://nope.com/', title: 'x' });
  check('改一个不存在的条目 → missing',   res.reason, 'missing');

  res = await T.updatePinnedSite('https://a.com/', { url: 'https://c.com/', title: '想撞车' });
  check('改成一个已存在的入口 → duplicate', res.reason, 'duplicate');
  check('撞车时不落盘',                   urlsOf(), ['https://a.com/', 'https://b.com/', 'https://c.com/']);

  // 用户把钉住的 github.com 改成 github.com/features/actions，
  // 两者是不同的「入口」，不该被当成重复
  store.pinnedSites = [P('https://github.com/', 'GitHub'), P('https://b.com/', 'B')];
  res = await T.updatePinnedSite('https://github.com/', { url: 'https://github.com/features/actions', title: 'Actions' });
  check('同站不同路径不算重复',           res.ok, true);
  check('链接确实换掉了',                 urlsOf()[0], 'https://github.com/features/actions');

  // 改到的新站点如果在「不再显示」名单里，要把它放出来
  store.hiddenTopSites = ['newplace.com'];
  await T.updatePinnedSite('https://b.com/', { url: 'https://newplace.com/', title: 'New' });
  check('改链接后新站点被移出隐藏名单',   store.hiddenTopSites, []);

  /* --- movePinnedSite：拖拽重排 --- */
  store.pinnedSites = [P('https://a.com/', 'A'), P('https://b.com/', 'B'), P('https://c.com/', 'C')];

  check('把 A 拖到 B 后面 → 顺序变了',    await T.movePinnedSite('https://a.com/', 'https://b.com/', true), true);
  check('  结果顺序',                     urlsOf(), ['https://b.com/', 'https://a.com/', 'https://c.com/']);

  check('把 C 拖到最前（B 之前）',        await T.movePinnedSite('https://c.com/', 'https://b.com/', false), true);
  check('  结果顺序',                     urlsOf(), ['https://c.com/', 'https://b.com/', 'https://a.com/']);

  check('拖回原位判定为「没变」，不白写',  await T.movePinnedSite('https://c.com/', 'https://b.com/', false), false);
  check('  顺序没被动过',                 urlsOf(), ['https://c.com/', 'https://b.com/', 'https://a.com/']);

  // 拖到自动补的站点上：目标不在 pinnedSites 里，落到钉住区末尾
  check('拖到自动项上 → 落到末尾',        await T.movePinnedSite('https://c.com/', 'https://top.example/', false), true);
  check('  结果顺序',                     urlsOf(), ['https://b.com/', 'https://a.com/', 'https://c.com/']);

  check('拖一个不在列表里的',             await T.movePinnedSite('https://zzz.com/', 'https://b.com/', false), false);

  // 顺序变了但条目内容不能丢
  check('重排后条目内容原样保留',         store.pinnedSites.map(s => s.title), ['B', 'A', 'C']);

  /* --- promoteTopSite：把自动补的钉下来 --- */
  store.pinnedSites = [P('https://a.com/', 'A')];
  store.hiddenTopSites = [];
  topSites = [{ url: 'https://github.com/', title: 'GitHub' }];

  res = await T.promoteTopSite('https://github.com/');
  check('钉下一个自动项 → 成功',          res.ok, true);
  check('追加在末尾',                     urlsOf(), ['https://a.com/', 'https://github.com/']);
  check('名称沿用当前显示的',             store.pinnedSites[1].title, 'GitHub');

  res = await T.promoteTopSite('https://github.com/');
  check('再钉一次 → duplicate',           res.reason, 'duplicate');

  res = await T.promoteTopSite('不是网址');
  check('钉一个非法地址 → bad-url',       res.reason, 'bad-url');

  // topSites 给的是深链时，钉下来的是削过的站点入口
  store.pinnedSites = [];
  topSites = [{ url: 'https://github.com/someone/repo', title: 'some/repo' }];
  const shown = (await T.getQuickSites())[0];
  await T.promoteTopSite(shown.url);
  check('深链被削成站点入口后再钉',       urlsOf(), ['https://github.com/']);
}

/* =================================================================
   PART 6 — 识别「Chrome 给的是默认占位图」
   ================================================================= */
async function part6() {
  console.log('\n[PART 6] 默认占位图识别（小红书那类没有图标的站）');

  imgPixels.set(DEFAULT_KEY, [9, 9, 9, 255, 9, 9, 9, 255]);
  imgPixels.set('github.com', [1, 2, 3, 255, 4, 5, 6, 255]);

  // 基准指纹是运行时拿一个必然不存在的域名现求的，不能硬编码某张图的哈希
  const defSig = await T.faviconSignature('https://guilong-no-such-site.invalid/');
  check('取得默认占位图的基准指纹', typeof defSig === 'string' && defSig.length > 0, true);

  const realSig = await T.faviconSignature('https://github.com/');
  check('真图标的指纹与基准不同', !!realSig && realSig !== defSig, true);

  check('图加载失败 → 指纹为 null（当作「不知道」）',
    await T.faviconSignature('https://unregistered.example/'), null);

  // --- dropIfDefaultFavicon 的三种情形 ---
  removedImages.length = 0;
  await T.dropIfDefaultFavicon(fakeLoadedImage('https://x.com/icon', imgPixels.get(DEFAULT_KEY)));
  check('内容是默认占位图 → 删掉它，露出底下的首字母',
    removedImages.length, 1);

  removedImages.length = 0;
  await T.dropIfDefaultFavicon(fakeLoadedImage('https://x.com/icon', imgPixels.get('github.com')));
  check('内容是真图标 → 保留', removedImages.length, 0);

  // 最后这条是安全网：读不出像素时宁可多显示一个地球，也不要因为猜错把真图标删了
  removedImages.length = 0;
  await T.dropIfDefaultFavicon(fakeLoadedImage('https://x.com/icon', null));
  check('读不出像素 → 一动不动', removedImages.length, 0);
}

/* =================================================================
   PART 7 — 模块开关 + 搜索框
   ================================================================= */
async function part7() {
  console.log('\n[PART 7] 模块开关 / 搜索框');

  /* --- 开关的读写 --- */
  delete store.uiPrefs;
  check('没设置过时读默认值（三个都开）',
    await T.getUiPrefs(),
    { showQuickSites: true, showSearchBox: true, showWeather: true });

  await T.setUiPref('showQuickSites', false);
  check('关掉站点条后读回来是关的', (await T.getUiPrefs()).showQuickSites, false);

  // 老用户的存储里可能只有新增开关之前存的那一半键，缺的必须补默认值。
  // 天气开关就是这么加进来的：加它之前存过设置的人，存储里没有 showWeather，
  // 读到的必须是 true 而不是 undefined —— undefined 会让那个勾选框处于半死状态。
  store.uiPrefs = { showQuickSites: false };
  check('缺的键自动补默认值',
    await T.getUiPrefs(),
    { showQuickSites: false, showSearchBox: true, showWeather: true });

  await T.setUiPref('不存在的开关', false);
  check('未声明的开关不许写进去', Object.keys(await T.getUiPrefs()).sort(),
    ['showQuickSites', 'showSearchBox', 'showWeather']);

  /* --- 开关落到 DOM 上 --- */
  domNodes.set('quickSites', fakeDomNode());
  domNodes.set('searchBar',  fakeDomNode());
  domNodes.set('searchInput', fakeDomNode());
  settingInputs.length = 0;
  settingInputs.push(
    { dataset: { setting: 'showQuickSites' }, checked: true },
    { dataset: { setting: 'showSearchBox'  }, checked: true },
  );

  store.uiPrefs = { showQuickSites: false, showSearchBox: true };
  await T.applyUiPrefs();
  check('站点条被隐藏', domNodes.get('quickSites').style.display, 'none');
  check('搜索框保持显示', domNodes.get('searchBar').style.display, '');
  check('开关勾选状态跟着走 → 站点条没勾',
    settingInputs.map(i => i.checked), [false, true]);

  // 聚焦是独立的一步：applyUiPrefs 只管「显示成什么样」。
  // 用户点设置面板里那个开关时，光标不该被抢到搜索框去。
  check('applyUiPrefs 不会自己抢光标',
    domNodes.get('searchInput').focusCount === undefined, true);
  check('applyUiPrefs 把读到的开关返回出来',
    await T.applyUiPrefs(),
    { showQuickSites: false, showSearchBox: true, showWeather: true });

  T.focusSearchBox();
  check('focusSearchBox 把光标放进搜索框',
    domNodes.get('searchInput').focusCount, 1);

  store.uiPrefs = { showQuickSites: true, showSearchBox: false };
  await T.applyUiPrefs();
  check('站点条显示回来', domNodes.get('quickSites').style.display, '');
  check('搜索框被隐藏', domNodes.get('searchBar').style.display, 'none');

  /* --- looksLikeUrl：网址 vs 搜索词 --- */
  check('裸域名算网址',        T.looksLikeUrl('github.com'),         true);
  check('带协议算网址',        T.looksLikeUrl('https://a.com/x'),    true);
  check('带路径算网址',        T.looksLikeUrl('a.com/x/y?z=1'),      true);
  check('localhost 算网址',    T.looksLikeUrl('localhost:3000'),     true);
  check('带空格的算搜索词',    T.looksLikeUrl('怎么学 react'),        false);
  check('一个词不算网址',      T.looksLikeUrl('react'),              false);
  check('中文搜索词',          T.looksLikeUrl('今天天气怎么样'),      false);

  /* --- runSearch --- */
  const beforeSearch = created.length;
  searchCalls.length = 0;

  await T.runSearch('github.com');
  check('输入网址 → 直接打开，不搜索', created.length, beforeSearch + 1);
  check('  补上了 https',  created[beforeSearch].url, 'https://github.com');
  check('  没有调搜索引擎', searchCalls.length, 0);

  await T.runSearch('怎么学 react');
  check('输入关键词 → 交给默认搜索引擎', searchCalls.length, 1);
  check('  查询词原样传过去', searchCalls[0].text, '怎么学 react');
  check('  在新标签页打开（不替掉当前仪表盘）', searchCalls[0].disposition, 'NEW_TAB');

  const beforeEmpty = created.length;
  searchCalls.length = 0;
  await T.runSearch('   ');
  check('空输入什么也不做',
    [created.length, searchCalls.length], [beforeEmpty, 0]);

  /* --- 兜底：chrome.search 用不了的时候 --- */
  const realSearch = sandbox.chrome.search;

  sandbox.chrome.search = { query: async () => { throw new Error('nope'); } };
  const beforeFail = created.length;
  await T.runSearch('兜底测试');
  check('chrome.search 抛错 → 退回必应', created.length, beforeFail + 1);
  check('  退的是必应而不是 google',
    created[beforeFail].url.startsWith('https://www.bing.com/search?q='), true);

  delete sandbox.chrome.search;
  const beforeGone = created.length;
  await T.runSearch('没有 search api');
  check('chrome.search 整个不存在 → 也退回必应',
    created.length, beforeGone + 1);

  sandbox.chrome.search = realSearch;
}

/* ---------------- PART 8：页头版式回归守卫 ----------------
   页头是「三栏网格 + 靠设置开关切孩子 display」的结构。
   只要哪个孩子没写死 grid-column，它一旦被 display:none 关掉就会退出网格，
   后面的兄弟随即被自动排布顶到别的栏 —— 表现就是「开关搜索框，齿轮左右跳」。
   这条守卫就是防止以后有人把这几个 grid-column 顺手删掉。 */
function part8() {
  console.log('\n【PART 8】页头三栏：每个孩子都必须显式指定栏位');
  const css = fs.readFileSync(path.join(EXT, 'style.css'), 'utf8');
  const base = css.split('@media')[0].replace(/\/\*[\s\S]*?\*\//g, '');

  const colOf = sel => {
    const m = base.match(new RegExp('\\.' + sel + '\\s*\\{[^}]*?grid-column:\\s*([^;]+)'));
    return m ? m[1].trim() : null;
  };

  check('页头是三栏网格（含 540px 中间栏）',
    /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*540px\s*minmax\(0,\s*1fr\)/.test(base), true);
  check('问候语固定在第 1 栏', colOf('header-left'), '1');
  check('搜索框固定在第 2 栏', colOf('search-bar'), '2');
  check('齿轮固定在第 3 栏（搜索框藏起来时不许被顶走）', colOf('header-settings'), '3');

  // 窄屏降级版式同样不能靠自动排布
  const narrow = css.slice(css.indexOf('@media (max-width: 1040px)'),
                          css.indexOf('@media (max-width: 800px)'));
  check('窄屏 · 搜索框横跨整行',
    /\.search-bar\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/.test(narrow), true);
  check('窄屏 · 齿轮固定在第 2 栏',
    /\.header-settings\s*\{[^}]*grid-column:\s*2/.test(narrow), true);
}

/* ---------------- PART 9：文案表 ----------------
   守两件事：
   1. 表本身自洽 —— 中英词目一一对应、没有空值、占位符两边一致。
   2. **代码里没有绕开表写死的界面文案。** 这才是会复发的那种 bug：新加功能时
      顺手在模板字符串里写一句中文，页面看着是对的、测试全过，但那一句从此
      不在表里 —— 以后切语言或统一改措辞时必然漏掉它。
   ------------------------------------------------------------------ */
function part9() {
  console.log('\n【PART 9】文案表 STRINGS');
  const zh = S.STRINGS.zh, en = S.STRINGS.en;
  const zhKeys = Object.keys(zh), enKeys = Object.keys(en);

  /* ---- 表本身 ---- */
  check('中英词目数量一致', zhKeys.length, enKeys.length);
  check('英文表没有多余词目', enKeys.filter(k => !(k in zh)), []);
  check('英文表没有漏译词目', zhKeys.filter(k => !(k in en)), []);
  check('没有空文案', zhKeys.filter(k => !String(zh[k]).trim() || !String(en[k]).trim()), []);

  const ph = s => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
  check('中英占位符一一对应',
    zhKeys.filter(k => ph(zh[k]) !== ph(en[k])).map(k => `${k}: zh[${ph(zh[k])}] en[${ph(en[k])}]`), []);

  /* ---- 取词行为 ---- */
  check('T 取中文', S.T('pin.cancel'), '取消');
  check('T 填一个占位符', S.T('toast.batchSaved', { n: 3 }), '已存入 3 个标签页');
  check('T 填多个占位符', S.T('toast.batchSavedAndClosed', { added: 2, closed: 5 }), '已存入 2 个、关闭 5 个标签页');
  check('未知 key 原样返回、不抛错', S.T('根本没这条'), '根本没这条');
  check('缺变量时占位符保持原样（不变成 undefined）', S.T('toast.batchSaved'), '已存入 {n} 个标签页');
  check('Tn 单数走第一条', S.Tn('badge.tabOpen', 'badge.tabsOpen', 1), '1 个标签页');
  check('Tn 复数走第二条', S.Tn('badge.tabOpen', 'badge.tabsOpen', 3), '3 个标签页');

  S.setLang('en');
  check('切英文：文案跟着变', S.T('pin.cancel'), 'Cancel');
  check('切英文：Tn 用英文单数', S.Tn('badge.tabOpen', 'badge.tabsOpen', 1), '1 tab open');
  check('切英文：日期区域跟着变', S.localeOf(), 'en-US');
  S.setLang('不存在的语言');
  check('未知语言被忽略、不把界面搞空白', S.getLang(), 'en');
  S.setLang('zh');
  check('切回中文', S.T('pin.cancel'), '取消');
  check('中文日期区域', S.localeOf(), 'zh-CN');

  /* ---- data-i18n 真的落到 DOM 上 ---- */
  const mk = extra => Object.assign(
    { dataset: {}, style: {}, textContent: '', innerHTML: '', placeholder: '', title: '' }, extra);
  const elText  = mk({ dataset: { i18n: 'pin.cancel' } });
  const elPh    = mk({ dataset: { i18nPlaceholder: 'search.placeholder' } });
  const elTitle = mk({ dataset: { i18nTitle: 'pin.unpinTitle' } });
  const elHtml  = mk({ dataset: { i18nHtml: 'dupeBanner.text' } });
  selectorMap.set('[data-i18n]', [elText]);
  selectorMap.set('[data-i18n-placeholder]', [elPh]);
  selectorMap.set('[data-i18n-title]', [elTitle]);
  selectorMap.set('[data-i18n-html]', [elHtml]);
  fakeRoot.lang = '';
  S.applyStaticStrings(sandbox.document);
  check('data-i18n → textContent', elText.textContent, '取消');
  check('data-i18n-placeholder → placeholder', elPh.placeholder, '搜索，或输入网址直接打开');
  check('data-i18n-title → title', elTitle.title, '取消钉住');
  check('data-i18n-html → innerHTML（数字留给 JS 填）',
    elHtml.innerHTML, '你现在开着 <strong>{count}</strong> 个归拢标签页，只留当前这一个？');
  check('<html lang> 跟着语言改', fakeRoot.lang, 'zh-CN');
  selectorMap.clear();

  /* ---- 静态扫描：文案有没有绕开表 ---- */
  const APP_SRC  = fs.readFileSync(APP, 'utf8');
  const HTML_SRC = srcOf('index.html');

  const htmlKeys = [];
  for (const attr of ['data-i18n', 'data-i18n-html', 'data-i18n-placeholder', 'data-i18n-title']) {
    for (const m of HTML_SRC.matchAll(new RegExp(attr + '="([^"]+)"', 'g'))) htmlKeys.push([attr, m[1]]);
  }
  check('index.html 用了 i18n 标记', htmlKeys.length >= 20, true);
  check('index.html 的 key 全部存在于表中', htmlKeys.filter(([, k]) => !(k in zh)), []);

  const used = [];
  for (const m of APP_SRC.matchAll(/\bT\(\s*'([^']+)'/g)) used.push(m[1]);
  for (const m of APP_SRC.matchAll(/\bTn\(\s*'([^']+)'\s*,\s*'([^']+)'/g)) used.push(m[1], m[2]);
  const usedSet = [...new Set(used)];
  check('app.js 引用的 key 全部存在于表中', usedSet.filter(k => !(k in zh)), []);
  check('app.js 确实在走文案表（引用了足够多的 key）', usedSet.length >= 50, true);

  /* 写死的中文界面文案 —— 评论、console 日志、站点名对照表除外。
     先把块注释与行注释挖空（保住行号），再逐行找中文。 */
  const stripped = APP_SRC.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
                          .split('\n').map(l => l.replace(/(^|[^:'"\\])\/\/.*$/, '$1'));
  // FRIENDLY_DOMAINS 那些是「域名 → 网站自己的名字」，属于数据不是文案，整块跳过
  const mapA = APP_SRC.indexOf('const FRIENDLY_DOMAINS');
  const mapB = APP_SRC.indexOf('\n};', mapA);
  const mapFrom = APP_SRC.slice(0, mapA).split('\n').length;
  const mapTo   = APP_SRC.slice(0, mapB).split('\n').length;
  const cjk = [];
  stripped.forEach((line, i) => {
    const n = i + 1;
    if (n >= mapFrom && n <= mapTo) return;              // 域名对照表
    if (!/[\u4e00-\u9fff]/.test(line)) return;
    if (/console\.(log|warn|error)/.test(line)) return;   // 开发日志
    if (/\bT\(/.test(line)) return;                      // 走表的
    cjk.push(n + ': ' + line.trim().slice(0, 62));
  });
  check('没有绕开文案表写死的中文文案', cjk, []);

  /* 英文黑名单：这些句子以前是写死在代码里的，现在只许出现在文案表里。
     注意要拿**挖掉注释的代码**去比 —— 这次就栽在这里：新加的那条说明注释里
     正好引用了旧写法 `badge.textContent.includes('duplicate')`，
     拿原文去测会把它自己当成「还没改」。 */
  const codeOnly = stripped.join('\n');
  const BANNED = [
    "'just now'", "'Homepages'", "'No results'", "'Dismiss'", "'Save for later'",
    "'Close this tab'", "'Open tabs'", "'Saved for later'", "'Close extras'",
    "'Tab Out tabs open'", "' mins ago'", "' days ago'",
  ];
  check('没有重新写死的英文界面文案',
    BANNED.filter(b => codeOnly.includes(b) || HTML_SRC.includes(b)), []);

  check('「关掉重复」不再靠文案判断，改用 data-badge',
    /badge\.dataset\.badge === 'dupes'/.test(codeOnly)
      && !/textContent\.includes\('duplicate'\)/.test(codeOnly), true);

  /* ---- 品牌守卫：改名为「归拢」之后，源码里不许再残留旧名 ----
     注意 app.js 里的 TabOut / tabOutTabs / tabOutDupeBanner 是**有意保留的
     标识符**（DOM id 与函数名，跟着改只会出事），它们写作 TabOut、不带空格，
     所以 /Tab Out/ 这个模式扫不到它们，正好。 */
  const MANIFEST = JSON.parse(srcOf('manifest.json'));
  const brandLeak = [];
  for (const f of ['app.js', 'background.js', 'index.html', 'strings.js', 'manifest.json']) {
    srcOf(f).split('\n').forEach((line, i) => {
      if (/zarazhangrui/.test(line)) return;   // 上游署名与上游链接里的旧名是合法的
      if (/Tab Out/.test(line)) brandLeak.push(`${f} L${i + 1}`);
    });
  }
  check('源码里没有残留旧品牌名 Tab Out', brandLeak, []);
  check('manifest 用的是新名字', MANIFEST.name.includes('归拢'), true);
  check('manifest 的 action 标题也是新名字', MANIFEST.action.default_title, '归拢');
  /* 版本号守卫：它只有一个用处 —— 在 chrome://extensions 的卡片上告诉人
     「我现在跑的是哪一版」，也就是「刚才那次重载到底成功没有」。
     一旦它不合法或不见了，这个唯一的信号就没了。 */
  check('manifest 有合法版本号（改完顺手 bump，它就是重载成功的信号）',
    /^\d+\.\d+\.\d+$/.test(MANIFEST.version || ''), true);
  // 这条守卫是踩坑换来的：manifest 没有 key 时，Chrome 用**目录绝对路径**算扩展 ID，
  // 改个目录名就会换 ID → chrome.storage 里的用户数据全部读不到。
  // 删掉 key 不会有任何报错，只会静默丢数据，所以必须守住。
  check('manifest 有固定 key（扩展 ID 不随目录名变）',
    /^MII[A-Za-z0-9+/]{300,}={0,2}$/.test(MANIFEST.key || ''), true);
  /* 图标守卫：manifest 里声明的每个图标文件都得真的存在，而且 PNG 的实际尺寸
     要和声明的尺寸一致。缺文件或尺寸写错，Chrome 只会静默换回默认图标 /
     模糊放大，一个错都不报 —— 这种只能靠断言守。 */
  const declaredIcons = Object.assign({}, MANIFEST.icons, MANIFEST.action.default_icon);
  const iconProblems = [];
  for (const size of Object.keys(declaredIcons)) {
    const rel = declaredIcons[size];
    const p = path.join(EXT, rel);
    if (!fs.existsSync(p)) { iconProblems.push(rel + ' 文件不存在'); continue; }
    const buf = fs.readFileSync(p);
    if (buf.slice(1, 4).toString('latin1') !== 'PNG') { iconProblems.push(rel + ' 不是 PNG'); continue; }
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    if (w !== Number(size) || h !== Number(size)) {
      iconProblems.push(rel + ' 实际 ' + w + 'x' + h + '，声明是 ' + size);
    }
  }
  check('manifest 声明的图标文件都在、且尺寸对得上', iconProblems, []);
  /* 工具栏图标守卫：manifest 里没给 default_popup，那背景脚本就**必须**注册
     onClicked，否则点图标什么都不会发生 —— 而且 Chrome 一个错都不报，
     用户只会觉得「这个扩展坏了」。图标曾经就是这么白摆着的，没人发现。
     反过来也守一条：一旦加了 default_popup，onClicked 就再也不会触发
     （同样静默），那时这条守卫必须提醒你去看一眼。 */
  const BG_SRC = srcOf('background.js');
  check('图标的点击有人接（没 popup 就必须注册 onClicked）',
    /chrome\.action\.onClicked\.addListener/.test(BG_SRC), true);
  check('图标没有 default_popup（有的话 onClicked 永远不会触发）',
    MANIFEST.action.default_popup === undefined, true);
  check('LICENSE 保留了原始署名',
    /Copyright \(c\) 2026 Zara Zhang/.test(fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8')), true);
}

/* =================================================================
   PART 10 — 呼出快捷键

   Chrome 的 commands API **只能读**：commands.update() / reset() 是 Firefox
   才有的东西。所以这块的核心不是「能不能改」，而是三件事：

     1. 读到的组合串能不能渲染成人看得懂的样子（两种形态都要接）
     2. 有没有去调根本不存在的 API —— 调了不会加载失败，但功能一定是死的
     3. manifest 里填的键 Chrome 认不认 —— 非法键（比如用户最想要的 `\`）
        会让扩展**直接装不上**
   ================================================================= */
function part10() {
  console.log('\n[PART 10] 呼出快捷键');

  const APP_SRC  = fs.readFileSync(APP, 'utf8');
  const HTML_SRC = srcOf('index.html');
  const cmds = JSON.parse(srcOf('manifest.json')).commands;

  const NAME = T.COMMAND_NAME;
  check('命令名和 manifest 里声明的一致', NAME in cmds, true);
  check('跳转地址就是 Chrome 那个页面', T.SHORTCUTS_URL, 'chrome://extensions/shortcuts');

  /* ---- 组合串的两种形态都要接住 ----
     Windows / Linux 上 getAll() 给的是 "Ctrl+Shift+K" 这种写法；
     macOS 上常常直接给 "⌘⇧K" 符号串 —— 里面没有 "+"，必须原样返回，
     绝不能拿英文名再拼一遍，否则会变成「⌘ ⇧ K」这种四不像。
     沙箱里没有 navigator，所以 IS_MAC 一定是 false，这两条的期望值是确定的。 */
  check('英文写法拆得开',       T.formatShortcut('Ctrl+Shift+K'), 'Ctrl + Shift + K');
  check('macOS 符号串原样保留', T.formatShortcut('⌘⇧K'), '⌘⇧K');
  check('空串当没设',           T.formatShortcut(''), '');
  check('undefined 也不炸',     T.formatShortcut(undefined), '');

  /* ---- 符号渲染单独测：真机是 Mac 还是 Windows 造不出来，isMac 当参数传 ---- */
  check('Mac：渲染成符号',    T.formatShortcutParts(['Command', 'Shift', 'K'], true), '⌘⇧K');
  check('非 Mac：保留英文名', T.formatShortcutParts(['Command', 'Shift', 'K'], false), 'Cmd + Shift + K');
  /* 这两个最容易翻错：Alt 在 Mac 上是 Option；而 MacCtrl 才是 macOS 上真正的
     Control 键（在 mac 上写 Ctrl 会被 Chrome 自动转成 Command）。 */
  check('Mac：Alt 显示成 Option 符号', T.formatShortcutParts(['Alt', 'Shift', 'C'], true), '⌥⇧C');
  check('Mac：MacCtrl 显示成 Control', T.formatShortcutParts(['MacCtrl', 'Shift', 'C'], true), '⌃⇧C');

  /* ---- ⚠️ 合法键的白名单守卫 ----
     Chrome 认识的键只有：A–Z、0–9、Comma、Period、Home、End、PageUp、
     PageDown、Space、Insert、Delete、四个方向键、四个媒体键；
     修饰键只有 Ctrl / Alt / Shift / MacCtrl / Command / Option / Search。

     **反斜杠 `\` 不在里面** —— 用户第一句想要的就是 ⌘+\，而它恰好不合法。
     把这份白名单写成断言，是为了以后没人能把它悄悄填回去：
     非法键不是「运行时不生效」，会让扩展直接装不上。 */
  const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'MacCtrl', 'Command', 'Option', 'Search'];
  const PLAIN_KEYS = ['Comma', 'Period', 'Home', 'End', 'PageUp', 'PageDown', 'Space',
    'Insert', 'Delete', 'Up', 'Down', 'Left', 'Right',
    'MediaNextTrack', 'MediaPlayPause', 'MediaPrevTrack', 'MediaStop'];

  const badTokens = [];
  const noModifier = [];
  for (const [cmd, def] of Object.entries(cmds)) {
    const sk = def.suggested_key || {};
    for (const [plat, combo] of Object.entries(sk)) {
      const toks = String(combo).split('+');
      for (const tok of toks) {
        const ok = /^[A-Z0-9]$/.test(tok) || MODIFIERS.includes(tok) || PLAIN_KEYS.includes(tok);
        if (!ok) badTokens.push(cmd + ' ' + plat + ' 里的 ' + JSON.stringify(tok));
      }
      // Chrome 的硬性要求：组合里必须有一个 Ctrl 或 Alt（mac 上 Command 也算）
      if (!toks.some(t => ['Ctrl', 'Alt', 'MacCtrl', 'Command'].includes(t))) {
        noModifier.push(cmd + ' ' + plat);
      }
    }
  }
  check('suggested_key 里没有 Chrome 不认识的键（比如反斜杠）', badTokens, []);
  check('每个 suggested_key 都至少带一个修饰键', noModifier, []);

  /* ---- 静态约定 ---- */
  check('确实在读 Chrome 给的绑定，而不是自己编一个',
    /chrome\.commands\.getAll\(\)/.test(APP_SRC), true);

  /* ⚠️ 这条是这次的重点。commands.update() / commands.reset() 只有 Firefox 有。
     在 Chrome 上调它们**不会让扩展加载失败**，只会永远不生效 ——
     写起来像对的、跑起来是死的，正是最该守的那一类。
     注意要拿挖掉注释的代码去比：app.js 的注释里正好提到了这两个名字。 */
  const codeOnly = APP_SRC
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .split('\n').map(l => l.replace(/(^|[^:'"\\])\/\/.*$/, '$1')).join('\n');
  check('没有去调只有 Firefox 才有的 commands.update / reset',
    [/\bcommands\.update\s*\(/.test(codeOnly), /\bcommands\.reset\s*\(/.test(codeOnly)],
    [false, false]);

  check('设置面板里有快捷键那一行', /data-action="change-shortcut"/.test(HTML_SRC), true);
  check('显示当前绑定的元素也在',   /id="shortcutKeys"/.test(HTML_SRC), true);
  check('快捷键那一行不是开关（用 div，点整行不该有反应）',
    /class="setting-row setting-row-static"/.test(HTML_SRC), true);
}

/* =================================================================
   PART 11 — 当地天气

   天气分两半，各自有要守的东西：

   一、拉数据（唯一会往外网伸手的地方）—— 真正要守的不是「能不能拿到」，
     而是**拿不到的时候会怎样**：
     · 断网 / 被墙 / 超时 / 非 200 / 返回的不是 JSON / 形状不对
       → 必须全部归到同一个结果「这次没拿到」。任何一条漏到画布上，
         用户看到的就是一个 0° 或者 NaN° —— 那比什么都不显示更糟，
         因为它看起来是真的。
     · 缓存优先 → 新标签页一出现就有内容，不为了天气白等 8 秒超时。
     · 换城市 → 必须丢掉旧城市的缓存，否则会拿上海的 26° 配北京的名字，
         页面一切正常但是错的，而且不报任何错。

   二、搜城市（**本地**库，不打网络）—— china-places.js 只收省/市两级正经
     行政区划，所以「青岛村」这种东西在库里就不存在。要守的是：
     · 数据完整性（生成脚本跑坏了不该悄悄带进仓库：条目数、坐标范围、
       每个省有省会、香港澳门台湾没有下级）；
     · 那几个被用户截图抓过的现场（青岛 / 大连 / 山东 / 朝阳 / 吉林）必须
       永远给出干净的结果；
     · 不许改回地理编码接口（#24：真正的青岛市都不在接口的返回里）。

   还有两条**结构 / 权限**守卫：天气条不许放进页头网格（见 PART 8），
   以及这个功能不许偷偷给自己加 host_permissions。
   ================================================================= */
async function part11() {
  console.log('\n[PART 11] 当地天气');

  const APP_SRC  = fs.readFileSync(APP, 'utf8');
  const HTML_SRC = srcOf('index.html');
  const CSS_SRC  = fs.readFileSync(path.join(EXT, 'style.css'), 'utf8');
  const MANIFEST = JSON.parse(srcOf('manifest.json'));

  /* ---- 天气码 → 人话 ---- */
  check('0 是晴',      T.weatherText(0),  '晴');
  check('3 是阴',      T.weatherText(3),  '阴');
  check('61 是雨',     T.weatherText(61), '雨');
  check('95 是雷雨',   T.weatherText(95), '雷雨');
  check('认不出的码退回中性说法、不炸', T.weatherText(9999), '天气');
  check('undefined 也不炸',             T.weatherText(undefined), '天气');

  /* 每个种别的文案词目都必须真的在文案表里。
     这条守的是**打错词目名**这类错：T() 取不到只会把 key 原样返回，
     页面上显示成 "weather.mostlyClear" 这种丑样子，而且不报错 ——
     和「拿文案做逻辑判断」是同一类沉默失败。 */
  check('每个种别的文案词目都在表里',
    Object.values(T.WEATHER_KINDS).map(d => d.text).filter(k => !(k in S.STRINGS.zh)), []);
  check('每个种别指的图标都真的存在',
    Object.values(T.WEATHER_KINDS).map(d => d.icon).filter(k => !T.WEATHER_ICONS[k]), []);
  check('每个图标都是完整的 SVG',
    Object.values(T.WEATHER_ICONS).filter(s => !/^<svg[\s\S]*<\/svg>$/.test(s)), []);
  check('认不出的码和阴天共用同一朵云（不至于露出空白）',
    T.weatherIcon(9999), T.weatherIcon(3));

  /* ---- 温度 / 区间 ---- */
  check('25.5 四舍五入到 26', T.formatTemperature(25.5), '26°');
  check('25.4 舍到 25',       T.formatTemperature(25.4), '25°');
  check('负数也认',           T.formatTemperature(-3.6), '-4°');
  // 0 度是合法温度，但它 falsy。用 `if (!temp)` 判空就会在零度那天把天气弄没。
  check('0 度不能当成「没有」', T.formatTemperature(0), '0°');
  check('NaN 当没有',      T.formatTemperature(NaN),  '');
  check('null 当没有',     T.formatTemperature(null), '');
  // 接口偶然给字符串时不能硬塞进模板，否则页面上是 "25.5°" 看着对、其实是脏数据
  check('字符串当没有',    T.formatTemperature('26'), '');

  check('区间套模板',       T.formatWeatherRange(23.8, 31.9), '今天 24° / 32°');
  check('零度区间也认',     T.formatWeatherRange(0, 0), '今天 0° / 0°');
  check('缺最高就整条不显示', T.formatWeatherRange(23.8, null), '');
  check('缺最低就整条不显示', T.formatWeatherRange(undefined, 31.9), '');

  /* ---- 搜索结果里那行小字 ---- */
  check('城市 → 所属省份',
    T.placeSubtitle({ name: '青岛市', province: '山东省', kind: 'city' }), '山东省');
  check('直辖市的区 → 直辖市名',
    T.placeSubtitle({ name: '朝阳区', province: '北京市', kind: 'district' }), '北京市');
  check('省 → 省会（搜「山东」的人最可能想要的是省会的天气）',
    T.placeSubtitle({ name: '山东省', kind: 'province', capital: '济南市' }), '省会 · 济南市');
  check('直辖市 → 「直辖市」三个字',
    T.placeSubtitle({ name: '上海市', kind: 'municipality' }), '直辖市');
  check('特区 → 完整行政区名',
    T.placeSubtitle({ name: '香港', province: '香港特别行政区', kind: 'special' }), '香港特别行政区');
  check('什么都没有 → 空串，不留一个孤零零的分隔点', T.placeSubtitle({}), '');
  check('null 也不炸', T.placeSubtitle(null), '');
  check('「省会」「直辖市」是界面文案，走表',
    [S.T('weather.capital', { city: '济南市' }), S.T('weather.municipality')],
    ['省会 · 济南市', '直辖市']);

  /* ---- 界面上显示的城市名 ---- */
  check('选了城市就用它',       T.weatherCityLabel({ name: '北京' }), '北京');
  check('没选过就用默认城市',   T.weatherCityLabel({}), '上海');
  check('名字是空白算没选',     T.weatherCityLabel({ name: '   ' }), '上海');
  check('名字不是字符串也不炸', T.weatherCityLabel({ name: 123 }), '上海');
  // 默认城市名走文案表，所以换语言时它会变成 Shanghai，而不是卡在中文
  check('默认城市名来自文案表', T.weatherCityLabel({}), S.T('weather.defaultCity'));

  /* ---- 露不露。三种组合都要对 ---- */
  check('开关开 + 画过 → 露',     T.weatherShouldShow({ showWeather: true  }, '1'), true);
  check('开关关 + 画过 → 不露',   T.weatherShouldShow({ showWeather: false }, '1'), false);
  // 没画过就露出去，会先闪一个空盒子 —— 新标签页上这一下特别扎眼
  check('开关开 + 没画过 → 不露', T.weatherShouldShow({ showWeather: true }, undefined), false);
  check('读不到开关 → 不露',      T.weatherShouldShow(null, '1'), false);

  /* ---- 缓存新鲜度 ---- */
  const TTL = T.WEATHER_TTL_MS;
  const NOW = 1700000000000;
  check('刚拉的 → 新鲜',            T.isWeatherCacheFresh({ at: NOW }, NOW), true);
  check('差 1ms 到期 → 还新鲜',     T.isWeatherCacheFresh({ at: NOW - TTL + 1 }, NOW), true);
  check('整好到期 → 过期',          T.isWeatherCacheFresh({ at: NOW - TTL }, NOW), false);
  check('早过期了 → 过期',          T.isWeatherCacheFresh({ at: NOW - TTL * 3 }, NOW), false);
  // 系统时间被往回调过时，年龄会算成负数。那种缓存不可信，宁可重拉一次。
  check('时间戳在未来 → 当过期',    T.isWeatherCacheFresh({ at: NOW + 5000 }, NOW), false);
  check('没有缓存 → 过期',          T.isWeatherCacheFresh(null, NOW), false);
  check('缓存没有时间戳 → 过期',    T.isWeatherCacheFresh({ temperature: 20 }, NOW), false);

  /* ---- 拉实况：响应映射 ---- */
  const SH = { latitude: 31.22222, longitude: 121.45806 };
  const okBody = {
    current: { temperature_2m: 25.5, weather_code: 3 },
    daily:   { temperature_2m_max: [31.9], temperature_2m_min: [23.8] },
  };

  fetchCalls = [];
  fetchImpl = async () => jsonResponse(okBody);
  const w = await T.fetchWeather(SH);
  check('正常响应 → 字段映射对了',
    [w.temperature, w.weatherCode, w.tempMax, w.tempMin], [25.5, 3, 31.9, 23.8]);
  check('  带上了时间戳（缓存要靠它判断新鲜度）', typeof w.at, 'number');
  check('  地址带了坐标',
    fetchCalls[0].url.includes('latitude=31.22222')
      && fetchCalls[0].url.includes('longitude=121.45806'), true);
  check('  要的就是实况 + 今天的最高最低',
    fetchCalls[0].url.includes('current=temperature_2m,weather_code')
      && fetchCalls[0].url.includes('daily=temperature_2m_max,temperature_2m_min')
      && fetchCalls[0].url.includes('timezone=auto'), true);
  check('  不让 HTTP 缓存插一脚（否则会显示几小时前的温度）',
    fetchCalls[0].opts && fetchCalls[0].opts.cache, 'no-store');
  check('  带上了超时用的 signal', !!(fetchCalls[0].opts && fetchCalls[0].opts.signal), true);

  /* ---- 拉实况：六种失败必须都归到 null ---- */
  const failures = [
    ['HTTP 404',        async () => badResponse(false)],
    ['返回的不是 JSON', async () => ({ ok: true, json: async () => { throw new Error('nope'); } })],
    ['连都连不上',      async () => { throw new Error('network down'); }],
    ['没有 current',    async () => jsonResponse({ daily: {} })],
    ['温度是字符串',    async () => jsonResponse({ current: { temperature_2m: '25.5' } })],
    ['温度是 NaN',      async () => jsonResponse({ current: { temperature_2m: NaN } })],
  ];
  for (const [label, impl] of failures) {
    fetchImpl = impl;
    check('失败 · ' + label + ' → null', await T.fetchWeather(SH), null);
  }

  fetchCalls = [];
  fetchImpl = async () => jsonResponse(okBody);
  const noCoord = await T.fetchWeather({ name: '没有坐标' });
  check('没有坐标 → null，而且一次网络都不打', [noCoord, fetchCalls.length], [null, 0]);

  fetchImpl = async () => jsonResponse({ current: { temperature_2m: 20 }, daily: {} });
  const noDaily = await T.fetchWeather(SH);
  check('只有实况、没有今日区间 → 温度照样给，区间留空（缺一半不该整条丢掉）',
    [noDaily.temperature, noDaily.tempMin, noDaily.tempMax], [20, null, null]);

  /* ---- 找城市：本地库（china-places.js），不打网络 ----
     背景（#24）：Open-Meteo 的地理编码对中国地名不可用 —— 实测搜「青岛」返回
     3 条（辽宁的青岛村 + 两个无人岛），真正的青岛市根本不在结果里；搜「大连」
     5 条全是村子。正确答案不在数据里，筛选规则救不了。所以搜索改走本地库，
     只收省 / 市两级正经行政区划 —— 库里**根本没有**「青岛村」这种东西。 */
  fetchCalls = [];
  fetchImpl = async () => { throw new Error('搜索不该打网络'); };

  check('搜「青岛」→ 只有青岛市（#24 的原始 bug 现场）',
    T.searchLocalPlaces('青岛').map(p => p.name), ['青岛市']);
  check('  它是山东的、坐标对得上',
    (() => { const p = T.searchLocalPlaces('青岛')[0];
      return [p.province, Math.round(p.latitude), Math.round(p.longitude)];
    })(), ['山东省', 36, 120]);
  check('搜「大连」→ 只有大连市（#24 第二个现场）',
    T.searchLocalPlaces('大连').map(p => p.name), ['大连市']);
  check('搜「山东」→ 山东省，坐标用省会济南的',
    (() => { const p = T.searchLocalPlaces('山东')[0];
      return [p.name, p.capital, Math.round(p.latitude)];
    })(), ['山东省', '济南市', 37]);
  check('搜「朝阳」→ 两个，但两个都是真的（区 + 市，分属不同一级）',
    T.searchLocalPlaces('朝阳').map(p => p.name + '@' + p.province).sort(),
    ['朝阳市@辽宁省', '朝阳区@北京市'].sort());
  check('搜「吉林」→ 省和市都出，省排前面（名字以关键词开头者优先）',
    T.searchLocalPlaces('吉林').map(p => p.name), ['吉林省', '吉林市']);
  check('搜「香港」→ 只有自身（约定：香港澳门就到自身一级）',
    T.searchLocalPlaces('香港').map(p => [p.name, p.kind]), [['香港特别行政区', 'special']]);
  check('搜「上海」→ 上海市（直辖市条目）',
    T.searchLocalPlaces('上海').map(p => [p.name, p.kind]), [['上海市', 'municipality']]);
  // 「海」这个关键词很刁：以它开头的条目有 7 个（海淀区/海口市/海东市/海南省/
  // 海北/海南/海西三个自治州），而上海市、威海市只是**包含**它 ——
  // 这两个性质合在一起，把「开头优先」排序和截断都锁死了
  check('搜「海」→ 全部以「海」开头（上海市、威海市不该排进来）',
    T.searchLocalPlaces('海').every(p => p.name.startsWith('海')), true);
  check('  而且被截到 SHOW 条（多了面板会被撑长）',
    T.searchLocalPlaces('海').length, T.WEATHER_PLACE_SHOW);
  check('一次网络都没打（搜索是本地的，离线也能用）', fetchCalls.length, 0);
  check('空查询 → []', T.searchLocalPlaces('   '), []);
  check('库里没有的写法 → []', T.searchLocalPlaces('zzzqqq'), []);
  check('null 进来不炸', T.searchLocalPlaces(null), []);

  /* ---- 城市库本身的完整性 ----
     这个文件是生成的（tools/make-china-places.js）。生成的产物必须有守卫，
     否则一次失败的生成会把「搜不到任何城市」带进仓库 —— 而且不会报任何错。 */
  check('城市库有 480+ 条', CHINA_PLACES.length >= 480, true);
  check('  一级条目（省 / 直辖市 / 特区）正好 34 个',
    CHINA_PLACES.filter(e => !e.p).length, 34);
  check('  每条都有名字和在中国范围内的坐标',
    CHINA_PLACES.every(e => e.n && Number.isFinite(e.la) && Number.isFinite(e.lo)
      && e.la > 3 && e.la < 54 && e.lo > 73 && e.lo < 136), true);
  check('  山东省有 16 个市', CHINA_PLACES.filter(e => e.p === '山东省').length, 16);
  check('  重庆市有 38 个区（直辖市到区）', CHINA_PLACES.filter(e => e.p === '重庆市').length, 38);
  check('  香港 / 澳门 / 台湾没有下级（只收自身一级）',
    CHINA_PLACES.filter(e => ['香港特别行政区', '澳门特别行政区', '台湾省'].includes(e.p)).length, 0);
  check('  每个省条目都带着省会名',
    CHINA_PLACES.filter(e => e.k === 'province').every(e => e.cap), true);
  check('  省条目的坐标用的是省会城市的（不是省的几何中心）',
    (() => {
      const sd  = CHINA_PLACES.find(e => e.n === '山东省');
      const jn  = CHINA_PLACES.find(e => e.n === '济南市');
      return Math.abs(sd.la - jn.la) < 0.01 && Math.abs(sd.lo - jn.lo) < 0.01;
    })(), true);
  check('  直辖市 / 特区条目不需要省会名',
    CHINA_PLACES.filter(e => ['municipality', 'special'].includes(e.k)).every(e => !e.cap), true);

  /* ---- 结果列表渲染 ----
     搜索是本地的、同步的，所以「搜不动」这种状态不存在了。
     提示只剩一种：库里没有 → 换个写法。 */
  const resultsBox = fakeDomNode();
  const placeInput = { value: '' };
  domNodes.set('weatherResults', resultsBox);
  domNodes.set('weatherPlaceInput', placeInput);

  placeInput.value = '朝阳';
  await T.runPlaceSearch();
  // 名字来自本地库，但「外部数据插 innerHTML 前必须转义」这条规矩不分来源
  check('结果带上了点选用的下标',
    /data-action="pick-weather-place" data-place-index="0"/.test(resultsBox.innerHTML), true);
  check('  两个候选都画出来了，各带所属一级',
    [resultsBox.innerHTML.includes('朝阳区'), resultsBox.innerHTML.includes('朝阳市'),
     resultsBox.innerHTML.includes('北京市'), resultsBox.innerHTML.includes('辽宁省')],
    [true, true, true, true]);
  check('  下标指向的结果真的存下来了',
    [T.getLastPlaceResults().length, T.getLastPlaceResults()[0].province].sort(),
    [2, '北京市'].sort());

  // 库本身是生成的、干净的，但「渲染外部字符串必须转义」这条不能靠库里碰巧
  // 没有坏字符串来保证。往库里塞一条假的恶意条目，验完就拿出来。
  const evil = { n: 'XSSMARK<img src=x onerror=alert(1)>', la: 30, lo: 120, p: 'XSS省', k: 'city' };
  CHINA_PLACES.push(evil);
  placeInput.value = 'XSSMARK';
  await T.runPlaceSearch();
  check('名字里的 HTML 必须被转义（不许把外部字符串当 HTML 插进去）',
    [resultsBox.innerHTML.includes('<img'), resultsBox.innerHTML.includes('&lt;img')], [false, true]);
  CHINA_PLACES.splice(CHINA_PLACES.indexOf(evil), 1);

  placeInput.value = 'zzzqqq';
  await T.runPlaceSearch();
  check('库里没有 → 提示「换个写法」',
    resultsBox.innerHTML.includes(S.T('settings.weatherPlace.empty')), true);

  placeInput.value = '';
  await T.runPlaceSearch();
  check('输入是空的 → 收起结果区', resultsBox.style.display, 'none');

  /* ---- 地点与缓存落盘 ---- */
  delete store[T.WEATHER_LOCATION_KEY];
  delete store[T.WEATHER_CACHE_KEY];
  check('没选过 → 用默认地点', await T.getWeatherLocation(), T.DEFAULT_WEATHER_LOCATION);
  check('没缓存 → null',       await T.getWeatherCache(), null);

  await T.setWeatherLocation({ name: '北京', latitude: 39.9, longitude: 116.4, admin1: '北京市', country: '中国' });
  const savedLoc = await T.getWeatherLocation();
  check('选了城市 → 读回来是它', [savedLoc.name, savedLoc.latitude], ['北京', 39.9]);

  // 半条数据比没有更糟：接受它就会拿一组不存在的坐标去问天气
  await T.setWeatherLocation({ name: '没有坐标' });
  check('缺坐标的城市不许写进去（保留上一个）',
    (await T.getWeatherLocation()).name, '北京');

  await T.setWeatherLocation({ name: 'x'.repeat(200), latitude: 1, longitude: 2 });
  check('地名长度被截断（外部数据不许无限长）',
    (await T.getWeatherLocation()).name.length, 80);

  /* ---- 换城市必须丢缓存 ----
     这条只能从源码上守：不丢的话页面会拿上一个城市的温度配新城市的名字，
     看着完全正常，但是错的。这类错没有报错、没有视觉异常，最难发现。 */
  const pickFrom  = APP_SRC.indexOf("action === 'pick-weather-place'");
  const pickTo    = APP_SRC.indexOf("action === 'open-quick-site'");
  const pickBlock = APP_SRC.slice(pickFrom, pickTo);
  check('换城市时丢掉了旧城市的天气缓存',
    /storage\.local\.remove\(WEATHER_CACHE_KEY\)/.test(pickBlock), true);
  // 注意这里要显式判 > 0：找不到时 indexOf 返回 -1，而 -1 比谁都小，
  // 光靠「谁在前」会把「整段代码都不见了」误判成通过。
  const dropAt = pickBlock.indexOf('.remove(WEATHER_CACHE_KEY)');
  check('  而且是先丢缓存、再重画（顺序反了会先把旧数据画上去）',
    dropAt > 0 && dropAt < pickBlock.indexOf('renderWeather()'), true);

  /* ---- 权限守卫 ----
     天气是本项目第一个联网功能，但它**不需要任何新权限**：Open-Meteo 的
     响应头带 access-control-allow-origin: *，扩展页可以直接跨域取（实测过）。
     这条守卫是给以后的人看的 —— 一旦顺手加了 host_permissions，用户下次
     重载就会被弹一个「读取您在所有网站上的数据」级别的确认框，
     对一个只想看天气的功能来说代价太大。要加，得是深思熟虑，不能是顺手。 */
  check('天气没有偷偷加 host_permissions（靠 CORS 走通就够）',
    MANIFEST.host_permissions === undefined, true);
  check('预报接口域名是写死的常量，不是拼在字符串中间',
    /const WEATHER_API_HOST\s*=\s*'https:\/\/api\.open-meteo\.com'/.test(APP_SRC), true);
  /* 搜索不许再走接口。#24 的教训：Open-Meteo 地理编码对中国地名不可用
     （真正的青岛市都不在返回里），改回网络搜索就是把那个 bug 请回来。 */
  check('城市搜索不再打网络（源码里没有地理编码接口地址）',
    APP_SRC.includes('geocoding-api.open-meteo.com/v1/search'), false);
  check('  app.js 里也没有 searchPlaces 这个旧函数了',
    /function searchPlaces\(/.test(APP_SRC), false);

  /* ---- 城市库的引入顺序 ----
     searchLocalPlaces 在 app.js 顶层读不到 CHINA_PLACES，但运行时必须有。
     index.html 里 china-places.js 必须在 app.js **之前**引入，
     顺序反了会是 "CHINA_PLACES is not defined"，而且只在真机上炸。 */
  const placesTagAt = HTML_SRC.indexOf('<script src="china-places.js">');
  const appTagAt    = HTML_SRC.indexOf('<script src="app.js">');
  check('index.html 引入了 china-places.js，且在 app.js 之前',
    placesTagAt > 0 && appTagAt > placesTagAt, true);

  /* ---- 拉不到时必须安静 ----
     新标签页是最不该出现错误提示的地方：断网、被墙、接口挂了，用户该看到的
     只是「这里没有天气」，而不是一个他看不懂也修不了的红条。 */
  const rwBlock = APP_SRC.slice(APP_SRC.indexOf('async function renderWeather()'),
                                APP_SRC.indexOf('async function renderWeatherPlaceSetting'));
  check('拉不到时不弹提示条（失败要安静，只留 console 日志）',
    /showToast/.test(rwBlock), false);

  /* ---- 结构守卫 ----
     天气条**不许**放进页头。页头是写死 grid-column 的三栏网格，再塞一个会被
     显示/隐藏的孩子，就会把「开关搜索框、齿轮左右跳」那套坑重新打开
     （见 PART 8）。靠 HTML 里的先后位置来守，是因为这正是当初踩坑的形状。 */
  const headerClose  = HTML_SRC.indexOf('</header>');
  const containerEnd = HTML_SRC.indexOf('<!-- end .container -->');
  const weatherAt    = HTML_SRC.indexOf('id="weather"');
  check('天气条在页头外面（不是页头网格的孩子）',
    headerClose > 0 && weatherAt > headerClose && weatherAt < containerEnd, true);
  check('天气条初始是隐藏的（等真拿到数据才露，否则会先闪一个空盒子）',
    /id="weather"[^>]*style="display:none"/.test(HTML_SRC), true);

  check('设置面板里有天气开关', /data-setting="showWeather"/.test(HTML_SRC), true);
  check('城市行和快捷键行都不是开关（点整行不该有反应）',
    (HTML_SRC.match(/class="setting-row setting-row-static"/g) || []).length, 2);
  check('城市输入框和搜索按钮都在',
    [/id="weatherPlaceInput"/.test(HTML_SRC), /data-action="search-weather-place"/.test(HTML_SRC)],
    [true, true]);
  // 结果列表必须是城市行的**兄弟**，不能是它的孩子：那一行是 flex，塞进去会横着排
  check('结果列表是城市行的兄弟节点，不在那一行里面',
    /<\/button>\s*<\/div>\s*<div class="weather-results"/.test(HTML_SRC), true);

  // 城市搜索结果夹在城市行和快捷键行之间，所以设置面板的分隔线选择器
  // 必须是 ~ 而不是 +。换回 + 的话，快捷键那行的上分隔线会**静默消失** ——
  // 不报错、不崩，只是变丑，没有断言就只能靠人眼发现。
  check('设置面板的分隔线用 ~ 兜住中间夹着的元素',
    /\.setting-row\s*~\s*\.setting-row\s*\{[^}]*border-top/.test(CSS_SRC), true);
}

(async () => {
  await part2();
  console.log('  （存完就关后剩下的标签页：' +
    fakeTabs.map(t => t.url).join(', ') + '）');
  await part3();
  await part4();
  await part5();
  await part6();
  await part7();
  part8();
  part9();
  part10();
  await part11();

  console.log('\n' + (failed === 0 ? '全部通过' : `${failed} 条不符合预期`));
  process.exit(failed === 0 ? 0 : 1);
})();
