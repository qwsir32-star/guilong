/**
 * 生成「全新安装」的归拢页 —— 拍摄 / 截图专用。
 *
 * 跑法：node tools/make-screenshot-page.js
 * 产物：<仓库外>/outputs/guilong-全新安装预览.html（**单文件自包含**）
 *
 * ── 为什么是单文件 ────────────────────────────────────────────────
 * 内置预览面板按「每个 HTML 一个 hash 目录」隔离提供页面，页面相对路径引出去的
 * assets 一律 404（仓库根那个预览顺手也解决了）。所以 CSS / JS / 字体全部内联，
 * 产物可以直接双击打开、也可以丢进预览面板，两边都完整。
 *
 * ── 为什么不是「照着画一个像的页面」 ──────────────────────────────
 * 这个仓库早就定过：**预览的 DOM 必须和真实页面同构**。这里更进一步 ——
 * 直接照抄 extension/ 里的**全部真实文件**，只多注入一个 `chrome` 桩，
 * 然后让真的 app.js 自己 renderDashboard()。
 * 于是分组、subdomain 归并、`+N` 折叠、重复横幅、天气条、问候语……
 * 全是**真代码**跑出来的，不是手抄的 HTML。手抄那种一定会跟真页面漂移。
 *
 * ── 哪些是桩、哪些是真的 ─────────────────────────────────────────
 * 桩只有四样，都是「本来就因人而异 / 因时而异」的东西：
 *   ① 打开的标签页  —— 真实用户的是隐私，换成一组演示站
 *   ② storage       —— **故意留空**，因为空存储 = 出厂默认值
 *                      （getUiPrefs 是 {...默认值, ...存着的}，空的天然就是默认）
 *   ③ 天气接口       —— 打桩成固定读数，截图才能确定性复现
 *   ④ favicon       —— _favicon 读的是浏览器本地缓存，这里没有缓存，
 *                      换成构建时抓下来的图标，抓不到就露首字母色块
 *                       （那也正是真实用户没缓存时看到的样子）
 * 除此之外一行都没改。
 *
 * ⚠️ 全默认 = 搜索框关着、常用站点条关着、稍后再看是空的、主题是纸感。
 *   这是**真实的出厂样子**，不是「好看的版本」。要看别的状态就去设置里打开。
 */
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const EXT  = path.join(ROOT, 'extension');
const OUT_DIR = path.join(ROOT, '..', 'outputs');
const OUT_DEFAULT = path.join(OUT_DIR, 'guilong-全新安装预览.html');
const CACHE = path.join(OUT_DIR, '.screenshot-page-cache');

const read = f => fs.readFileSync(path.join(EXT, f), 'utf8');

/* ══════════════════════════════════════════════════════════════════
   一、演示数据
   ══════════════════════════════════════════════════════════════════ */

/* 演示标签页。挑的都是「一个正常人在逛的站」，且是照着**版式**配的 ——
   这不是随便凑的数，是**在真 Chrome 里量出来的**（1280×800，dsf 2）：

     · `.missions` 是 `columns: 280px`，1280 宽下容器 1216px → **4 列**，
       且 `column-fill: balance`（浏览器按高度自动分列，我控制不了谁落哪列）
     · 页头 48–135、天气 153–172，分区标题 + 那三个按钮 → 卡片从 **277px** 起
     · 视口 800 → 留给网格的约 **523px**

   每列 2 张卡 → 每张卡要 ≤ 约 240px。一张卡 = 卡头(~62) + 每条 chip 约 40px
   （**标题超过一行就翻倍**）+ 底部按钮(~58)，所以 **每域名 3 条**刚好。
   8 个域名在 4 列里正好 2×2，四列齐平。实测：网格 277–750，整块仪表盘
   （连「稍后再看 / 已归档」的空状态一起）到 **790px** —— 1280×800 里
   **全都看得见**，只有页脚（838–905）要往下滚一下。

   ⚠️ 想让它出现「还有 N 个」折叠 chip 的话，需要某个域名 ≥ 9 条（阈值是 8）。
   那张卡会蹿到 ~440px 高，网格底就翻过 800 了 —— 要那个效果就得接受截图
   只能截到视口、要往下滚。取舍在这里摆着，不是漏了。 */
const DEMO_TABS = [
  /* ── GitHub：3 条 ── */
  ['https://github.com/qwsir32-star/guilong',   'qwsir32-star/guilong'],
  ['https://github.com/notifications',          'Notifications · GitHub'],
  ['https://github.com/trending/javascript',    'Trending · GitHub'],

  /* ── B站：3 条，其中一条在 search 子域下（会被归并进同一张卡） ── */
  ['https://www.bilibili.com/video/BV1xx411c7mD',      '【4K】城市夜景漫步_哔哩哔哩'],
  ['https://www.bilibili.com/video/BV1yy411c7mE',      '前端工程师的一天_哔哩哔哩'],
  ['https://search.bilibili.com/all?keyword=浏览器扩展', '浏览器扩展-哔哩哔哩'],

  /* ── 知乎：3 条，专栏在 zhuanlan 子域下 ── */
  ['https://www.zhihu.com/question/19550224',   '好用的新标签页扩展？ - 知乎'],
  ['https://zhuanlan.zhihu.com/p/123456789',    '标签页开太多怎么办 - 知乎'],
  ['https://www.zhihu.com/question/20000000',   '为什么程序员爱攒标签页 - 知乎'],

  /* ── 掘金：3 条 ── */
  ['https://juejin.cn/post/7000000000000000001', 'MV3 的 CSP 有哪些坑 - 掘金'],
  ['https://juejin.cn/post/7000000000000000002', '用 DevTools 调试扩展 - 掘金'],
  ['https://juejin.cn/post/7000000000000000003', 'chrome.storage 容量限制 - 掘金'],

  /* ── Figma：3 条 ── */
  ['https://www.figma.com/file/aaa/归拢-图标母版', '归拢 · 图标母版 – Figma'],
  ['https://www.figma.com/file/bbb/归拢-设置面板', '归拢 · 设置面板 – Figma'],
  ['https://www.figma.com/file/ccc/归拢-上架图',   '归拢 · 上架图 – Figma'],

  /* ── 小红书：3 条 ── */
  ['https://www.xiaohongshu.com/explore/abc123', '桌面整理术：标签页不再堆积'],
  ['https://www.xiaohongshu.com/explore/def456', '极简桌面布置分享'],
  ['https://www.xiaohongshu.com/explore/ghi789', '我的浏览器插件清单'],

  /* ── MDN：3 条。跟上面那些「在做扩展」的标签页是同一条思路上的 ── */
  ['https://developer.mozilla.org/zh-CN/docs/Mozilla/Add-ons/WebExtensions/API/tabs',
   'tabs API - MDN'],
  ['https://developer.mozilla.org/zh-CN/docs/Mozilla/Add-ons/WebExtensions/manifest.json',
   'manifest.json - MDN'],
  ['https://developer.mozilla.org/zh-CN/docs/Web/API/URL', 'URL - Web API | MDN'],

  /* ── Stack Overflow：3 条 ── */
  ['https://stackoverflow.com/questions/73430000/chrome-tabs-query-in-mv3',
   'chrome.tabs.query in MV3 - SO'],
  ['https://stackoverflow.com/questions/73430001/favicon-failed-to-load',
   'Favicon failed to load - SO'],
  ['https://stackoverflow.com/questions/73430002/mv3-inline-script-blocked',
   'MV3 inline script blocked - SO'],
];

/* ══════════════════════════════════════════════════════════════════
   演示数据 · 第二套：专门造出「+N 折叠 chip」和「重复」的 UI
   ══════════════════════════════════════════════════════════════════

   ⚠️ 这两个画面**看不见是因为数据不够，不是因为功能没做**。触发条件是
   从 app.js 里读出来的，不是我拍的：

     · `app.js:1711`  `const visibleTabs = uniqueTabs.slice(0, 8)`
       → 同一域名**超过 8 个不同网址**，才 fold 出「还有 N 个」
     · `app.js:1686`  `dupeUrls = Object.entries(urlCounts).filter(([, c]) => c > 1)`
       → 同一域名里有**完全相同的网址**，卡片才会有：橙色状态条（`has-amber-bar`）、
         琥珀色「N 个重复」徽章、chip 上的 `(2x)`、以及「关闭 N 个重复」按钮

   ⚠️ 别把「重复」和 `#tabOutDupeBanner` 搞混 —— 那个横幅管的是
   「你开了好几个**归拢页**」（`app.js:1613` 按 `t.isTabOut` 过滤，判据是
   URL 等于扩展自己的新标签页），跟「同一网址开两次」是两回事。
   商店截图里不该出现那种「你开多了」的提示。

   所以 github 一家开 13 条（其中第一条开两次 = 12 个不同网址 + 1 个重复），
   一张卡上同时把两样都带出来。其余 5 家维持常规的 3 条，让这页仍然像
   「一个标签页开太多的普通人的仪表盘」，而不是为演示而演示。 */
const DEMO_TABS_FOLDED = [
  /* ── GitHub：13 条 → 12 个不同网址（触发「还有 4 个」）+ 1 个重复（触发重复 UI） ── */
  ['https://github.com/qwsir32-star/guilong',     'qwsir32-star/guilong'],
  ['https://github.com/qwsir32-star/guilong',     'qwsir32-star/guilong'],   // ← 就是这一条重复
  ['https://github.com/notifications',            'Notifications · GitHub'],
  ['https://github.com/trending/javascript',      'Trending · GitHub'],
  ['https://github.com/microsoft/vscode',         'microsoft/vscode'],
  ['https://github.com/vercel/next.js',           'vercel/next.js'],
  ['https://github.com/tailwindlabs/tailwindcss', 'tailwindlabs/tailwindcss'],
  ['https://github.com/electron/electron',        'electron/electron'],
  ['https://github.com/prettier/prettier',        'prettier/prettier'],
  ['https://github.com/eslint/eslint',            'eslint/eslint'],
  ['https://github.com/vitejs/vite',              'vitejs/vite'],
  ['https://github.com/rollup/rollup',            'rollup/rollup'],
  ['https://github.com/mozilla/pdf.js',           'mozilla/pdf.js'],

  /* ── 以下 5 家维持常规，只是让页面像真的 ── */
  ['https://www.bilibili.com/video/BV1xx411c7mD',      '【4K】城市夜景漫步_哔哩哔哩'],
  ['https://www.bilibili.com/video/BV1yy411c7mE',      '前端工程师的一天_哔哩哔哩'],
  ['https://search.bilibili.com/all?keyword=浏览器扩展', '浏览器扩展-哔哩哔哩'],

  ['https://www.zhihu.com/question/19550224',   '好用的新标签页扩展？ - 知乎'],
  ['https://zhuanlan.zhihu.com/p/123456789',    '标签页开太多怎么办 - 知乎'],
  ['https://www.zhihu.com/question/20000000',   '为什么程序员爱攒标签页 - 知乎'],

  ['https://juejin.cn/post/7000000000000000001', 'MV3 的 CSP 有哪些坑 - 掘金'],
  ['https://juejin.cn/post/7000000000000000002', '用 DevTools 调试扩展 - 掘金'],
  ['https://juejin.cn/post/7000000000000000003', 'chrome.storage 容量限制 - 掘金'],

  ['https://developer.mozilla.org/zh-CN/docs/Mozilla/Add-ons/WebExtensions/API/tabs',
   'tabs API - MDN'],
  ['https://developer.mozilla.org/zh-CN/docs/Mozilla/Add-ons/WebExtensions/manifest.json',
   'manifest.json - MDN'],
  ['https://developer.mozilla.org/zh-CN/docs/Web/API/URL', 'URL - Web API | MDN'],

  ['https://stackoverflow.com/questions/73430000/chrome-tabs-query-in-mv3',
   'chrome.tabs.query in MV3 - SO'],
  ['https://stackoverflow.com/questions/73430001/favicon-failed-to-load',
   'Favicon failed to load - SO'],
  ['https://stackoverflow.com/questions/73430002/mv3-inline-script-blocked',
   'MV3 inline script blocked - SO'],
];

/* 天气打桩值。WMO code 2 = 多云 → 'partly'。挑一个好看的常温。 */
const DEMO_WEATHER = {
  temperature_2m: 24.3,
  weather_code: 2,
  temperature_2m_max: [27.1],
  temperature_2m_min: [19.4],
};

/* ══════════════════════════════════════════════════════════════════
   二、favicon：构建时抓一次，缓存到 outputs/.screenshot-page-cache
   ══════════════════════════════════════════════════════════════════ */

/* ⚠️ 必须按**魔数**认是不是图片，不能信 content-type，也不能只看大小。
   实测：`www.figma.com/favicon.ico` 返回的是 404，但 body 是一个 9595 字节的
   HTML 错误页。只看大小它会一路过关，最后存成 .ico、在页面里显示成破图 ——
   而破图比露不出来更难查（你会以为是自己路径写错了）。 */
function sniffImage(buf) {
  if (!buf || buf.length < 16) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return 'image/x-icon';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' &&
      buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  const head = buf.slice(0, 64).toString('utf8').trim().toLowerCase();
  if (head.startsWith('<svg')) return 'image/svg+xml';
  return null;                      // 认不出来 = 没拿到，走色块兜底
}

/* 每个域名的候选地址。先试常规的，再试备用的。
   ⚠️ 抓不到不是错误：那一格会露首字母色块，而那正是**真实用户没缓存 favicon
   时看到的样子**。所以这里只记一行日志，不让脚本失败。 */
const FAVICON_PATHS = ['/favicon.ico', '/favicon.png', '/apple-touch-icon.png'];

/* 少数站点常规路径上没有图标，走它自己的资源域。
   ⚠️ github.com 本身在**本机网络下不通**（curl 直接返回 000），但它的静态资源域
   github.githubassets.com 通 —— 所以拿官方那份 favicon。换台能上 github 的机器，
   常规路径那条就会先命中，这份 override 用不上也不碍事。 */
const FAVICON_OVERRIDES = {
  'github.com':    ['https://github.githubassets.com/favicons/favicon.png'],
  'www.figma.com': ['https://static.figma.com/app/icon/1/favicon.png'],
  // stackoverflow.com 对三个常规路径一律回 403（防爬），只有它自己的 CDN 给
  'stackoverflow.com': ['https://cdn.sstatic.net/Sites/stackoverflow/Img/favicon.ico'],
};

async function grabFavicon(host) {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, host + '.ico');

  // 缓存也要过一遍魔数检查 —— 上一轮万一存进去一个错的文件，不能一直用下去
  if (fs.existsSync(file) && fs.statSync(file).size > 0) {
    const buf = fs.readFileSync(file);
    const mime = sniffImage(buf);
    if (mime) return { buf, mime, from: 'cache' };
    fs.unlinkSync(file);
  }

  const urls = (FAVICON_OVERRIDES[host] || []).concat(
    FAVICON_PATHS.map(p => 'https://' + host + p));

  const tried = [];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(8000), redirect: 'follow',
        headers: { 'user-agent': 'Mozilla/5.0' },
      });
      if (!res.ok) { tried.push(res.status); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      const mime = sniffImage(buf);
      if (!mime) { tried.push('不是图片'); continue; }
      fs.writeFileSync(file, buf);
      return { buf, mime, from: '下载 ' + url.replace('https://' + host, '') };
    } catch (e) { tried.push((e && e.name) || '失败'); }
  }
  return { buf: null, mime: null, from: '试了 ' + urls.length + ' 个地址：' + tried.join('/') };
}

/* ══════════════════════════════════════════════════════════════════
   三、主流程
   ══════════════════════════════════════════════════════════════════ */

async function buildPage(DEMO_TABS, cfg) {
  const OUT          = cfg.out || OUT_DEFAULT;
  const LABEL        = cfg.label;
  const minTabs      = cfg.minTabs      ?? 15;
  const minDomains   = cfg.minDomains   ?? 6;
  const maxPerDomain = cfg.maxPerDomain ?? 3;

  const indexHtml = read('index.html');
  const manifest  = JSON.parse(read('manifest.json'));

  /* ---- 字体：把 woff2 变成 data URI 塞进 fonts.css ---- */
  const fontsCssRaw = read('fonts/fonts.css');
  let fontsCss = fontsCssRaw;
  const fontRefs = [...new Set(fontsCssRaw.match(/url\('([^']+\.woff2)'\)/g) || [])];
  if (fontRefs.length === 0) { console.error('❌ fonts.css 里没找到 woff2 引用'); process.exit(1); }
  let fontBytes = 0;
  for (const ref of fontRefs) {
    const name = ref.slice(5, -2);                     // url('x.woff2') → x.woff2
    const p = path.join(EXT, 'fonts', name);
    if (!fs.existsSync(p)) { console.error('❌ 字体文件缺失:', name); process.exit(1); }
    const buf = fs.readFileSync(p);
    fontBytes += buf.length;
    fontsCss = fontsCss.split(ref).join(`url('data:font/woff2;base64,${buf.toString('base64')}')`);
  }
  if (/url\('[^']+\.woff2'\)/.test(fontsCss)) { console.error('❌ 还有没内联掉的字体路径'); process.exit(1); }

  /* ---- favicon ---- */
  const hosts = [...new Set(DEMO_TABS.map(([u]) => new URL(u).hostname))];
  const faviconMap = {};        // 给桩用的查找表
  const fetched = new Set();    // 真正下到图标的域名
  const iconHash = {};          // 域名 → 图片内容哈希（下面那条「防通用占位图」用）

  /* 同一「主域」的兄弟子域。判据是「去掉最前面那一段之后相同」——
     不猜什么 com.cn / co.uk，那种列表永远会漏。 */
  const sibKey = h => h.split('.').slice(1).join('.');
  const bySibling = {};
  hosts.forEach(h => { (bySibling[sibKey(h)] = bySibling[sibKey(h)] || []).push(h); });

  /* 桩里的查找逻辑在生成端也要有一份：不然「生成成功」不等于「查得到」，
     而查不到只会静默变成没有图标 —— 在这份预览里那就是我配错了。 */
  function lookupIcon(map, host) {
    const parts = host.split('.');
    while (parts.length >= 2) {
      const k = parts.join('.');
      if (map[k]) return map[k];
      parts.shift();
    }
    return '';
  }

  console.log('抓 favicon：');
  for (const h of hosts) {
    const { buf, mime, from } = await grabFavicon(h);
    if (buf) {
      fetched.add(h);
      iconHash[h] = crypto.createHash('sha256').update(buf).digest('hex');
      const data = `data:${mime};base64,${buf.toString('base64')}`;
      // 连「去掉前缀的尾」一起登记。否则兄弟子域查不到 ——
      // search.bilibili.com 剥标签只能剥到 bilibili.com，
      // 而表里的键是 www.bilibili.com，两者永远对不上，图标会静默消失。
      const parts = h.split('.');
      for (let i = 0; i + 2 <= parts.length; i++) {
        const k = parts.slice(i).join('.');
        if (!(k in faviconMap)) faviconMap[k] = data;
      }
      console.log(`  ✓ ${h.padEnd(24)} ${from}  ${buf.length} 字节  ${mime}`);
    } else {
      console.log(`  ✗ ${h.padEnd(24)} ${from}  → 露首字母色块`);
    }
  }

  /* 兄弟子域要么都能查到，要么都查不到 —— 只抓到一个就该两个都有。
     这条如果放着不管，表现是「同一张卡里有的 chip 有图标、有的没有」，
     而页面不会报任何错。 */
  const orphAN = [];
  Object.values(bySibling).forEach(group => {
    if (!group.some(h => fetched.has(h))) return;         // 这组一个都没抓到，本来就该是空的
    group.filter(h => !lookupIcon(faviconMap, h)).forEach(h => orphAN.push(h));
  });

  /* ---- 快捷键：从 manifest 里读出来，别手抄 ---- */
  const cmdName = Object.keys(manifest.commands || {})[0];
  const macKey  = manifest.commands[cmdName].suggested_key.mac;

  /* --- 按 UA 里的平台给「默认快捷键」：mac 用 Command+Shift+K，其余 Ctrl+... --- */
  const stubPlatforms = `
    const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
    const shortcut = mac ? ${JSON.stringify(macKey)} : ${JSON.stringify(manifest.commands[cmdName].suggested_key.default)};`;

  /* ── 桩：这是整个产物里唯一「不是扩展本身」的代码 ──────────────────
     全部加注释说明，因为它会被看到（也可能被误当成产品代码）。 */
  const STUB = `
/* ════════════════════════════════════════════════════════════════════
   预览桩 —— 只为「拍一张全新安装的归拢页」而存在，不属于扩展本身
   ════════════════════════════════════════════════════════════════════
   下面这个 chrome 对象替掉了浏览器给扩展的 API。**storage 是空的**，
   因为空存储就等于出厂默认值：getUiPrefs() 是 {...默认值, ...存着的}，
   没有存过任何东西 → 读到的全是默认值。
   所以这一页就是「刚下载完、还没动过任何设置」的样子，不是调出来的。 */
(function () {
  'use strict';

  var DEMO_TABS = ${JSON.stringify(DEMO_TABS.map(([url, title], i) => ({
    id: 100 + i, url, title, windowId: 1, active: false, pinned: false,
  })), null, 2)};

  var FAVICONS = ${JSON.stringify(faviconMap, null, 2)};

  var WEATHER_JSON = ${JSON.stringify({
    current: { temperature_2m: DEMO_WEATHER.temperature_2m, weather_code: DEMO_WEATHER.weather_code },
    daily: { temperature_2m_max: DEMO_WEATHER.temperature_2m_max, temperature_2m_min: DEMO_WEATHER.temperature_2m_min },
  })};

  /* ---- storage：一个空对象就是全部。没有兜底默认值，也没有预置项 ---- */
  var store = {};

  function pick(keys, all) {
    var out = {};
    if (typeof keys === 'string') { if (keys in all) out[keys] = all[keys]; return out; }
    if (Array.isArray(keys))      { keys.forEach(function (k) { if (k in all) out[k] = all[k]; }); return out; }
    if (keys && typeof keys === 'object') {
      Object.keys(keys).forEach(function (k) { out[k] = (k in all) ? all[k] : keys[k]; });
      return out;
    }
    return Object.assign({}, all);
  }

  function deepClone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }

  window.chrome = {
    runtime: {
      id: 'guilongpreviewpageeeeeeeeeeeeeeeeeeeee',
      getURL: function (p) {
        // _favicon 走的是浏览器本地缓存，这里没有缓存 → 换成构建时抓的图标。
        // 抓不到的域名返回空串，正好走真实的「露首字母色块」兜底路径。
        if (String(p).indexOf('_favicon') === 0) {
          var m = /pageUrl=([^&]+)/.exec(String(p));
          if (!m) return '';
          var host;
          try { host = new URL(decodeURIComponent(m[1])).hostname; } catch (e) { return ''; }
          // 逐级剥左边的标签去找：search.bilibili.com → bilibili.com。
          // 子域上一般没有独立的 favicon.ico，不这么找的话同一张卡片里会
          // 一半是图标、一半是色块。
          var parts = host.split('.');
          while (parts.length >= 2) {
            var k = parts.join('.');
            if (FAVICONS[k]) return FAVICONS[k];
            parts.shift();
          }
          return '';
        }
        return 'chrome-extension://guilongpreviewpage/index.html';
      },
    },
    storage: {
      local: {
        get:   function (keys) { return Promise.resolve(deepClone(pick(keys, store))); },
        set:   function (obj)  { Object.assign(store, deepClone(obj)); return Promise.resolve(); },
        remove:function (keys) {
          (Array.isArray(keys) ? keys : [keys]).forEach(function (k) { delete store[k]; });
          return Promise.resolve();
        },
        clear: function () { store = {}; return Promise.resolve(); },
      },
    },
    tabs: {
      query:  function () { return Promise.resolve(deepClone(DEMO_TABS)); },
      remove: function () { return Promise.resolve(); },
      create: function () { return Promise.resolve({}); },
      update: function () { return Promise.resolve({}); },
      onRemoved: { addListener: function () {} },
      onUpdated: { addListener: function () {} },
    },
    windows: {
      getCurrent: function () { return Promise.resolve({ id: 1, focused: true }); },
      update:     function () { return Promise.resolve({}); },
    },
    topSites: { get: function () { return Promise.resolve([]); } },
    search:   { query: function () { return Promise.resolve(); } },
    commands: {
      getAll: function () {
        ${stubPlatforms}
        return Promise.resolve([{ name: ${JSON.stringify(cmdName)}, description: ${JSON.stringify(manifest.commands[cmdName].description)}, shortcut: shortcut }]);
      },
    },
  };

  /* 天气接口打桩：固定读数。网络请求换掉，解析和渲染仍然是真代码。 */
  var realFetch = window.fetch;
  window.fetch = function (url, opts) {
    if (String(url).indexOf('api.open-meteo.com') !== -1) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: function () { return Promise.resolve(JSON.parse(JSON.stringify(WEATHER_JSON))); },
      });
    }
    return realFetch.call(window, url, opts);
  };

  // 预览页不是扩展页，控制台里那句「读不到 topSites」之类的降级日志没必要出现
  console.info('[归拢预览] 用的是桩：空 storage（= 出厂默认）+ ' + DEMO_TABS.length + ' 个演示标签页；天气是固定读数。');
})();
`;

  /* ---- 组装 index.html：把外链换成内联，并注入桩 ---- */
  let html = indexHtml;

  const swaps = [
    ['<link rel="stylesheet" href="fonts/fonts.css">',
     `<style>\n/* fonts/fonts.css（字体已内联成 data URI） */\n${fontsCss}\n</style>`],
    ['<link rel="stylesheet" href="style.css" data-page-node-id="E14MAEXrzgWRYkK3D2RIiA">',
     `<style>\n/* style.css */\n${read('style.css')}\n</style>`],
    ['<script src="theme-boot.js" data-page-node-id="T1H3m3B00t"></script>',
     `<script>\n/* theme-boot.js */\n${read('theme-boot.js')}\n</script>`],
    ['<script src="env.js"></script>',
     `<script>\n/* env.js */\n${read('env.js')}\n</script>`],
    ['<script src="config.local.js"></script>',
     `<script>\n/* config.local.js —— 跟商店包里那份一样，故意留空 */\n${''}\n</script>`],
    ['<script src="strings.js"></script>',
     `<script>\n/* strings.js */\n${read('strings.js')}\n</script>`],
    ['<script src="china-places.js"></script>',
     `<script>\n/* china-places.js */\n${read('china-places.js')}\n</script>`],
    ['<script src="app.js"></script>',
     `<script>\n/* app.js */\n${read('app.js')}\n</script>`],
  ];

  for (const [from, to] of swaps) {
    const hits = html.split(from).length - 1;
    if (hits !== 1) { console.error(`❌ 内联锚点命中 ${hits} 次（要求 1 次）：${from}`); process.exit(1); }
    html = html.replace(from, () => to);
  }

  /* 桩必须排在最前面：theme-boot.js 在 head 里就先跑，env.js / app.js 更靠后 */
  const headOpen = html.match(/<head[^>]*>/);
  if (!headOpen) { console.error('❌ 没找到 <head>'); process.exit(1); }
  const at = headOpen.index + headOpen[0].length;
  html = html.slice(0, at) + '\n<script>\n' + STUB + '\n</script>' + html.slice(at);

  /* 单独喊一声：光看「抓了几张」是看不出这个的 —— 8/10 抓到也可能是
     某个域名的两兄弟一有一无。这个名字必须打出来才知道是谁。 */
  if (orphAN.length) console.error('⚠️ 这些子域的同门兄弟有图标、它自己查不到：' + orphAN.join('、'));

  /* ---- 自检：产物真能跑起来吗 ---- */
  const checks = [
    ['页面里没有残留的外链（全部内联）',
      !/<(link|script)[^>]+(src|href)="(?!data:)[^"]*\.(js|css)"/.test(html)],
    ['桩排在 env.js 之前', html.indexOf('window.chrome =') < html.indexOf('/* env.js */')],
    ['桩排在 app.js 之前', html.indexOf('window.chrome =') < html.indexOf('/* app.js */')],
    ['没有残留 _favicon 外链', !/href="_favicon/.test(html)],
    ['字体已内联（有 data:font/woff2）', /data:font\/woff2;base64/.test(html)],
    [`demo 标签页数量 ≥ ${minTabs}`, DEMO_TABS.length >= minTabs],
    [`demo 覆盖 ≥ ${minDomains} 个域名`, hosts.length >= minDomains],
    // 版式约束（见 DEMO_TABS 上方的推算）：每域名 ≤ 3 条，四列才排得平、整页才进得了 800。
    // ⚠️ 只能按**域名**近似判 —— 真正分列是按 siteKey 归并后的**站点**数，
    //    这里算不出来（子域归并规则在 app.js 里，且要区分 com.cn 这类多段后缀）。
    //    所以「排得平不平」以真机测量的结果为准，不靠这条断言。
    // ⚠️ 「每域名 ≤ N 条」那条**不在这里** —— 第二套数据故意在 github 上堆 13 条，
    //    那正是它存在的理由。给第二套传 `maxPerDomain: Infinity` 就直接**不加**这条，
    //    而不是加一条恒真的凑数（恒真的断言只是装饰）。见下面 checks.push 那段。
    ['桩里没有预置 uiPrefs（空存储才是全默认）', !/uiPrefs\s*:/.test(STUB)],
    ['桩里没有预置 weatherLocation', !/weatherLocation\s*:/.test(STUB)],
    ['favicon 全是真图片（data:image/ 开头，不是 HTTP 错误页）',
      Object.values(faviconMap).every(v => v.startsWith('data:image/'))],
    ['app.js 结尾确实是 renderDashboard()', /renderDashboard\(\);\s*$/.test(read('app.js').trimEnd())],
    // 兄弟子域（www.bilibili.com / search.bilibili.com）要么都有图标、要么都没有。
    // 只抓到一个就等于「同一张卡里有的 chip 带图标、有的不带」，页面不报任何错。
    ['兄弟子域图标一致（要么都有、要么都无）', orphAN.length === 0],
    /* 防「CDN 拿同一张通用占位图把所有站点都打发了」。那是**真图片**，
       sniffImage 拦不住；而四个站给出等长文件更是常态（同一个 ICO 编码器，
       32×32 RGBA + 1 位 AND 掩码 = 恒定 4286 字节），所以只能比内容哈希。
       兄弟子域复用主域图标是正当的（zhuanlan 就用知乎那张）→ 允许 2 个共用。 */
    ['抓到的图标不是同一张通用占位图（同一张最多 2 个域名共用）',
      (function () {
        const byHash = {};
        Object.values(iconHash).forEach(v => { byHash[v] = (byHash[v] || 0) + 1; });
        return Object.values(byHash).every(n => n <= 2);
      })()],
  ];

  /* 「每域名 ≤ N 条」只在数据本来就该整齐时才有意义。第二套数据故意不整齐，
     所以**不加**这条 —— 加一条恒真的进来就是装饰，不是守卫。 */
  if (maxPerDomain !== Infinity) {
    checks.push([`每个域名 ≤ ${maxPerDomain} 条（超过就会把整页顶出 800px）`,
      (function () {
        const c = {};
        DEMO_TABS.forEach(([u]) => { const h = new URL(u).hostname; c[h] = (c[h] || 0) + 1; });
        return Object.values(c).every(n => n <= maxPerDomain);
      })()]);
  }

  /* 变体自己的断言。第二套必须真的含「一个域名 >8 个不同网址」和「某网址开了两次」——
     否则那页照样**生成成功**，只是什么也演示不出来，而这种失败最难发现。 */
  if (cfg.checks) checks.push(...cfg.checks(DEMO_TABS, hosts));

  const bad = checks.filter(([, ok]) => !ok).map(([n]) => n);
  if (bad.length) { console.error('❌ 自检没过：\n  - ' + bad.join('\n  - ')); process.exit(1); }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, html);

  console.log('');
  console.log('✅ [' + LABEL + '] ' + OUT);
  console.log('   ' + (html.length / 1024).toFixed(0) + ' KB（其中字体 ' + (fontBytes / 1024).toFixed(0) + ' KB）');
  console.log('   自检 ' + checks.length + ' 条全过');
  console.log('');
  console.log('这一页会显示（' + cfg.blurbTitle + '）：');
  console.log('   · 演示数据 ' + hosts.length + ' 个域名 / ' + DEMO_TABS.length +
              ' 个标签页（页面按 siteKey 归并后站点数会更少，子域会并进主域）');
  (cfg.blurb || []).forEach(l => console.log('   · ' + l));
  /* ⚠️ 分子必须是**抓到图标的域名数**（fetched.size），不是 Object.keys(faviconMap).length ——
     后缀登记会往表里多插键（bilibili.com 这类主域），拿它当分子就会印出「14/10」这种
     看着像 bug、其实只是指标用错的数。 */
  console.log('   · favicon：' + fetched.size + '/' + hosts.length + ' 个域名抓到（查找表 ' +
              Object.keys(faviconMap).length + ' 个键，多出来的是给子域兜底的主域名），其余露首字母色块');
}

/* ══════════════════════════════════════════════════════════════════
   四、两套页面
   ══════════════════════════════════════════════════════════════════

   为什么是**两个文件**而不是一页：第一套的全部价值就是「一屏拍全 + 全默认」，
   往里塞一个 13 条标签页的域名，那张卡立刻蹿到 ~490px，把它自己的价值毁掉；
   而第二套要的恰恰就是那张蹿起来的卡。两个诉求互斥，所以分成两页。

   （也想过一页里加个「切换数据」的悬浮按钮 —— 但那个按钮自己会进画面，
     拍摄用的页面不能有任何不属于产品的东西。） */
const VARIANTS = [
  {
    label: '默认',
    out:   OUT_DEFAULT,
    tabs:  DEMO_TABS,
    blurbTitle: '全部是出厂默认',
    blurb: [
      '纸感主题',
      '搜索框、常用站点条 —— 默认关着，所以看不到（这是真的默认状态）',
      '稍后再看 / 归档 —— 全新安装本来就是空的',
      '天气：固定读数（多云 24°，上海），不联网',
    ],
  },
  {
    label: '折叠与重复',
    out:   path.join(OUT_DIR, 'guilong-折叠与重复预览.html'),
    tabs:  DEMO_TABS_FOLDED,
    minTabs: 12, minDomains: 3, maxPerDomain: Infinity,
    blurbTitle: '专门要演示的那两样摆出来（其余仍是出厂默认）',
    blurb: [
      'github 一家 13 条 → 12 个不同网址，卡里出现「还有 4 个」折叠 chip',
      '其中一条网址开了两次 → 卡片带橙条 +「1 个重复」徽章 + chip 上的 (2x) +「关闭 1 个重复」按钮',
      '⚠️ 这不是 #tabOutDupeBanner —— 那个横幅管的是「你开了多个归拢页」，两回事',
    ],
    /* 下面两条是这套数据的**存在理由**，所以必须断言它们真的成立：
       数据被人改坏时页面照样生成成功，只是什么也演示不出来 —— 那种失败最难发现。 */
    checks: (tabs) => {
      const byHost = {};
      tabs.forEach(([u]) => { const h = new URL(u).hostname; (byHost[h] = byHost[h] || []).push(u); });
      const folded = Object.entries(byHost).find(([, us]) => new Set(us).size > 8);
      const duped  = Object.entries(byHost).find(([, us]) => us.length !== new Set(us).size);
      return [
        ['数据里有域名开了 >8 个不同网址（否则折叠 chip 不会出现）' +
          (folded ? `：${folded[0]} 共 ${new Set(folded[1]).size} 个` : ''), !!folded],
        ['数据里有网址开了两次（否则橙条 /「N 个重复」/「关闭 N 个重复」都不会出现）' +
          (duped ? `：${duped[0]}` : ''), !!duped],
      ];
    },
  },
];

(async () => {
  for (const v of VARIANTS) await buildPage(v.tabs, v);
  console.log('');
  console.log('要改演示数据就改本文件顶部的 DEMO_TABS / DEMO_TABS_FOLDED，重跑一次即可。');
})().catch(e => { console.error('❌ ' + ((e && e.stack) || e)); process.exit(1); });
