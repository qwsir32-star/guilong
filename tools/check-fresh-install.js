/* =====================================================================
   check-fresh-install.js —— 用「全新 profile」模拟「除我以外的设备」（Chrome）

   为什么必须用全新 profile：开发机上那份 storage 里已经攒了钉住的站点、
   隐藏名单、主题、语言，`topSites` 也有一堆历史 —— 这些**恰好把首装路径
   挡住了**。别人第一次装上时：storage 是空的、topSites 是空的、favicon
   没有缓存、系统语言不一定是中文、窗口尺寸也不是我这个。
   真实教训：首装才暴露的两个 bug（缺 config.local.js 导致 404、页脚品牌名
   写死中文）在开发机上永远复现不出来。

   ⚠️ 装扩展的方式：Chrome 137 起 `--load-extension` 被移除（142 之后连
   `--disable-features=DisableLoadExtensionCommandLineSwitch` 也失效），
   只能用 CDP 的 `Extensions.loadUnpacked`，并配
   `--enable-unsafe-extension-debugging`。
   **headless 下它也能用，但必须加超时** —— 不加就会挂住不返回。

   除了 DOM 状态，还**记下页面发出的每一个网络请求** —— 用来验证
   「唯一联网的是天气」这句话在新装的机器上是否成立。

   跑法：
     node tools/check-fresh-install.js                    # 验源码目录 extension/
     GL_EXT=dist/chrome node tools/check-fresh-install.js # 验打好的商店包
   可覆盖：GL_CHROME（Chrome 可执行文件）、GL_OUT（报告目录）

   ⚠️ **要在沙箱外跑。** Chrome 启动时会写自己的配置目录
   （`~/Library/Application Support/Google/RLZ/…`），被沙箱拦住就起不来 ——
   表现是只打印了第一行用例标题就退出，看不到任何报错。
   ===================================================================== */
const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.GL_CHROME
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// GL_EXT 给相对路径时按仓库根解析，给绝对路径就用它
const extArg = process.env.GL_EXT;
const EXT = extArg
  ? (path.isAbsolute(extArg) ? extArg : path.join(ROOT, extArg))
  : path.join(ROOT, 'extension');
const OUT = process.env.GL_OUT || path.join(ROOT, 'dist', 'verify');
fs.mkdirSync(OUT, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const httpJson = url => new Promise((res, rej) => {
  http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});
const withTimeout = (p, ms, label) =>
  Promise.race([p, sleep(ms).then(() => { throw new Error('TIMEOUT:' + label); })]);

class CDP {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.listeners = [];
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      } else this.listeners.forEach(fn => fn(m));
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  on(fn) { this.listeners.push(fn); }
}

async function runCase(opts) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-fresh-'));
  const port = 9400 + Math.floor(Math.random() * 300);
  const proc = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--enable-unsafe-extension-debugging',       // 让 Extensions.loadUnpacked 可用
    '--no-first-run', '--no-default-browser-check',
    `--window-size=${opts.width || 1280},${opts.height || 900}`,
    `--lang=${opts.lang || 'zh-CN'}`,
    `--accept-lang=${opts.lang || 'zh-CN'}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  try {
    let ver = null;
    for (let i = 0; i < 60 && !ver; i++) {
      await sleep(250);
      try { ver = await httpJson(`http://127.0.0.1:${port}/json/version`); } catch { /* 等 */ }
    }
    if (!ver) throw new Error('远程调试口没起来');

    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('WS 连不上')); });
    const cdp = new CDP(ws);

    /* 装扩展 —— 全新 profile，等同于别人第一次 Load unpacked */
    const loaded = await withTimeout(
      cdp.send('Extensions.loadUnpacked', { path: EXT }), 25000, 'loadUnpacked');
    await sleep(1200);

    const errors = [], requests = [], failedReq = [];
    cdp.on(m => {
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        errors.push('未捕获异常: ' + ((d.exception && d.exception.description) || d.text));
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        errors.push('console.error: ' + m.params.args.map(a => a.value ?? a.description ?? a.type).join(' '));
      }
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        errors.push('log.error: ' + m.params.entry.text);
      }
    });

    const { targetId } = await cdp.send('Target.createTarget', { url: opts.url });
    const { sessionId: S } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

    await cdp.send('Runtime.enable', {}, S);
    await cdp.send('Log.enable', {}, S);
    await cdp.send('Page.enable', {}, S);
    await cdp.send('Network.enable', {}, S);
    cdp.on(m => {
      if (m.sessionId !== S) return;
      if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url);
      if (m.method === 'Network.loadingFailed') failedReq.push(m.params.errorText);
    });

    if (opts.offline) {
      await cdp.send('Network.emulateNetworkConditions',
        { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, S);
    }

    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      await sleep(250);
      try {
        const r = await cdp.send('Runtime.evaluate',
          { expression: 'document.readyState === "complete"', returnByValue: true }, S);
        ready = r.result.value === true;
      } catch { /* 还没 */ }
    }
    await sleep(2000);   // 等天气 / favicon 这些异步尾巴

    const probe = {};
    for (const [key, expr] of Object.entries(opts.probe || {})) {
      try {
        const r = await withTimeout(
          cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, S),
          8000, 'probe:' + key);
        probe[key] = r.exceptionDetails ? 'ERR: ' + r.exceptionDetails.text : r.result.value;
      } catch (e) { probe[key] = 'ERR: ' + e.message; }
    }

    const realUrl = (await cdp.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, S)).result.value;

    let shot = null;
    if (opts.shot) {
      const img = await cdp.send('Page.captureScreenshot', { format: 'png' }, S);
      shot = path.join(OUT, opts.shot);
      fs.writeFileSync(shot, Buffer.from(img.data, 'base64'));
    }

    await cdp.send('Target.closeTarget', { targetId });
    ws.close();
    return { name: opts.name, offline: !!opts.offline, loadedId: loaded.id,
             errors, requests, failedReq, probe, realUrl, shot };
  } finally {
    proc.kill('SIGKILL');
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/* ── 探针 ── */
const P = {
  title:        'document.title',
  lang:         'navigator.language + " / " + (navigator.languages||[]).join(",")',
  emptyState:   'document.body.innerText.replace(/\\s+/g," ").slice(0,200)',
  nodeCount:    'document.querySelectorAll("body *").length',
  cssLoaded:    'getComputedStyle(document.documentElement).getPropertyValue("--ink").trim() !== ""',
  theme:        'document.documentElement.getAttribute("data-theme")',
  siteCount:    'document.querySelectorAll(".quick-site, .site-item, .favicon-wrap, .site").length',
  brokenImgs:   '[...document.images].filter(i => i.complete && i.naturalWidth === 0).length',
  imgTotal:     'document.images.length',
  hOverflow:    'document.documentElement.scrollWidth > document.documentElement.clientWidth + 1',
  panelDialog:  '!!document.querySelector("dialog.settings-panel#settingsPanel")',
  // 三个关键 API 在这台机器上在不在
  apiSearch:    'typeof (chrome.search && chrome.search.query)',
  apiTopSites:  'typeof (chrome.topSites && chrome.topSites.get)',
  apiCommands:  'typeof (chrome.commands && chrome.commands.getAll)',
  // _favicon 端点到底能不能用（这是唯一的功能性差异点）
  faviconEndpoint: `new Promise(res => {
      const i = new Image();
      const t = setTimeout(() => res('timeout'), 4000);
      i.onload  = () => { clearTimeout(t); res('ok ' + i.naturalWidth + 'x' + i.naturalHeight); };
      i.onerror = () => { clearTimeout(t); res('error'); };
      i.src = chrome.runtime.getURL('_favicon/?pageUrl=' + encodeURIComponent('https://example.com') + '&size=32');
    })`,
  envIsFirefox: 'String(typeof GL_ENV !== "undefined" && GL_ENV.isFirefox)',
  fontOfTitle:  'getComputedStyle(document.querySelector(".settings-title") || document.body).fontFamily.slice(0,60)',
};

const EXT_URL = 'chrome-extension://ihejaehbfjlhnbdkkinphfcojpifldlk/index.html';

const CASES = [
  { name: '首装 · 简体中文 · 1280×900', lang: 'zh-CN', url: EXT_URL, probe: P },
  { name: '首装 · 英文系统（默认语言该跟着变）', lang: 'en-US', url: EXT_URL, probe: P },
  { name: '首装 · 小笔电 1024×640', lang: 'zh-CN', width: 1024, height: 640, url: EXT_URL, probe: P },
  { name: '首装 · 窄窗 800×600', lang: 'zh-CN', width: 800, height: 600, url: EXT_URL, probe: P },
  { name: '首装 · 断网（天气该降级）', lang: 'zh-CN', url: EXT_URL, offline: true, probe: P },
  { name: '新标签页覆盖（chrome://newtab）', lang: 'zh-CN', url: 'chrome://newtab/', probe: P },
];

(async () => {
  console.log(`要验的扩展目录：${EXT}`);
  const results = [];
  for (const c of CASES) {
    console.log(`\n▶ ${c.name}`);
    try {
      const r = await runCase(c);
      results.push(r);
      console.log(`  装上的扩展 ID: ${r.loadedId}`);
      console.log(`  真实 URL: ${r.realUrl}`);
      console.log(`  探针: ${JSON.stringify(r.probe, null, 0)}`);
      const extReqs = r.requests.filter(u => !u.startsWith('chrome-extension://') && !u.startsWith('data:') && !u.startsWith('blob:'));
      console.log(`  网络请求：共 ${r.requests.length} 条，其中非扩展内部 ${extReqs.length} 条`);
      [...new Set(extReqs)].slice(0, 12).forEach(u => console.log('     → ' + u.slice(0, 130)));
      if (r.failedReq.length) console.log(`  失败请求 ${r.failedReq.length} 条: ${[...new Set(r.failedReq)].join(', ')}`);
      if (r.errors.length) r.errors.slice(0, 5).forEach(e => console.log('     ! ' + e.slice(0, 160)));
      else console.log('  控制台无 error');
    } catch (e) {
      console.log(`  ✗ 跑失败: ${e.message}`);
      results.push({ name: c.name, fatal: e.message });
    }
  }

  fs.writeFileSync(path.join(OUT, 'fresh-report.json'), JSON.stringify(results, null, 2));

  /* ── 判据 ──
     只有一条真正的红线：**首页不该报错**。
     断网那一条的 ERR_INTERNET_DISCONNECTED 是故意造出来的，要放过 ——
     否则这条守卫会因为「我们故意让它断网」而永远红。 */
  const bad = [];
  for (const r of results) {
    if (r.fatal) { bad.push(`${r.name} → 跑失败：${r.fatal}`); continue; }
    const errs = (r.errors || []).filter(e =>
      !(r.offline && /ERR_INTERNET_DISCONNECTED/.test(e)));
    if (errs.length) bad.push(`${r.name} → 控制台有 error：${errs[0].slice(0, 90)}`);
    const broken = Object.entries(r.probe || {}).filter(([, v]) => String(v).startsWith('ERR:'));
    if (broken.length) bad.push(`${r.name} → 探针失败：${broken.map(([k]) => k).join(', ')}`);
    if (r.probe && r.probe.cssLoaded === false) bad.push(`${r.name} → 样式表没加载上`);
    if (r.probe && r.probe.hOverflow === true) bad.push(`${r.name} → 出现横向溢出`);
  }

  console.log('\n报告: ' + path.join(OUT, 'fresh-report.json'));
  if (bad.length) {
    console.log(`\n${bad.length} 项不符合预期：`);
    bad.forEach(b => console.log('  ✗ ' + b));
  } else {
    console.log('\n六项全过：控制台零 error、无横向溢出、样式表正常 ✓');
  }
  process.exit(bad.length ? 1 : 0);
})();
