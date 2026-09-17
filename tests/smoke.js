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
 *           旧品牌名不许回流 / manifest 用新名字 / LICENSE 保留原始署名）
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
};`;

/* ---------------- 假 chrome / 假存储 ---------------- */
const EXT_ID = 'smoke-test-id';
const store  = { deferred: [] };
let   fakeTabs = [];      // 当前「打开的标签页」
const created  = [];      // chrome.tabs.create 收到的参数
let   focused  = [];      // chrome.tabs.update 记录的激活操作
let   topSites = [];      // chrome.topSites.get 的返回值

const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

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
      },
    },
  },
  window: {},
  globalThis: null,
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
    { id: 8, url: TO_URL,             title: 'Tab Out',  windowId: 0 },
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
  // 但 chrome://newtab/ 和 Tab Out 自己不能动。
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
    { url: 'https://github.com/qwsir32-star/tab-out', title: 'qwsir32-star/tab-out' },
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
  const defSig = await T.faviconSignature('https://tab-out-no-such-site.invalid/');
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
  check('没设置过时读默认值（两个都开）',
    await T.getUiPrefs(), { showQuickSites: true, showSearchBox: true });

  await T.setUiPref('showQuickSites', false);
  check('关掉站点条后读回来是关的', (await T.getUiPrefs()).showQuickSites, false);

  // 老用户的存储里可能只有新增开关之前存的那一半键，缺的必须补默认值
  store.uiPrefs = { showQuickSites: false };
  check('缺的键自动补默认值',
    await T.getUiPrefs(), { showQuickSites: false, showSearchBox: true });

  await T.setUiPref('不存在的开关', false);
  check('未声明的开关不许写进去', Object.keys(await T.getUiPrefs()).sort(),
    ['showQuickSites', 'showSearchBox']);

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
    await T.applyUiPrefs(), { showQuickSites: false, showSearchBox: true });

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
  for (const f of ['app.js', 'index.html', 'strings.js', 'manifest.json']) {
    srcOf(f).split('\n').forEach((line, i) => {
      if (/zarazhangrui/.test(line)) return;   // 上游署名与上游链接里的旧名是合法的
      if (/Tab Out/.test(line)) brandLeak.push(`${f} L${i + 1}`);
    });
  }
  check('源码里没有残留旧品牌名 Tab Out', brandLeak, []);
  check('manifest 用的是新名字', MANIFEST.name.includes('归拢'), true);
  check('manifest 的 action 标题也是新名字', MANIFEST.action.default_title, '归拢');
  // 这条守卫是踩坑换来的：manifest 没有 key 时，Chrome 用**目录绝对路径**算扩展 ID，
  // 改个目录名就会换 ID → chrome.storage 里的用户数据全部读不到。
  // 删掉 key 不会有任何报错，只会静默丢数据，所以必须守住。
  check('manifest 有固定 key（扩展 ID 不随目录名变）',
    /^MII[A-Za-z0-9+/]{300,}={0,2}$/.test(MANIFEST.key || ''), true);
  check('LICENSE 保留了原始署名',
    /Copyright \(c\) 2026 Zara Zhang/.test(fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8')), true);
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

  console.log('\n' + (failed === 0 ? '全部通过' : `${failed} 条不符合预期`));
  process.exit(failed === 0 ? 0 : 1);
})();
