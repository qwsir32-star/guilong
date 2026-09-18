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
 *   PART 10 呼出快捷键（命令名 / 跳转地址 / manifest 声明）
 *   PART 11 当地天气（本地城市库 / 缓存 / 失败要安静）
 *   PART 12 主题色（解析 / 落 <html> / localStorage 镜像 / 主题块只写三元组）
 *   PART 13 稍后再看 / 归档（一键删除 / 归档还原 / 确认态 / 文案）
 *   PART 14 跨浏览器（env.js 判定 / Firefox 差异 / README 的加载路径）
 *   PART 15 字体自托管（Mac / Windows 一致 + 零网络请求）
 *   PART 16 README 结构（目录锚点不许死链 / 仓库内链接真实存在 / 许可证压轴）
 *   PART 17 界面语言（中英切换 / 默认跟随系统 / 标题走文案表）
 *   PART 18 设置面板是居中悬浮的模态（<dialog> + showModal + 背板虚化）
 *   PART 19 index.html 里不许写死界面文案（补上 PART 9 只扫 app.js 的缺口）
 *   PART 20 出网主机白名单（图标一律本地读盘，不许再有第三个联网的地方）
 *   PART 21 测试文件自己的一致性（分区编号 / 标题格式 / 目录注释不许漂移）
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
  dismissSavedTab, checkOffSavedTab, clearAllSavedTabs, restoreArchivedTab,
  confirmOrArm, CONFIRM_RESET_MS,
  normalizeSiteUrl, siteKey, siteLabel, getQuickSites, sameEntryUrl, originOf,
  isSiteRoot, pathHintOf, suggestSiteName, resolveSiteIcon, faviconUrlFor, envOf,
  pinSite, unpinSite, hideTopSite, openQuickSite, getRealTabs,
  updatePinnedSite, movePinnedSite, promoteTopSite,
  faviconSignature, dropIfDefaultFavicon,
  getUiPrefs, setUiPref, applyUiPrefs, looksLikeUrl, runSearch, focusSearchBox,
  openSettingsPanel, closeSettingsPanel,
  resolveTheme, normalizeTheme, paintTheme, mirrorTheme, isDarkTheme,
  readSettingValue,
  systemLanguage, applyLanguage,
  THEME_IDS, DARK_THEME_IDS, THEME_SYSTEM, DEFAULT_THEME, THEME_MIRROR_KEY,
  UI_PREFS_DEFAULTS,
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
// 假的 <html>：applyStaticStrings 改它的 lang，paintTheme 改它的 dataset/colorScheme
const fakeRoot      = { lang: '', dataset: {}, style: {} };

/* ---------------- 受控的假 localStorage ----------------
   主题的镜像写在这里（theme-boot.js 靠它在第一帧之前把配色定下来）。
   用一个真的 Map 存，测试能直接看里面有没有、写的是什么。 */
const localStore    = new Map();
const localStorage  = {
  getItem:    k => (localStore.has(k) ? localStore.get(k) : null),
  setItem:    (k, v) => { localStore.set(k, String(v)); },
  removeItem: k => { localStore.delete(k); },
};

/* ---------------- 受控的假「系统要深色吗」 ----------------
   let 而不是 const：测试要能在中途把系统切成深色，验证「跟随系统」会跟着变。 */
let systemDark = false;
const windowStub = {
  matchMedia: (q) => ({
    matches: String(q).includes('dark') ? systemDark : false,
    addEventListener: () => {},
  }),
};

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
      // 设置面板里现在既有开关（checkbox）也有下拉（主题）——
      // 选择器写成不带标签的 [data-setting]，两种都得回来
      if (sel === '[data-setting]' || sel === 'input[data-setting]') return settingInputs;
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
  window: windowStub,
  localStorage,
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

/* 扫源码前先剥注释 —— 说明文字里提到 chrome://、https:// 会被自己的守卫点着，
   永远红。（`//` 前面那个 `[^:'"\\]` 是为了放过 http:// 里的那两个斜杠。） */
function stripComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')     // /* */   CSS / JS
    .replace(/<!--[\s\S]*?-->/g, '')      // <!-- -->  HTML —— 少了这一条，
                                          // index.html 里解释「为什么自托管」的
                                          // 那段注释会被自己的守卫点着
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}

/* ---------------- 加载 strings.js + app.js ----------------
   **strings.js 必须先加载。** app.js 在模块顶层就会用到 T()：
   FRIENDLY_DOMAINS 里那条 'local-files' 是 T('section.localFiles')，
   文件最后那行自启动的 renderDashboard() 也会走 applyStaticStrings()。
   少加载这一个文件，整套测试会因为 "T is not defined" 直接崩。 */
vm.createContext(sandbox);

/* env.js 也要先加载 —— index.html 里它排在 strings.js 前面，顺序保持一致。
   envOf() 在拿不到 GL_ENV 时会退化成 Chromium 行为，所以不加载也能跑；
   但 PART 14 要直接用 GL_ENV.makeEnv 造出 Firefox 的那份来断言。 */
vm.runInContext(
  fs.readFileSync(path.join(EXT, 'env.js'), 'utf8')
  + ';globalThis.__env=GL_ENV;',
  sandbox);

const STRINGS_PATH = path.join(EXT, 'strings.js');
vm.runInContext(
  fs.readFileSync(STRINGS_PATH, 'utf8') +
  ';globalThis.__s={STRINGS,T,Tn,setLang,localeOf,applyStaticStrings,LANG_LOCALES,getLang:()=>LANG,' +
    'normalizeLanguage,resolveLanguage,LANG_IDS,LANG_SYSTEM,DEFAULT_LANGUAGE};',
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
  check('图标留空 → 首字母',        ico.letter, 'G');

  ico = T.resolveSiteIcon({ url: 'https://a.com/', icon: 'https://cdn.example/logo.png' }, 'A站');
  check('图标填图片地址 → 用这张图', ico.img, 'https://cdn.example/logo.png');

  // 返回值里**不再有 host** —— 它当年只为「失败兜底去问 google s2」而存在。
  // 兜底改成直接删图之后 host 就是死字段，留着等于给那个洞留一条随时能接回去
  // 的线。这里守的是结构（字段都没了，谁也别想顺手把它接回来）。
  const shape = T.resolveSiteIcon({ url: 'https://github.com/', icon: '' }, 'GitHub');
  check('图标解析结果里没有 host 字段（兜底不再需要域名）',
    ['host' in shape, Object.keys(shape).sort()], [false, ['img', 'letter']]);

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
  // 2026-09-19：站点条和搜索框改成**默认关**（新标签页先给一屏干净的标签页），
  // 天气默认开；语言默认「跟随系统」。这条断言就是那份默认值的唯一书面记录。
  check('没设置过时读默认值（站点条 / 搜索框默认关，天气开，语言跟随系统）',
    await T.getUiPrefs(),
    { showQuickSites: false, showSearchBox: false, showWeather: true,
      theme: 'paper', language: 'system' });

  await T.setUiPref('showQuickSites', false);
  check('关掉站点条后读回来是关的', (await T.getUiPrefs()).showQuickSites, false);

  // 老用户的存储里可能只有新增开关之前存的那一半键，缺的必须补默认值。
  // 天气开关就是这么加进来的：加它之前存过设置的人，存储里没有 showWeather，
  // 读到的必须是 true 而不是 undefined —— undefined 会让那个勾选框处于半死状态。
  store.uiPrefs = { showQuickSites: false };
  check('缺的键自动补默认值',
    await T.getUiPrefs(),
    { showQuickSites: false, showSearchBox: false, showWeather: true,
      theme: 'paper', language: 'system' });

  await T.setUiPref('不存在的开关', false);
  check('未声明的开关不许写进去', Object.keys(await T.getUiPrefs()).sort(),
    ['language', 'showQuickSites', 'showSearchBox', 'showWeather', 'theme']);

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
  // 返回值里多一个 themeId：存储里存的是「选了什么」，themeId 是「真画出来的
  // 是什么」。选了「跟随系统」时这两个不一样（system vs dark/light）。
  check('applyUiPrefs 把读到的开关返回出来',
    await T.applyUiPrefs(),
    { showQuickSites: false, showSearchBox: true, showWeather: true,
      theme: 'paper', language: 'system', themeId: 'paper' });

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
  console.log('\n[PART 8] 页头三栏：每个孩子都必须显式指定栏位');
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
  console.log('\n[PART 9] 文案表 STRINGS');
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
    /* 空状态三件套（2026-09-18）：关掉所有卡片后的「Inbox zero」那屏。
       前两句原来写在模板字符串里、不带引号 —— 裸串照样能匹配到带引号的写法，
       所以这里故意不加引号，一种条目兜两种写法。 */
    "'0 domains'", 'Inbox zero, but for tabs.', "You're free.",
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

async function part12() {
  console.log('\n[PART 12] 主题色');

  const CSS_SRC   = fs.readFileSync(path.join(EXT, 'style.css'), 'utf8');
  const HTML_SRC  = srcOf('index.html');
  const BOOT_SRC  = srcOf('theme-boot.js');

  /* ---- 选了什么 → 画出什么 ----
     resolveTheme 是这套逻辑的心脏：'system' 在这里被解析掉，不认识的值一律
     退回默认。退回默认比抛错合适 —— 主题不是功能，选不出来顶多是丑。 */
  check('纸感画纸感',   T.resolveTheme('paper'),  'paper');
  check('浅色画浅色',   T.resolveTheme('light'),  'light');
  check('深色画深色',   T.resolveTheme('dark'),   'dark');
  check('松林画松林',   T.resolveTheme('forest'), 'forest');
  check('墨蓝画墨蓝',   T.resolveTheme('ink'),    'ink');

  // 不认识的值：老存储里的脏数据、手改的、未来删掉的主题，全都会走到这里
  check('不认识的值一律回默认主题',
    [undefined, null, '', 'PAPER', 'nope', true, 42, {}].map(v => T.resolveTheme(v)),
    Array(8).fill(T.DEFAULT_THEME));

  /* ---- 跟随系统 ---- */
  systemDark = false;
  check('系统是浅色 → 跟随系统画出浅色', T.resolveTheme('system'), 'light');
  systemDark = true;
  check('系统是深色 → 跟随系统画出深色', T.resolveTheme('system'), 'dark');

  // 存储里**必须留着 system**：留着才能在下拉框里把选中项显示回「跟随系统」。
  // 在这里就解析掉的话，用户打开设置会看到选项莫名其妙停在「浅色」上。
  check('normalizeTheme 原样保留 system', T.normalizeTheme('system'), 'system');
  check('normalizeTheme 把不认识的拉回默认', T.normalizeTheme('nope'), 'paper');

  /* ---- 深色主题有哪些（color-scheme 靠它）---- */
  check('深色主题认得出来', T.THEME_IDS.filter(id => T.isDarkTheme(id)).sort(),
    ['dark', 'forest', 'ink']);
  check('深色清单里的每个 id 都是真主题',
    T.DARK_THEME_IDS.filter(id => !T.THEME_IDS.includes(id)), []);

  /* ---- 写到 <html> 上 ---- */
  check('paintTheme 把主题写到 <html data-theme> 上', T.paintTheme('dark'), 'dark');
  check('  data-theme 真的是它', fakeRoot.dataset.theme, 'dark');
  check('  深色主题的 color-scheme 是 dark（滚动条才不会是亮的一条）',
    fakeRoot.style.colorScheme, 'dark');
  T.paintTheme('light');
  check('浅色主题的 color-scheme 是 light', fakeRoot.style.colorScheme, 'light');

  /* ---- 存储里存的是字符串，不是布尔 ----
     这是最容易踩的一个坑：setUiPref 原来一律 !!value，主题存进去就变成
     true，读回来不认识 → 退回默认 → 页面永远是纸感，而存储里写着 true。
     不报错、不崩，只是「选了没反应」。 */
  delete store.uiPrefs;
  await T.setUiPref('theme', 'forest');
  check('主题存进去是字符串', (await T.getUiPrefs()).theme, 'forest');
  await T.setUiPref('theme', '不存在的主题');
  check('不认识的主题存进去会被拉回默认', (await T.getUiPrefs()).theme, 'paper');
  check('  而且不会把 system 之外的脏值留在存储里',
    T.THEME_IDS.includes((await T.getUiPrefs()).theme), true);

  // 按默认值的类型定型，开关那一边不能被改成字符串
  delete store.uiPrefs;
  await T.setUiPref('showQuickSites', false);
  check('开关仍然存成布尔（改主题那套定型逻辑没把开关带坏）',
    (await T.getUiPrefs()).showQuickSites, false);

  /* ---- localStorage 镜像 ----
     theme-boot.js 在 <head> 里同步读它，所以每次改主题都得写一份。
     少写这份的后果是深色主题每开一个新标签页先闪一下米白 —— 真机上才看得见。 */
  delete store.uiPrefs;
  await T.setUiPref('theme', 'ink');
  check('改主题时同步写了 localStorage 镜像',
    localStorage.getItem(T.THEME_MIRROR_KEY), 'ink');
  check('镜像的键名和 theme-boot.js 里读的是同一个',
    /localStorage\.getItem\(MIRROR_KEY\)/.test(BOOT_SRC) &&
    /var MIRROR_KEY = '([^']+)'/.exec(BOOT_SRC)[1] === T.THEME_MIRROR_KEY, true);

  /* ---- 落到 DOM：下拉框的选中项 + <html> ---- */
  settingInputs.length = 0;
  const themeSelect = { tagName: 'SELECT', dataset: { setting: 'theme' }, value: '' };
  settingInputs.push(themeSelect);

  store.uiPrefs = { theme: 'dark' };
  await T.applyUiPrefs();
  check('下拉框的选中项跟着存储走', themeSelect.value, 'dark');
  check('主题真的写到了 <html> 上', fakeRoot.dataset.theme, 'dark');

  systemDark = true;
  store.uiPrefs = { theme: 'system' };
  const applied = await T.applyUiPrefs();
  check('跟随系统 + 系统深色 → 画深色', fakeRoot.dataset.theme, 'dark');
  check('  但下拉里显示的还是「跟随系统」（存储里存的是指令不是结果）',
    themeSelect.value, 'system');
  check('  返回值的 themeId 是解析后的那个', applied.themeId, 'dark');
  check('  镜像里存的也是 system（解析留给开机那一步做）',
    localStorage.getItem(T.THEME_MIRROR_KEY), 'system');
  systemDark = false;

  /* ---- 读设置控件的值 ----
     下拉身上没有 checked。读错了属性不会报错，只会让主题永远是默认的那个。 */
  check('下拉读 value',   T.readSettingValue({ tagName: 'SELECT', value: 'ink' }), 'ink');
  check('开关读 checked', T.readSettingValue({ checked: false }), false);
  check('开关没勾 → false（不是 undefined）', T.readSettingValue({}), false);
  check('空对象也不炸',   T.readSettingValue(null), false);

  /* ---- theme-boot.js 真的能在开机时把主题定下来 ----
     这个文件是整个「不闪一下白底」的关键，但它跑在渲染之前、用的是另一套
     存储，冒烟测试的假 DOM 摸不到它。所以单独用一个新的沙盒跑一遍真源码。 */
  function bootWith(mirrorValue, dark) {
    const root = { dataset: {}, style: {} };
    const ctx = {
      console,
      document: { documentElement: root },
      window: { matchMedia: q => ({ matches: String(q).includes('dark') ? dark : false }) },
      localStorage: { getItem: () => mirrorValue },
    };
    vm.createContext(ctx);
    vm.runInContext(BOOT_SRC, ctx);
    return root;
  }

  check('镜像里是深色 → 开机就是深色', bootWith('dark', false).dataset.theme, 'dark');
  check('镜像里是松林 → 开机就是松林', bootWith('forest', false).dataset.theme, 'forest');
  check('镜像是空的 → 开机是默认主题', bootWith(null, false).dataset.theme, 'paper');
  check('镜像里是不认识的值 → 开机还是默认主题', bootWith('nope', false).dataset.theme, 'paper');
  check('镜像里是 system、系统深色 → 开机是深色', bootWith('system', true).dataset.theme, 'dark');
  check('镜像里是 system、系统浅色 → 开机是浅色', bootWith('system', false).dataset.theme, 'light');
  check('开机顺手把 color-scheme 也定了（深色）',
    bootWith('ink', false).style.colorScheme, 'dark');
  check('  浅色主题是 light', bootWith('paper', false).style.colorScheme, 'light');

  /* ---- 静态：CSS 的主题块 ---- */
  const blocks = [...CSS_SRC.matchAll(/html\[data-theme="([a-z]+)"\]\s*\{([\s\S]*?)\}/g)]
    .map(m => ({ id: m[1], body: m[2].replace(/\/\*[\s\S]*?\*\//g, '') }));

  // 别把主题 id 的清单写死在这儿：每加一个主题都要跟着改一遍，不改就红，
  // 而它和下面那条「跟 THEME_IDS 比对」说的是同一件事。这里只数数量。
  check('CSS 里的主题块数量和 app.js 的清单一样多', blocks.length, T.THEME_IDS.length);
  check('CSS 里没有 system 这一套（它是被解析掉的，不是一种配色）',
    CSS_SRC.includes('html[data-theme="system"]'), false);
  check('app.js 的主题清单和 CSS 里的主题块对得上',
    blocks.map(b => b.id).sort(), [...T.THEME_IDS].sort());

  // 只数**声明**（`--rgb-xxx:` 开头），不能数 `--rgb-` 出现的次数 ——
  // :root 里那些派生的 `rgb(var(--rgb-ink))` 也算一次出现，全数进去会得到
  // 45 这种数字，然后这条断言就永远红着，谁也不会再看它一眼。
  const countTriplets = css => (css.match(/^\s*--rgb-[a-z-]+\s*:/gm) || []).length;
  const rootBody = (/:root\s*\{([\s\S]*?)\n\}/.exec(CSS_SRC) || [, ''])[1];
  const rootCount = countTriplets(rootBody);
  check(':root 里的三元组数量', rootCount > 0, true);
  check('每个主题覆盖的三元组和 :root 一样多（少一个就有一块颜色不跟着变）',
    blocks.map(b => countTriplets(b.body)),
    blocks.map(() => rootCount));

  // 主题块里写具体的 rgba / 十六进制，等于把那块颜色钉死 —— 换肤时它不变，
  // 而且不报错，只能靠眼睛在真机上一个主题一个主题地看。
  check('主题块里没有写死的 rgba / 十六进制色',
    blocks.filter(b => /rgba\(|#[0-9a-fA-F]{3,8}\b/.test(b.body)).map(b => b.id), []);

  /* ---- 对比度 ----
     加新主题最容易出的毛病是「看着好看、字看不清」。这个不用眼睛判断 ——
     WCAG 的相对亮度公式算一下就行，而靠眼睛在真机上七个主题挨个看，
     基本一定会漏。 */
  const srgb = v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum  = ([r, g, b]) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
  const contrast = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };

  const triplets = {};
  for (const b of blocks) {
    const t = {};
    for (const m of b.body.matchAll(/--rgb-([a-z-]+):\s*(\d+)\s+(\d+)\s+(\d+)\s*;/g)) {
      t[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])];
    }
    triplets[b.id] = t;
  }

  check('每个主题都解析出了全部三元组',
    blocks.filter(b => Object.keys(triplets[b.id]).length !== rootCount).map(b => b.id), []);

  check('每个主题的正文在纸面上都够清楚（≥4.5）',
    blocks.filter(b => contrast(triplets[b.id].ink, triplets[b.id].paper) < 4.5).map(b => b.id), []);

  check('实心按钮上的字在主色上都够清楚（≥4.5）',
    blocks.flatMap(b => {
      const t = triplets[b.id];
      return [
        contrast(t['on-accent'], t['accent-sage']) < 4.5 ? `${b.id}/主色` : null,
        contrast(t['on-accent'], t['accent-sage-strong']) < 4.5 ? `${b.id}/主色-hover` : null,
      ].filter(Boolean);
    }), []);

  // ⚠️ 这条不是达标线，是**地板**：所有浅色主题的次要字（--muted）都只有 3 左右，
  // 低于 WCAG AA 的 4.5 —— 那是这套配色从一开始就有的样子（深色主题才有 5.5+），
  // 不是某一次改坏的。加新主题时不许比现在更低；真要提，就把七个主题的
  // --muted 一起压深，别只动一个。
  check('次要字没比现有主题更差（地板 2.8，不是达标线）',
    blocks.filter(b => contrast(triplets[b.id].muted, triplets[b.id].paper) < 2.8).map(b => b.id), []);

  /* ---- 静态：预加载 ---- */
  check('theme-boot.js 在 <head> 里',
    HTML_SRC.indexOf('theme-boot.js') < HTML_SRC.indexOf('</head>'), true);
  check('  而且在 style.css 之后（放前面等于白做）',
    /rel="stylesheet" href="style\.css"[\s\S]*?<script src="theme-boot\.js"/.test(HTML_SRC), true);
  check('  而且在 app.js 之前',
    HTML_SRC.indexOf('theme-boot.js') < HTML_SRC.indexOf('src="app.js"'), true);
  check('没有内联 script（MV3 的 CSP 是 script-src self，内联一律不执行）',
    /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/.test(HTML_SRC), false);
  // 去掉注释再扫：文件顶上的说明里**讲到了** chrome.storage，那是解释为什么
  // 不用它。不剥注释的话这条守卫只会被自己的注释点着，永远红。
  const BOOT_CODE = BOOT_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  check('theme-boot.js 不碰 chrome.storage（它是异步的，来不及赶上第一帧）',
    /chrome\.storage/.test(BOOT_CODE), false);

  const bootIds = ((/var THEME_IDS = \[([^\]]*)\]/.exec(BOOT_SRC) || [, ''])[1])
    .split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean);
  check('theme-boot.js 的主题清单和 app.js 一致（少一个就会白闪一下）',
    bootIds, T.THEME_IDS);

  /* ---- 静态：设置面板里的下拉 ---- */
  const optValues = [...HTML_SRC.matchAll(/<option value="([a-z]+)"[^>]*data-i18n="theme\.[a-z]+"/g)]
    .map(m => m[1]);
  check('下拉里的选项覆盖全部主题 + 跟随系统',
    optValues.sort(), [...T.THEME_IDS, T.THEME_SYSTEM].sort());
  check('每个选项的名字都走文案表（不许在 JS 里拿选项文字做判断）',
    optValues.length, T.THEME_IDS.length + 1);

  const themeKeys = [...T.THEME_IDS, T.THEME_SYSTEM].map(id => 'theme.' + id);
  check('每个主题的中英文案都在表里',
    themeKeys.filter(k => !(k in S.STRINGS.zh) || !(k in S.STRINGS.en)), []);
  check('设置面板里那两行主题文案也在表里',
    ['settings.theme.name', 'settings.theme.desc']
      .filter(k => !(k in S.STRINGS.zh) || !(k in S.STRINGS.en)), []);
}

async function part13() {
  console.log('\n[PART 13] 稍后再看 / 归档');

  const APP_SRC = fs.readFileSync(APP, 'utf8');
  const CSS_SRC = fs.readFileSync(path.join(EXT, 'style.css'), 'utf8');

  // 三条待办（未打勾）+ 两条归档（已打勾）+ 一条被删掉的
  const seed = () => {
    store.deferred = [
      { id: 'a1', url: 'https://a.com/1', title: 'A', completed: false, dismissed: false },
      { id: 'a2', url: 'https://b.com/2', title: 'B', completed: false, dismissed: false },
      { id: 'a3', url: 'https://c.com/3', title: 'C', completed: false, dismissed: false },
      { id: 'r1', url: 'https://d.com/4', title: 'D', completed: true,
        completedAt: new Date().toISOString(), dismissed: false },
      { id: 'r2', url: 'https://e.com/5', title: 'E', completed: true,
        completedAt: new Date().toISOString(), dismissed: false },
      { id: 'x1', url: 'https://f.com/6', title: 'F', completed: false, dismissed: true },
    ];
  };

  /* ---- 基础分堆 ---- */
  seed();
  let tabs = await T.getSavedTabs();
  check('没打勾的进待办、打勾的进归档',
    [tabs.active.map(t => t.id), tabs.archived.map(t => t.id)],
    [['a1', 'a2', 'a3'], ['r1', 'r2']]);
  check('被删掉的哪边都不在',
    [...tabs.active, ...tabs.archived].some(t => t.id === 'x1'), false);

  /* ---- 一键删除 ---- */
  seed();
  check('一键删除返回删掉的条数', await T.clearAllSavedTabs(), 3);
  tabs = await T.getSavedTabs();
  check('  待办清空了', tabs.active.map(t => t.id), []);
  check('  归档一条没动', tabs.archived.map(t => t.id), ['r1', 'r2']);

  // 走的是 dismissed 标记，和单条删除同一个字段 —— 两套语义以后会打架
  check('  删掉的是打标记，不是真从存储里抹掉',
    store.deferred.filter(t => t.dismissed).map(t => t.id).sort(),
    ['a1', 'a2', 'a3', 'x1']);

  // 归档里那些虽然也在 deferred 里，但不能被一键删除扫到
  check('  归档条目没有被顺手打上 dismissed',
    store.deferred.filter(t => t.id === 'r1' || t.id === 'r2').map(t => !!t.dismissed),
    [false, false]);

  store.deferred = [
    { id: 'r1', url: 'https://d.com/4', title: 'D', completed: true, dismissed: false },
  ];
  check('待办已经是空的 → 返回 0', await T.clearAllSavedTabs(), 0);
  check('  而且归档还是原样', (await T.getSavedTabs()).archived.length, 1);

  store.deferred = [];
  check('什么都没有时也不炸', await T.clearAllSavedTabs(), 0);

  /* ---- 归档还原 ---- */
  seed();
  check('还原一条归档', await T.restoreArchivedTab('r1'), true);
  tabs = await T.getSavedTabs();
  check('  它回到了待办里', tabs.active.map(t => t.id), ['a1', 'a2', 'a3', 'r1']);
  check('  归档里少了一条', tabs.archived.map(t => t.id), ['r2']);

  const restored = store.deferred.find(t => t.id === 'r1');
  check('  completed 翻回 false', restored.completed, false);
  // completedAt 留着的话，这条下次再归档时显示的「多久之前」是上一轮的时间
  check('  completedAt 被清掉了（不许留着旧时间）',
    'completedAt' in restored, false);

  check('还原不存在的 id → false，不炸', await T.restoreArchivedTab('不存在的'), false);
  check('  undefined 也一样', await T.restoreArchivedTab(undefined), false);

  // 往返一次：还原 → 再打勾 → 再还原。归档区的时间戳每次都该是新的
  await T.checkOffSavedTab('r1');
  check('还原完再打勾，又回到归档', (await T.getSavedTabs()).archived.map(t => t.id).sort(),
    ['r1', 'r2']);
  check('  这一轮重新记了 completedAt',
    typeof store.deferred.find(t => t.id === 'r1').completedAt, 'string');

  // 被删掉的条目（dismissed）不该被还原捞回来
  seed();
  await T.restoreArchivedTab('x1');
  check('被删掉的条目不会被还原捞回来',
    [...(await T.getSavedTabs()).active.map(t => t.id)], ['a1', 'a2', 'a3']);

  /* ---- 两段式确认 ----
     别用「源码里有没有 dataset.confirming 这行字」去守：把 `if (cond)` 改成
     `if (false)` 那段文本还在，正则照样匹配得上 —— 一条永远不会红的守卫
     不是守卫。所以这里直接调 confirmOrArm 验行为。 */
  function fakeArmButton() {
    return {
      dataset: {},
      innerHTML: '原始文案',
      isConnected: true,
      _classes: new Set(),
      classList: {
        add(c)    { this._owner._classes.add(c); },
        remove(c) { this._owner._classes.delete(c); },
      },
    };
  }
  function armButton() { const b = fakeArmButton(); b.classList._owner = b; return b; }

  const btn = armButton();
  check('第一次点不放行（只进入确认态）', T.confirmOrArm(btn, '确认？', 20), false);
  check('  按钮进了确认态', btn.dataset.confirming, '1');
  check('  文案换成确认态的那句', btn.innerHTML, '确认？');
  check('  加了 confirming 类（不然点了毫无视觉反馈）',
    [...btn._classes], ['confirming']);
  check('第二次点才放行', T.confirmOrArm(btn, '确认？', 20), true);

  const btn2 = armButton();
  T.confirmOrArm(btn2, '确认？', 20);
  await new Promise(r => setTimeout(r, 80));
  check('超时自动复位（不会一直挂在「再点一次就删」上）',
    [btn2.dataset.confirming, btn2.innerHTML], ['', '原始文案']);
  check('  复位把 confirming 类也去掉了', [...btn2._classes], []);

  // 按钮已经被移出 DOM 时（列表重画）不该再往回写，写了会复活一个死节点
  const btn3 = armButton();
  T.confirmOrArm(btn3, '确认？', 20);
  btn3.isConnected = false;
  btn3.innerHTML = '被重画覆盖过';
  await new Promise(r => setTimeout(r, 80));
  check('  按钮已不在 DOM 里就不复位（别覆盖新按钮）', btn3.innerHTML, '被重画覆盖过');

  /* ---- 静态守卫 ----
     ⚠️ 别写 `/action === 'x'[\s\S]*?confirmOrArm\(/`：那串 `[\s\S]*?` 会一路
     跨到**后面**的其它处理块里去，于是在这个块里把确认删掉、守卫照样是绿的
     （变异测试当场抓到了这条）。必须先切出这一个处理块再找。 */
  const handlerBlock = (src, name) => {
    const start = src.indexOf(`if (action === '${name}') {`);
    if (start === -1) return '';
    const end = src.indexOf("\n  if (action === '", start + 1);
    return src.slice(start, end === -1 ? src.length : end);
  };

  check('一键删除真的走了 confirmOrArm',
    handlerBlock(APP_SRC, 'clear-all-saved').includes('confirmOrArm('), true);
  check('关闭全部也复用同一份确认逻辑（不再各抄一遍）',
    handlerBlock(APP_SRC, 'close-all-open-tabs').includes('confirmOrArm('), true);
  check('  源码里没有第二份手抄的确认代码',
    (APP_SRC.match(/dataset\.confirming/g) || []).length, 3);

  // 确认态的样式如果只认 .close-tabs，新按钮点了会毫无视觉反馈
  check('确认态的样式不再只认 .close-tabs',
    /\.action-btn\.confirming\s*\{/.test(CSS_SRC), true);

  check('归档条目里有还原按钮', APP_SRC.includes("data-action=\"restore-archived\""), true);
  check('  还原按钮在删除按钮前面（正向动作在前）',
    APP_SRC.indexOf('restore-archived') < APP_SRC.indexOf('delete-archived'), true);

  const newKeys = ['deferred.clearAll', 'archive.restore',
    'toast.confirmClearSaved', 'toast.clearedSaved', 'toast.archivedRestored'];
  check('新增文案中英齐全',
    newKeys.filter(k => !(k in S.STRINGS.zh) || !(k in S.STRINGS.en)), []);
}

/* ==================================================================
   PART 14 — 跨浏览器（Chrome / Edge / Firefox）

   归拢要同时上架三家商店。绝大部分 API 三家是一样的（都走 chrome.*，
   Firefox 把 chrome 当 browser 的别名），真正不同的只有几件小事，全部
   收在 env.js 里。

   这一组守两件事：
     ① 行为 —— 喂 Firefox 的 UA，该变的都变了（新标签页地址、快捷键页、
        favicon 端点），该不变的没变。
     ② 源码 —— 不许再出现写死的 chrome-extension:// / chrome:// 地址。
        这类写法在 Chrome 上一切正常、在 Firefox 上静默失效，是最难
        发现的一类 bug，只能靠静态扫描兜住。

   ⚠️ 扫源码前先剥注释：说明文字里提到 chrome-extension:// 会被自己的守卫点着。
   ================================================================== */
async function part14() {
  console.log('\n[PART 14] 跨浏览器（Chrome / Edge / Firefox）');

  const ENV_SRC  = fs.readFileSync(path.join(EXT, 'env.js'), 'utf8');
  const APP_SRC  = fs.readFileSync(APP, 'utf8');
  const BG_SRC   = fs.readFileSync(path.join(EXT, 'background.js'), 'utf8');
  const STR_SRC  = fs.readFileSync(path.join(EXT, 'strings.js'), 'utf8');
  const HTML_SRC = fs.readFileSync(path.join(EXT, 'index.html'), 'utf8');
  const MANIFEST = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));

  const FF_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:142.0) Gecko/20100101 Firefox/142.0';
  const CH_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
  const ED_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0';

  const makeEnv = sandbox.__env.makeEnv;

  check('Firefox 的 UA 认得出来', makeEnv(FF_UA).isFirefox, true);
  check('Chrome 的 UA 认得出来',  makeEnv(CH_UA).isFirefox, false);
  check('Edge 的 UA 也算 Chromium', makeEnv(ED_UA).isFirefox, false);

  const ff = makeEnv(FF_UA);
  const cr = makeEnv(CH_UA);

  // ---- 地址差异 ----
  check('Firefox 的新标签页是 about:newtab / about:home',
    ff.browserNewtabUrls, ['about:newtab', 'about:home']);
  check('  Firefox 上没有 chrome://newtab/',
    ff.browserNewtabUrls.includes('chrome://newtab/'), false);
  check('Chromium 的新标签页里有 chrome://newtab/',
    cr.browserNewtabUrls.includes('chrome://newtab/'), true);
  check('Firefox 改快捷键去 about:addons', ff.shortcutsUrl, 'about:addons');
  check('Chromium 改快捷键去 chrome://extensions/shortcuts',
    cr.shortcutsUrl, 'chrome://extensions/shortcuts');

  // ---- 唯一的功能差异：_favicon 只存在于 Chromium ----
  check('Chromium 有 _favicon 端点', cr.hasFaviconEndpoint, true);
  check('  Firefox 没有（Mozilla 没做等价物）', ff.hasFaviconEndpoint, false);

  // ---- 内部页的判定 ----
  const isInternal = sandbox.__env.isInternalUrl;
  check('moz-extension:// 算内部页', isInternal('moz-extension://abc/index.html'), true);
  check('  （这一条是 Firefox 的扩展页 scheme，漏了角标就会把它数进去）',
    isInternal('moz-extension://abc/index.html'), true);
  check('about:newtab 算内部页',  isInternal('about:newtab'), true);
  check('about:blank 算内部页',   isInternal('about:blank'), true);
  check('chrome:// 算内部页',     isInternal('chrome://extensions'), true);
  check('edge:// 算内部页',       isInternal('edge://settings'), true);
  check('https 不算内部页',       isInternal('https://example.com/a'), false);
  check('file:// 不算内部页',     isInternal('file:///Users/a/b.html'), false);

  /* ---- 行为：真实标签页的判定在 Firefox 上也要对 ----
     openTabs 里混进一个 moz-extension:// 的（Firefox 上扩展页就是这个 scheme）
     和一个 about:newtab —— 两个都必须被排除，只留真网页。 */
  const savedTabs = fakeTabs;
  fakeTabs = [
    { id: 1, url: 'https://a.com/1', title: 'A', windowId: 1, active: true },
    { id: 2, url: 'moz-extension://abc/index.html', title: 'B', windowId: 1, active: false },
    { id: 3, url: 'about:newtab', title: 'C', windowId: 1, active: false },
  ];
  await T.fetchOpenTabs();
  check('Firefox 的扩展页 / about:newtab 都不算真实标签页',
    T.getRealTabs().map(t => t.url), ['https://a.com/1']);
  fakeTabs = savedTabs;

  // ---- 行为：Firefox 上不建 favicon 的 <img>，直接露首字母色块 ----
  const savedEnv = sandbox.GL_ENV;
  try {
    sandbox.GL_ENV = ff;
    check('Firefox 上 faviconUrlFor 给空串',
      T.faviconUrlFor('https://example.com'), '');
    check('  于是 resolveSiteIcon 也不给 img（露色块）',
      T.resolveSiteIcon({ url: 'https://example.com' }, 'Example').img, '');
    sandbox.GL_ENV = cr;
    check('Chromium 上 faviconUrlFor 走 _favicon',
      T.faviconUrlFor('https://example.com').includes('/_favicon/?pageUrl='), true);
    check('  而且是 chrome.runtime.getURL 拼出来的，不是写死 scheme',
      T.faviconUrlFor('https://example.com').startsWith(`chrome-extension://${EXT_ID}/_favicon/`), true);
  } finally {
    sandbox.GL_ENV = savedEnv;
  }

  // ---- 静态：三家地址都不许再写死在源码 / 文案里 ----
  const strip = stripComments;

  /* envOf() / bgEnv() 里那份「拿不到 env.js 时的兜底」按定义就得写死 Chromium
     的地址 —— 那是**唯一**合法的例外。扫之前先把这两个函数体挖掉，
     剩下任何地方都不许再出现一家的地址。 */
  const withoutFallback = s => {
    let out = s;
    for (const name of ['function envOf(', 'function bgEnv(']) {
      const i = out.indexOf(name);
      if (i === -1) continue;
      const j = out.indexOf('\n}', i);
      out = out.slice(0, i) + (j === -1 ? '' : out.slice(j + 2));
    }
    return out;
  };

  const APP_CODE = withoutFallback(strip(APP_SRC));
  const BG_CODE  = withoutFallback(strip(BG_SRC));
  const STR_CODE = strip(STR_SRC);

  check('app.js 里没有写死的 chrome-extension:// 拼接',
    /['"`]chrome-extension:\/\//.test(APP_CODE), false);
  check('  background.js 同样没有',
    /['"`]chrome-extension:\/\//.test(BG_CODE), false);
  check('app.js 里没有写死的 chrome://newtab/',
    APP_CODE.includes('chrome://newtab/'), false);
  check('  background.js 同样没有',
    BG_CODE.includes('chrome://newtab/'), false);
  check('app.js 里没有写死的 chrome://extensions/shortcuts',
    APP_CODE.includes('chrome://extensions/shortcuts'), false);
  // 内部页清单归 env.js 管：手写 startsWith('chrome:') 就等于把 Firefox 忘了
  check('app.js 里没有手写 chrome: 前缀判断',
    /startsWith\(\s*['"]chrome:/.test(APP_CODE), false);
  check('  background.js 同样没有',
    /startsWith\(\s*['"]chrome:/.test(BG_CODE), false);

  // 兜底那一份必须跟 env.js 算出来的 Chromium 值一致，不然「没加载 env.js」
  // 和「加载了」会给出两套行为，那才是真的难查
  try {
    sandbox.GL_ENV = undefined;
    const fb = T.envOf();
    check('拿不到 env.js 时兜底成 Chromium（跟 env.js 算出来的值一致）',
      [fb.shortcutsUrl, fb.hasFaviconEndpoint, fb.browserNewtabUrls],
      [cr.shortcutsUrl, cr.hasFaviconEndpoint, cr.browserNewtabUrls]);
  } finally {
    sandbox.GL_ENV = savedEnv;
  }

  // Firefox 上没有 _favicon，就不该为「默认地球图的指纹」发一次必然失败的请求
  const gds = APP_CODE.slice(APP_CODE.indexOf('function getDefaultFaviconSignature'));
  check('  getDefaultFaviconSignature 认 hasFaviconEndpoint（Firefox 不发无谓请求）',
    gds.slice(0, 400).includes('hasFaviconEndpoint'), true);
  check('文案表里没有写死任何一家的 chrome:// 地址',
    /chrome:\/\/|moz-extension:\/\//.test(STR_CODE), false);
  check('  快捷键那句提示用的是 {url} 占位',
    S.STRINGS.zh['toast.shortcutUnavailable'].includes('{url}'), true);
  check('  英文版也用 {url}',
    S.STRINGS.en['toast.shortcutUnavailable'].includes('{url}'), true);

  // ---- env.js 必须真的被引进页面，且排在 app.js 前面 ----
  check('index.html 里引入了 env.js',
    /<script src="env\.js"><\/script>/.test(HTML_SRC), true);
  check('  env.js 排在 app.js 前面（app.js 顶层就要用它）',
    HTML_SRC.indexOf('src="env.js"') < HTML_SRC.indexOf('src="app.js"'), true);
  check('background.js 会自己拉 env.js（Chrome 的 service worker 没有 scripts 键）',
    BG_CODE.includes("importScripts('./env.js')"), true);

  // ---- manifest：三家都支持的那些东西不许丢 ----
  check('manifest 用 chrome_url_overrides 抢新标签页（三家都支持）',
    MANIFEST.chrome_url_overrides && MANIFEST.chrome_url_overrides.newtab, 'index.html');
  check('topSites 权限还在（Chrome 28+ / Firefox 63+ 都有）',
    (MANIFEST.permissions || []).includes('topSites'), true);
  check('search 权限还在（Chrome 87+ / Edge 87+ / Firefox 111+ 都有）',
    (MANIFEST.permissions || []).includes('search'), true);
  check('env.js 是有内容的（不是空文件占位）',
    ENV_SRC.includes('hasFaviconEndpoint') && ENV_SRC.includes('browserNewtabUrls'), true);

  // ---- README 里 Firefox 的加载路径必须指向 dist/firefox 那份 ----
  /* 踩过的坑：README 曾写「选 extension/manifest.json」。那份是 Chromium 的，
     Firefox 不认 background.service_worker（它跑 background.scripts），塞给它
     后台根本不启动 —— 页面看着正常，但角标不动、快捷键无效。这是最难查的那种
     半残：没有任何报错，只是少了一半功能。这条守的是文档指错文件。 */
  /* ---- Firefox 那个「选错 manifest」的坑，必须写在指南里 ----
     README 是给用户看的门面，不放「从源码加载」那套细节（那些对用户是纯负担）。
     但坑本身不能丢：Firefox 不认 background.service_worker（它跑 background.scripts），
     把 Chromium 那份 manifest 塞给它，后台根本不启动 —— 页面看着正常，角标不动、
     快捷键无效，**没有任何报错**，最难查的那种半残。所以守卫从 README 挪到指南。 */
  const README_SRC = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const GUIDE_PATH = path.join(ROOT, 'docs', 'firefox-安装指南.md');
  const GUIDE_SRC  = fs.existsSync(GUIDE_PATH) ? fs.readFileSync(GUIDE_PATH, 'utf8') : '';
  check('Firefox 安装指南在', GUIDE_SRC.length > 0, true);
  check('  指南要求先打包（产物才带 gecko 那份 manifest）',
    GUIDE_SRC.includes('build-store.js'), true);
  check('  指南指向 dist/firefox/manifest.json',
    GUIDE_SRC.includes('dist/firefox/manifest.json'), true);
  check('  指南明确说了不要选 extension/manifest.json',
    GUIDE_SRC.includes('不要选 `extension/manifest.json`'), true);
  check('  指南解释了为什么（Firefox 不认 service_worker）',
    GUIDE_SRC.includes('background.service_worker'), true);
  check('README 链接到了 Firefox 安装指南',
    README_SRC.includes('docs/firefox-安装指南.md'), true);
}

/* ==================================================================
   PART 15 — 字体自托管（Mac / Windows 一致 + 零网络请求）

   原来 index.html 挂着一条 fonts.googleapis.com 的 <link>：每开一个新标签页
   就往 Google 发一次请求，跟「唯一的对外请求是天气」这句话对不上；国内拉不到
   时 Mac 回退苹方、**Windows 回退微软雅黑/宋体** —— 同一个扩展两个系统长得
   不一样。现在字体随包走（extension/fonts/），两个系统的拉丁部分完全一致。

   汉字仍然用各系统自己的字体（苹方 / 微软雅黑）—— 包一个能看的中文字体
   10 MB 起，不值。代价是汉字在两个系统上仍是两种字体，但**都落在各自
   最好看的那个上**，而不是回退出来的那个。

   这一组守三件事：
     ① 页面里不许再有任何外链（零网络请求这条承诺要能被机器验证）；
     ② 字体文件真的在包里、且是真 woff2（少一张只会静默掉回系统字体）；
     ③ 两条字体栈里的**中文字体必须一致** —— 一条用苹方、一条用宋体的话，
        Mac 和 Windows 就又不一样了，而这种错肉眼很难发现。
   ================================================================== */
function part15() {
  console.log('\n[PART 15] 字体自托管（跨平台一致 + 零网络请求）');

  const HTML_SRC = fs.readFileSync(path.join(EXT, 'index.html'), 'utf8');
  const CSS_SRC  = fs.readFileSync(path.join(EXT, 'style.css'), 'utf8');
  const FONTS    = path.join(EXT, 'fonts');

  /* ---- ① 页面里不许有任何外链 ----
     天气是**唯一**允许联网的地方，而它走的是 app.js 里的 fetch，
     不是页面上的 <link>/<script>/<img>。所以 HTML 里出现任何 http(s) 都是退步。 */
  // 只扫**会真的发请求**的那几种引用：<link href> / <script src> / <img src>。
  // 不能见 http:// 就抓：内联 SVG 的 xmlns 和页脚那个 <a href> 都不是请求。
  const htmlCode = stripComments(HTML_SRC);
  const remoteRefs = htmlCode.match(
    /<(?:link|script|img|iframe|source)\b[^>]*?(?:href|src)\s*=\s*["']https?:\/\/[^"']+/gi) || [];
  check('index.html 里没有任何外链资源（字体已自托管）', remoteRefs, []);
  check('  行内样式里也没有 url(https://…)',
    /url\(\s*['"]?https?:/.test(htmlCode), false);
  check('  没有 fonts.googleapis.com',
    htmlCode.includes('fonts.googleapis.com'), false);
  check('  没有 fonts.gstatic.com',
    htmlCode.includes('fonts.gstatic.com'), false);
  check('  引的是本地那份 fonts.css',
    /<link rel="stylesheet" href="fonts\/fonts\.css">/.test(HTML_SRC), true);

  /* ---- ② 字体文件真的在、且是真 woff2 ---- */
  check('extension/fonts/ 目录在', fs.existsSync(FONTS), true);
  const woff2 = fs.readdirSync(FONTS).filter(f => f.endsWith('.woff2'));
  check('至少下了两张字体', woff2.length >= 2, true);
  check('  每张都是真 woff2（魔数 wOF2）',
    woff2.filter(f => fs.readFileSync(path.join(FONTS, f)).subarray(0, 4).toString('latin1') !== 'wOF2'), []);
  check('  每张都不是空文件',
    woff2.filter(f => fs.statSync(path.join(FONTS, f)).size < 1024), []);

  const fontsCss = fs.readFileSync(path.join(FONTS, 'fonts.css'), 'utf8');
  check('fonts.css 里没有外链',
    /https?:\/\//.test(stripComments(fontsCss)), false);
  const srcs = [...fontsCss.matchAll(/url\(['"]?([^'")]+)['"]?\)/g)].map(m => m[1]);
  check('fonts.css 里每条 src 都指着一个本地文件',
    srcs.filter(s => !/^[a-z0-9-]+\.woff2$/.test(s)), []);
  check('  而且这些文件都真的在',
    srcs.filter(s => !fs.existsSync(path.join(FONTS, s))), []);
  check('  两个字体都声明了',
    fontsCss.includes("'DM Sans'") && fontsCss.includes("'Newsreader'"), true);
  check('  斜体也声明了（CSS 里有 5 处 font-style: italic）',
    fontsCss.includes('font-style: italic'), true);

  /* ---- ③ 两条字体栈的中文字体必须一致 ---- */
  const stacks = [...CSS_SRC.matchAll(/font-family:\s*'(DM Sans|Newsreader)'[^;]+;/g)].map(m => m[0]);
  check('两条字体栈都抓到了（正文 + 标题）', stacks.length >= 2, true);

  // 中文字体名：苹方（Mac）/ 雅黑（Windows）。两条栈必须给出同一个集合。
  // ⚠️ 长名要排在短名前面：'Microsoft YaHei UI' 会被 'Microsoft YaHei' 先吃掉
  const CN = /Songti SC|Hiragino Sans GB|STSong|Microsoft YaHei UI|Microsoft YaHei|PingFang SC|SimSun/g;
  const sets = stacks.map(s => [...new Set(s.match(CN) || [])].sort());
  check('每条字体栈里都有中文字体（漏了汉字就会掉回默认字体）',
    sets.filter(s => s.length === 0).length, 0);
  check('  所有字体栈用的是**同一套**中文字体（不然 Mac / Windows 又不一样了）',
    [...new Set(sets.map(s => JSON.stringify(s)))].length, 1);
  check('  具体是哪几个', sets[0] || [],
    ['Hiragino Sans GB', 'Microsoft YaHei', 'Microsoft YaHei UI', 'PingFang SC']);
}

/* ==================================================================
   PART 16 — README 的结构不变量

   README 是一张漏斗：路人十秒、试用者五分钟、深度用户长期。这一组
   只守「改 README 时最容易静默坏掉、而且本地看不出来」的三件事：

     ① 目录锚点。改一次标题文字，锚点就成了死链 —— markdown 渲染器
        不会报错，GitHub 上点了没反应，只有点的人知道。
     ② 仓库内的链接。文档改名或搬目录，链接 404，同样不报错。
     ③ 许可证压轴。这是 README 规范里唯一强制位置的一条。

   边界：只扫 README 本身，不碰 docs/ 的措辞 —— 那边的文字是给人读的，
   守卫管不了，也不该管。
   ================================================================== */
function part16() {
  console.log('\n[PART 16] README 结构（目录锚点 / 无死链 / 许可证压轴）');

  const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

  // ---- ① 目录里的每个锚点，正文里都要有一篇同名标题 ----
  const headings = [...README.matchAll(/^##\s+(.+?)\s*$/gm)].map(m => m[1]);
  const toc = [...README.matchAll(/^\s*-\s*\[([^\]]+)\]\(#([^)]+)\)\s*$/gm)];
  check('README 有目录', toc.length >= 5, true);
  check('  目录里每个锚点都对得上一篇真实标题',
    toc.filter(([, text]) => headings.indexOf(text) === -1).map(([, text]) => text), []);
  check('  目录里不列「目录」自己',
    toc.some(([, text]) => text === '目录'), false);

  // ---- ② 指向仓库内文件的链接不许是死的 ----
  const local = [...README.matchAll(/\]\((?!https?:|#)([^)]+)\)/g)]
    .map(m => m[1].split('#')[0])
    .filter(p => p.length > 0);
  check('README 里指向仓库内的链接都真的存在',
    [...new Set(local)].filter(p => !fs.existsSync(path.join(ROOT, p))), []);

  // ---- ③ 许可证压轴 ----
  check('最后一个小节是许可证（规范里唯一强制位置的一条）',
    headings[headings.length - 1], '许可证');
}

/* =================================================================
   PART 17 — 界面语言（中英切换 / 默认跟随系统）

   这一块的形状**刻意和主题一样**，因为会踩的坑也一样：

     1. 存储里存的是「选了什么」（可能是 system），真画出来的是「用了哪个」
        （zh 还是 en）。这两个必须分开 —— 否则用户打开设置会看到选项莫名停在
        中文上，他明明选的是「跟随系统」。normalizeLanguage 保 system，
        resolveLanguage 才把它解掉。
     2. 读系统语言必须能失败。沙箱里没有 navigator，取不到就回**默认中文**，
        既不把界面搞成空白，也不能因为读不到就悄悄跳成英文 ——
        中文用户会一脸茫然。
     3. 语言是界面级状态：它必须在 applyStaticStrings 之前落定，
        否则会先画一屏旧语言、再翻过来。
     4. 下拉里 option 的文字一律走文案表 —— 拿它的文字做判断，翻译之后就
        认不出来了（和 PART 9 那条老坑是同一种形状）。
   ================================================================= */
function part17() {
  console.log('\n[PART 17] 界面语言（中英 / 默认跟随系统）');

  /* ---- 存的值：不认识的一律回「跟随系统」，而不是回中文 ---- */
  check('normalizeLanguage 原样保留 system', S.normalizeLanguage('system'), 'system');
  check('normalizeLanguage 认得 zh / en',
    [S.normalizeLanguage('zh'), S.normalizeLanguage('en')], ['zh', 'en']);
  check('normalizeLanguage 把不认识的拉回默认（跟随系统）',
    [undefined, null, '', 'ZH', 'jp', true, 42, {}].map(v => S.normalizeLanguage(v)),
    Array(8).fill(S.LANG_SYSTEM));

  /* ---- 真正用的语言：system 在这一步被解掉 ---- */
  check('跟随系统 + 中文系统 → zh',   S.resolveLanguage('system', 'zh-CN'), 'zh');
  check('跟随系统 + 纯 zh → zh',     S.resolveLanguage('system', 'zh'),    'zh');
  check('跟随系统 + 英文系统 → en',   S.resolveLanguage('system', 'en-US'), 'en');
  check('跟随系统 + 非中文系统 → en', S.resolveLanguage('system', 'ja-JP'), 'en');
  // 沙箱里没有 navigator，systemLanguage() 给的是空串。取不到线索时回默认中文。
  check('取不到系统语言 → 回默认中文', S.resolveLanguage('system', ''), 'zh');
  check('显式选了 zh，系统是英文也不改', S.resolveLanguage('zh', 'en-US'), 'zh');
  check('显式选了 en，系统是中文也不改', S.resolveLanguage('en', 'zh-CN'), 'en');
  check('存的是脏数据 → 当跟随系统处理', S.resolveLanguage('nope', 'en-US'), 'en');

  /* ---- 默认值：跟随系统，而且是存储里那份默认 ---- */
  check('DEFAULT_LANGUAGE 就是「跟随系统」', S.DEFAULT_LANGUAGE, S.LANG_SYSTEM);
  check('uiPrefs 的默认语言是「跟随系统」（新装用户第一眼跟着系统走）',
    T.UI_PREFS_DEFAULTS.language, S.LANG_SYSTEM);
  check('界面语言只有 zh / en 两个可选', S.LANG_IDS, ['zh', 'en']);

  /* ---- 取不到系统语言时不许炸 ---- */
  check('沙箱里 systemLanguage() 返回空串、不抛错', T.systemLanguage(), '');

  /* ---- applyLanguage：把偏好落成「当前界面语言」 ---- */
  check('applyLanguage 把界面切成英文', T.applyLanguage('en'), 'en');
  check('  切完 LANG 真的是英文', S.getLang(), 'en');
  check('applyLanguage 认「跟随系统」（沙箱无 navigator → 中文）',
    T.applyLanguage('system'), 'zh');
  check('  切回中文', S.getLang(), 'zh');
  S.setLang('zh');

  /* ---- 静态：设置面板里的下拉 ---- */
  const HTML_SRC = srcOf('index.html');
  const langOpts = [...HTML_SRC.matchAll(
    /<option value="([a-z]+)"[^>]*data-i18n="lang\.([a-z]+)"/g)].map(m => m[1]);
  check('设置面板里有语言下拉', /data-setting="language"/.test(HTML_SRC), true);
  check('语言下拉正好三个选项：跟随系统 / 中文 / 英文',
    langOpts, ['system', 'zh', 'en']);
  check('每个语言选项的文字都在文案表里',
    ['lang.system', 'lang.zh', 'lang.en']
      .filter(k => !(k in S.STRINGS.zh) || !(k in S.STRINGS.en)), []);
  check('语言那两行（名字 / 说明）也在表里',
    ['settings.language.name', 'settings.language.desc']
      .filter(k => !(k in S.STRINGS.zh) || !(k in S.STRINGS.en)), []);

  /* ---- 静态：顺序与重画 ---- */
  const APP_SRC = fs.readFileSync(APP, 'utf8');

  // 语言必须在填静态文案之前落定，否则会先画一屏旧语言
  const ia = APP_SRC.indexOf('const prefs = await applyUiPrefs();');
  const ib = APP_SRC.indexOf('applyStaticStrings();', ia);
  check('renderDashboard 里 applyUiPrefs（含落语言）排在 applyStaticStrings 之前',
    ia > -1 && ib > ia, true);

  // 换语言要整块重画，而且不许抢光标（用户正待在设置面板里）
  check('换语言会整块重画仪表盘、且不抢光标',
    /key === 'language'[\s\S]{0,160}renderDashboard\(\{\s*focus:\s*false\s*\}\)/.test(APP_SRC),
    true);

  // 页面标题也走表：中文「归拢」，英文「Guilong」
  check('中文页面标题是「归拢」', S.STRINGS.zh['doc.title'], '归拢');
  check('  英文页面标题是 Guilong', S.STRINGS.en['doc.title'], 'Guilong');
  check('applyStaticStrings 会把 document.title 换成当前语言的',
    /document\.title = T\('doc\.title'\)/.test(srcOf('strings.js')), true);

  /* ---- 静态：文档里写的默认值必须和代码里的一致 ----
     这是最会静默漂移的一类：改了 UI_PREFS_DEFAULTS，README 的「默认」列和
     商店文案还写着老值，页面上看着一切正常。上面刚把站点条 / 搜索框从「开」
     改成「关」，正是这条守卫要盯的时刻。 */
  const README_SRC = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  // ⚠️ 只切出「## 设置」那一节再找行：功能表里的行标签和设置表**重名**
  //    （常用站点条 / 搜索框 / 当地天气 / 主题色），不切片会抓到功能表去。
  const setFrom = README_SRC.indexOf('## 设置');
  const SET_SECTION = README_SRC.slice(setFrom, README_SRC.indexOf('\n## ', setFrom));
  const zhText = k => S.STRINGS.zh[k];
  const readmeDefault = label => {
    const m = SET_SECTION.match(
      new RegExp('^\\|\\s*' + label + '\\s*\\|\\s*([^|]+?)\\s*\\|', 'm'));
    return m ? m[1] : null;
  };
  // 主题色那一行不在这条守卫里：设置表写的是「纸感」，而下拉的选项文案是
  // 「纸感（默认）」，两处措辞本来就不同，硬映射只会造出一条假断言。
  const codeDefault = {
    '常用站点条': T.UI_PREFS_DEFAULTS.showQuickSites ? '开' : '关',
    '搜索框':     T.UI_PREFS_DEFAULTS.showSearchBox ? '开' : '关',
    '当地天气':   T.UI_PREFS_DEFAULTS.showWeather  ? '开' : '关',
    // 'system' → 表里那条 'lang.system'，正是设置面板下拉里显示的那个词
    '界面语言':   zhText('lang.' + T.UI_PREFS_DEFAULTS.language),
  };
  check('README 设置表的「默认」列和代码里的默认值一致',
    Object.keys(codeDefault)
      .filter(k => readmeDefault(k) !== codeDefault[k])
      .map(k => `${k}：README 写「${readmeDefault(k)}」，代码是「${codeDefault[k]}」`), []);

  // 商店文案和 agent 手册里那两句「默认中文」也得跟着改 —— 商店那行是
  // 用户真正读到的文字，它写错就是对外说错话。
  const STORE_SRC = fs.readFileSync(path.join(ROOT, 'store/上架文案.md'), 'utf8');
  const AGENTS_SRC = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
  check('商店文案里「中英双语」那行写的是跟随系统，不是默认中文',
    /【中英双语】[^\n]*跟随系统/.test(STORE_SRC), true);
  check('  AGENTS.md 也说跟随系统，不说默认中文',
    /默认跟随系统/.test(AGENTS_SRC), true);
  check('  没有任何一份文档还在说「默认中文」',
    ['README.md', 'AGENTS.md', 'store/上架文案.md']
      .filter(f => /默认中文/.test(fs.readFileSync(path.join(ROOT, f), 'utf8'))), []);
}

/* =================================================================
   PART 18 — 设置面板是「居中悬浮的模态」

   需求原话：「按一下设置按钮之后的逻辑不是让设置面板出现在和页面平行的
   空间中，而是类似于一个独立的面板，不改变页面的逻辑，居中悬浮的感觉，
   页面虚化。」

   翻成三条可验证的性质：
     ① **不改变页面布局** —— 面板必须脱离文档流。做法是原生 <dialog> +
        showModal()，浏览器把它放进 top layer；写成普通 div 再切 class 的话
        它还在流里，下面的网格会被顶下去，正是要改掉的那个行为。
     ② **居中悬浮** —— 交给对话框的原生默认（inset:0 + margin:auto），
        自己不写 margin 去凑。
     ③ **页面虚化** —— 只能挂在 ::backdrop 上。挂到面板本身上虚化的是面板
        自己，观感正好相反，而且**不会报错**。

   前两条靠直接调 openSettingsPanel / closeSettingsPanel 验行为，
   第三条只能静态扫 CSS 文本 —— 冒烟测试跑不了真正的合成渲染。
   ================================================================= */

/** 造一个会真的记录 class 和开关状态的假面板（fakeDomNode 的 classList 是空壳） */
function fakePanelNode() {
  const classes = new Set();
  return {
    open: false,
    showModalCalls: 0,
    closeCalls: 0,
    style: {},
    dataset: {},
    classList: {
      add: c => classes.add(c),
      remove: c => classes.delete(c),
      toggle: (c, on) => {
        if (on === undefined) { classes.has(c) ? classes.delete(c) : classes.add(c); }
        else if (on) classes.add(c); else classes.delete(c);
      },
      contains: c => classes.has(c),
    },
    showModal() { this.showModalCalls++; this.open = true; },
    close() { this.closeCalls++; this.open = false; },
  };
}

function part18() {
  console.log('\n[PART 18] 设置面板：居中悬浮的模态');

  /* ---- 行为：开 / 关走的是对话框的原生开关，不是切 class ---- */
  const panel = fakePanelNode();
  const gear  = fakePanelNode();
  domNodes.set('settingsPanel', panel);
  domNodes.set('settingsToggle', gear);

  check('openSettingsPanel 走 showModal()（脱离文档流，不是切 class）',
    (T.openSettingsPanel(), [panel.showModalCalls, panel.open]), [1, true]);
  check('  齿轮同步进入打开态', gear.classList.contains('open'), true);

  // ⚠️ 对已经打开的 dialog 再 showModal() 会抛 InvalidStateError。
  // 真机上「打开设置 → 换主题 → 又点一下齿轮」就会走到这里。
  check('已经开着时再调一次不会重复 showModal()',
    (T.openSettingsPanel(), panel.showModalCalls), 1);

  check('closeSettingsPanel 走原生 close()',
    (T.closeSettingsPanel(), [panel.closeCalls, panel.open]), [1, false]);
  check('  齿轮同步熄灭（Esc 关掉时也靠这条路径补回来）',
    gear.classList.contains('open'), false);
  check('对已经关着的面板再关一次不抛错',
    (T.closeSettingsPanel(), panel.closeCalls > 1), true);

  // 面板 id 不在页面上时（比如别的页面复用了这个脚本）不许炸
  domNodes.delete('settingsPanel');
  check('找不到面板时打开返回 false、不抛错', T.openSettingsPanel(), false);
  check('  关闭同样不抛错', (T.closeSettingsPanel(), true), true);
  domNodes.set('settingsPanel', panel);

  /* ---- 静态 ---- */
  const HTML_SRC = srcOf('index.html');
  const CSS_SRC  = fs.readFileSync(path.join(EXT, 'style.css'), 'utf8');
  const APP_SRC  = fs.readFileSync(APP, 'utf8');

  check('设置面板是 <dialog>，不是普通 div',
    /<dialog[^>]*class="settings-panel"[^>]*id="settingsPanel"/.test(HTML_SRC), true);
  check('  面板里有关闭按钮（并走文案表拿无障碍名字）',
    /data-action="close-settings"[\s\S]{0,120}data-i18n-title="settings\.close"/.test(HTML_SRC),
    true);

  // 面板本体上**不许**写 display：浏览器靠 dialog:not([open]) 自己收起来，
  // 我们再写一条 display 就把它顶死了（面板会一直杵在页面上）。
  // ⚠️ 要收**所有** .settings-panel 样式块，不能只看第一个 —— 后面再补一条
  //    覆盖规则（比如夹在 @media 里）就绕过去了。::backdrop 是伪元素，
  //    这里的正则匹配不到它。
  const panelRules = [...CSS_SRC.matchAll(/\.settings-panel\s*\{([^}]*)\}/g)].map(m => m[1]);
  const panelCss   = panelRules.join('\n');
  check('扫到了设置面板的样式块', panelRules.length >= 1, true);
  check('设置面板的 CSS 里没有 display（会和 dialog 自己的开关状态打架）',
    panelRules.filter(r => /\bdisplay\s*:/.test(r)), []);
  // ⚠️ 居中必须自己写死。UA 的模态 dialog 只把**纵向** inset 归零，横向还停在
  // 它的「静态位置」上（容器的左内边距）—— 真机上第一次就是这么错的，
  // 面板贴着左上角，看着完全不像「居中悬浮」。
  check('  居中自己写死（position:fixed + inset:0 + margin:auto）',
    /position\s*:\s*fixed/.test(panelCss)
      && /(?:^|;)\s*inset\s*:\s*0/.test(panelCss)
      && /margin\s*:\s*auto/.test(panelCss), true);

  check('backdrop-filter 挂在 ::backdrop 上（页面虚化）',
    /\.settings-panel::backdrop\s*\{[^}]*backdrop-filter\s*:\s*blur\(\s*[1-9]/.test(CSS_SRC), true);
  check('  而不是挂在面板本身上（那样虚化的是面板自己，观感正好相反）',
    panelRules.filter(r => /backdrop-filter/.test(r)), []);

  check('打开面板用的是 showModal()', /\.showModal\(\)/.test(APP_SRC), true);
  check('判断面板开没开读原生 panel.open，不读 class（Esc 关掉后 class 会过期）',
    /panel\.classList\.(contains|toggle)\(\s*'open'/.test(APP_SRC), false);

  // 只切「面板自己身上那两个监听」这一段再找，避免跨块正则跑到别处去
  const wireFrom = APP_SRC.indexOf('function wireSettingsPanel');
  const wireTo   = APP_SRC.indexOf('\n})();', wireFrom);
  const wireBlock = wireFrom > -1 && wireTo > wireFrom ? APP_SRC.slice(wireFrom, wireTo) : '';
  check('切出了面板自己的事件绑定块', wireBlock.length > 0, true);
  check('  挂了 close 事件（Esc 关闭后齿轮状态要同步）',
    /panel\.addEventListener\('close'/.test(wireBlock), true);
  check('  点背板关闭前先量落点在不在面板里',
    /getBoundingClientRect\(\)/.test(wireBlock), true);
  check('    否则点面板的内边距也会误判成「点了背板」',
    /e\.target !== panel/.test(wireBlock), true);
}

/* =================================================================
   PART 19 — index.html 里也不许写死界面文案

   2026-09-19 用全新 profile 跑 Chrome（系统语言 en-US）时发现的：页脚那条
   指向仓库的链接文字是**硬编码的「归拢」**，没走文案表 —— 切英文之后
   document.title 变成了 Guilong，页脚却还写着「归拢」。

   ⚠️ 这个缺口本来就在：PART 9 那条「没有绕开文案表写死的中文文案」**只扫了
   app.js**。index.html 这一侧从来没被扫过，所以才漏。
   补上对称的一条，把整类漏法堵住。

   判据：剥掉 HTML 注释和 `<title>` 之后，index.html 里不该再出现汉字。
     · 注释要剥 —— 本项目注释里到处是中文说明（「为什么自托管」那一大段），
       不剥的话守卫从第一天就是红的。
     · `<title>` 要放过 —— 它是 JS 跑起来之前那一瞬间的静态默认值，必须写死
       在 HTML 里；applyStaticStrings() 随后会按语言覆盖它。
   ================================================================= */
function part19() {
  console.log('\n[PART 19] index.html 里不许写死界面文案');

  const HTML_SRC = srcOf('index.html');

  const noComments = HTML_SRC.replace(/<!--[\s\S]*?-->/g, '');
  const noTitle    = noComments.replace(/<title>[\s\S]*?<\/title>/g, '');

  // 前后各留一点上下文，红了能直接看出是哪句
  const stray = (noTitle.match(/[\u4e00-\u9fff][^\n<]{0,40}/g) || [])
    .map(s => s.trim().slice(0, 50));
  check('剥掉注释与 <title> 后，HTML 里没有写死的汉字（文案要走 data-i18n）',
    stray, []);

  // 页脚那条品牌链接：文字必须来自文案表，链接本身还要在
  check('页脚的品牌链接走文案表',
    /data-i18n="footer\.brand"/.test(HTML_SRC), true);
  check('  而且它仍然是指向仓库的链接（别顺手把 <a> 删了）',
    /<a[^>]*href="https:\/\/github\.com\/qwsir32-star\/guilong"[^>]*data-i18n="footer\.brand"/.test(HTML_SRC),
    true);
  check('  中英两份表里都有 footer.brand',
    ['footer.brand' in S.STRINGS.zh, 'footer.brand' in S.STRINGS.en], [true, true]);
}

/* =================================================================
   PART 20 — 扩展里不许再冒出「第三个联网的地方」

   2026-09-19 用全新 profile 真跑 Chrome 时抓出来的：app.js 里**四处**图标
   地址直连 `google.com/s2/favicons`。其中三处（卡片里的 chip / 展开的 chip /
   稍后再看）都不是「失败了才退」——它们**一上来就问 Google**。而 chip 代表的
   是当前开着的标签页，等于每开一次新标签页就向 Google 报一遍你在逛哪些站。

   PRIVACY.md 第 64 行其实早就把判据写下来了：「为了一张图标去访问站点自己的
   服务器，会把『唯一一次联网』这句话戳破，不值得。」只是代码没跟上 ——
   这是文档和代码长期说两套话，不是漏网之鱼。

   ⚠️ 判据**不能只盯 google s2**。那只堵住这一个洞，换一家图标服务照样漏。
   改成**白名单**：把 extension/ 里所有绝对 URL 的主机名抓出来，逐个对照一张
   写死的名单。名单外多出任何一个主机名，这里就是红的 —— 要加可以，但必须
   有人**明确把它写进名单**，也就是明确承认「又开了一个联网的地方」。

   ⚠️ 扫之前必须剥注释。本项目注释里到处是「不去 Google Fonts」「别退 s2」
   这类说明，不剥的话守卫从第一天就是红的。

   ⚠️ 名单分两栏：「真联网」和「拼出来但出不了网」不许混在一起 —— 混了就没人
   知道到底哪几个是真会发请求的。
   ================================================================= */

// 真正会发请求出去的主机（有且仅有这三个）
const OUTBOUND_HOSTS = [
  'api.open-meteo.com',   // 天气。用户可以在设置里关掉
  'www.bing.com',         // 搜索兜底，只在用户主动搜索且拿不到默认引擎时
  'github.com',           // 页脚指向仓库的链接，要用户自己点
];

// 出现在代码里、但一个包都发不出去的主机
const NON_NETWORK_HOSTS = [
  'www.w3.org',                     // SVG 命名空间。它是标识符，不是地址
  'guilong-no-such-site.invalid',   // 探测「默认地球图」的假域名，喂给 _favicon
];

function part20() {
  console.log('\n[PART 20] 扩展里没有第三个联网的地方（出网主机白名单）');

  const files = [
    ...fs.readdirSync(EXT).filter(f => /\.(js|html|css)$/.test(f)),
    'fonts/fonts.css',   // 在子目录里，不在上面这次浅扫的范围内，单独带上
  ];

  const hosts = new Set();
  for (const f of files) {
    const src = stripComments(fs.readFileSync(path.join(EXT, f), 'utf8'));
    for (const m of src.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) {
      hosts.add(m[1].toLowerCase());
    }
  }

  const known   = [...OUTBOUND_HOSTS, ...NON_NETWORK_HOSTS];
  const unknown = [...hosts].filter(h => !known.includes(h)).sort();
  check('extension/ 里的绝对 URL 主机全在名单里（多一个就是多一处联网）', unknown, []);

  // 名单别写歪：3 个真联网 + 2 个不出网
  check('  名单是 3 个真联网 + 2 个不出网',
    [OUTBOUND_HOSTS.length, NON_NETWORK_HOSTS.length], [3, 2]);
  // 也别空转：名单里列着的主机必须真的还在源码里，否则是「守着一个已经拆掉的洞」
  check('  名单里的主机确实都还在源码里（不是守着一个拆掉的洞）',
    known.filter(h => !hosts.has(h)), []);

  const APP_SRC = stripComments(fs.readFileSync(APP, 'utf8'));

  // 单独再点一次名：这是这次真正修掉的洞，回归时想一眼看到它
  check('没有 google 图标服务（s2 / gstatic）',
    /google\.com\/s2|gstatic/.test(APP_SRC), false);

  // 三处 `const faviconUrl = ...` 必须全部走本地端点。
  // 期望值写死成三个 true：一处都不剩时数组对不上，也不会假绿。
  const assigns = APP_SRC.match(/const faviconUrl\s*=\s*[^;]+;/g) || [];
  check('三处 chip / 稍后再看 的图标都走 faviconUrlFor（本地读盘）',
    assigns.map(a => /faviconUrlFor\(/.test(a)), [true, true, true]);

  // 空串不许进 <img src>：Firefox 上 faviconUrlFor 返回 ''，
  // 而 `src=""` 会被解析成「当前页面地址」去加载，比不显示图标更糟。
  //
  // ⚠️ 不能只搜 `src="${faviconUrl}"` —— 加了守卫的写法里**照样**有这一段
  //（守卫在外层：`${faviconUrl ? \`<img ...\` : ''}`）。要数两边的出现次数：
  // 出现几段 src 就得有几处 `faviconUrl ?`，多出来的那个就是裸写。
  const srcSites = (APP_SRC.match(/src="\$\{faviconUrl\}"/g) || []).length;
  const guarded  = (APP_SRC.match(/faviconUrl \? `<img/g) || []).length;
  check('三处 src="${faviconUrl}" 都套了「空串就不建 <img>」的守卫',
    [srcSites, guarded], [3, 3]);

  // 兜底函数只剩删图。⚠️ 先把函数块切出来再判 —— 跨块正则一路匹配到后面
  // 的代码就会把「后面某处没有 img.src」当成「这个函数干净」。
  const fbBlock = (APP_SRC.match(/function handleFaviconError\(img\)\s*\{[\s\S]*?\n\}/) || [''])[0];
  check('切出了 handleFaviconError 的函数体（否则下面那条是假绿）',
    fbBlock.length > 0, true);
  check('  函数体只剩删图：有 img.remove()，不碰 img.src',
    [/img\.remove\(\)/.test(fbBlock), /img\.src/.test(fbBlock)], [true, false]);
}

/* ---------------- PART 21：测试文件自己的一致性 ----------------
   这一节守的是**测试文件本身**，不是被测源码。起因是两处真实存在的漂移：

   1. 头部目录注释里 `PART 10 版式静态守卫` 那一行。那一节早就拆进 PART 8
      （页头网格）/ PART 11（天气条位置）/ PART 18（设置面板结构）了，
      注释没跟着走 —— 照着注释去找守卫的人会找不到，而且找完了不觉得少东西。
   2. PART 8、9 的标题用全角【】，其余用半角[]。后果不是难看，而是
      **按 `[PART n]` 盘点分区时会静默漏掉两个** —— 漏掉的分区和
      不存在的分区，看起来一模一样。

   所以这里做三件事：格式统一、编号连续、目录注释不许再漂。
   ------------------------------------------------------------------ */
function part21() {
  console.log('\n[PART 21] 测试文件自己的一致性（分区编号 / 标题格式 / 目录注释）');
  const SELF = fs.readFileSync(__filename, 'utf8');

  /* ---- 1. 标题格式统一：只许半角方括号 ----
     ⚠️ 全角左括号这里**只能写成 \u3010 转义**。直接写那个字符的话，守卫自己的
     正则字面量里就含「全角括号紧跟着 PART」，于是它把自己点着、永远红。
     （跟「扫源码前先剥注释」是同一个坑：守卫的文本也会被守卫看见。） */
  check('分区标题一律用半角 []（全角那版会让盘点静默漏区）',
    (SELF.match(/\u3010PART /g) || []).length, 0);

  /* ---- 2. 正文里每个分区标题的编号 ---- */
  const heads = [];
  const headRe = /console\.log\('\\n\[PART (\d+)\] ([^']*)'\);/g;
  let hm;
  while ((hm = headRe.exec(SELF)) !== null) heads.push({ n: Number(hm[1]), title: hm[2] });
  const nums = heads.map(h => h.n);

  // 锚点自证：正则跟写法脱钩时 heads 会是空的，后面几条就会假绿
  check('扫到了分区标题（否则下面几条是假绿）', nums.length >= 20, true);
  check('分区编号不重复', nums.length, new Set(nums).size);
  check('分区编号连续、无缺号',
    nums.slice().sort((a, b) => a - b).join(','),
    Array.from({ length: nums.length }, (_, i) => i + 1).join(','));
  check('分区标题都非空', heads.filter(h => h.title.trim()).length, heads.length);

  /* ---- 3. 目录注释里的编号，必须和正文一一对上 ---- */
  const tocBlock = SELF.slice(0, SELF.indexOf('*/'));
  const toc = [];
  const tocRe = /^[ \t]*\*?[ \t]*PART (\d+) /gm;
  let tm;
  while ((tm = tocRe.exec(tocBlock)) !== null) toc.push(Number(tm[1]));

  check('目录注释的编号也不重复', toc.length, new Set(toc).size);
  check('目录注释的编号集合 = 正文的编号集合',
    toc.slice().sort((a, b) => a - b).join(','),
    nums.slice().sort((a, b) => a - b).join(','));

  /* ---- 4. 每个编号：目录那句和正文那节得是同一件事 ----
     判据是「共享至少一个二字中文词」。漂移的那条（目录写「版式静态守卫」、
     正文写「呼出快捷键」）一个词都对不上，所以会红。
     注意只比中文 —— 目录里带英文标识符的那几行（saveAllOpenTabs 之类）
     光靠英文也会看起来很一致。 */
  const cnBigrams = s => {
    const out = [];
    for (let i = 0; i + 1 < s.length; i++) {
      const g = s.slice(i, i + 2);
      if (/^[\u4e00-\u9fa5]{2}$/.test(g)) out.push(g);
    }
    return out;
  };
  const tocTitleOf = n => {
    const m = tocBlock.match(new RegExp('^[ \\t]*\\*?[ \\t]*PART ' + n + ' (.*)$', 'm'));
    return m ? m[1] : '';
  };
  const drifted = heads
    .filter(h => {
      const mine = cnBigrams(h.title);
      if (mine.length === 0) return false;           // 标题里没中文就不比（没有可判的）
      const theirs = new Set(cnBigrams(tocTitleOf(h.n)));
      return !mine.some(g => theirs.has(g));
    })
    .map(h => `PART ${h.n}：正文「${h.title}」↔ 目录「${tocTitleOf(h.n)}」`);

  check('目录注释每一行和正文那节还是同一件事（没有漂移的标题）', drifted, []);
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
  await part12();
  await part13();
  await part14();
  part15();
  part16();
  part17();
  part18();
  part19();
  part20();
  part21();

  console.log('\n' + (failed === 0 ? '全部通过' : `${failed} 条不符合预期`));
  process.exit(failed === 0 ? 0 : 1);
})();
