/* =====================================================================
   check-screenshot-page.js —— 把 make-screenshot-page.js 生成的那一页
   放进真 Chrome 跑一遍，确认它真的是「出厂默认 + 能拍」

   为什么不能只看生成器的自检：生成器只能看**字符串**（锚点命中几次、
   字体有没有内联）。而这一页的价值全在**跑起来之后**——
   搜索框真的 display:none 吗？主题真的是 paper 吗？24 条 chip 是不是
   每条都有图标？有没有横溢出？整页多高、要不要滚？这些都只有真 Chrome
   量得出来。

   ⚠️ 上一版这里把「图标数量」写成 console.log，于是「23/24 张 chip 带图标」
   被打印出来却不算失败 —— 少的正是 search.bilibili.com（兄弟子域查不到表里
   www.bilibili.com 那张图）。**打印不是守卫，断言才是。**

   跑法（⚠️ 必须脱离沙箱：Chrome 要写 ~/Library/Application Support/Google/RLZ）：
     node tools/check-screenshot-page.js
   可覆盖：GL_CHROME（Chrome 可执行文件）、GL_OUT（截图输出目录）
   ===================================================================== */
const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const http = require('http');
const { pathToFileURL } = require('url');

const CHROME = process.env.GL_CHROME
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PAGE = path.join(__dirname, '..', '..', 'outputs', 'guilong-全新安装预览.html');
// ⚠️ 不要把图丢进 outputs/guilong-fresh-install/ —— 那是 check-fresh-install.js
//    用**真扩展 + 全新 profile** 拍的（空状态），跟这里的「演示数据页」是两回事。
const OUT  = process.env.GL_OUT || path.join(__dirname, '..', '..', 'outputs', 'guilong-screenshot-page');

/* 期望值。改 make-screenshot-page.js 的 DEMO_TABS 时这几个数要跟着改 ——
   改错了这里会红，那正是它的用处。 */
const EXPECT = {
  tabs:    24,     // 演示标签页总数
  cards:    8,     // 按 siteKey 归并后的站点卡数（10 个域名 → 8 个站点）
  icons:   24,     // 每一条 chip 都该有图标（= tabs）
  theme:   'paper',
  city:    '上海',
  viewport: { width: 1280, height: 800 },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const httpJson = url => new Promise((res, rej) => {
  http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

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

(async () => {
  if (!fs.existsSync(PAGE)) {
    console.error('❌ 预览页不存在，先跑 node tools/make-screenshot-page.js\n   ' + PAGE);
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-shot-'));
  const port = 9500 + Math.floor(Math.random() * 300);
  const proc = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    `--window-size=${EXPECT.viewport.width},${EXPECT.viewport.height}`,
    '--lang=zh-CN', '--accept-lang=zh-CN',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr.on('data', () => {});

  let ok = true;
  const line = (good, text) => { if (!good) ok = false; console.log((good ? '  ✓ ' : '  ✗ ') + text); };

  try {
    let ver = null;
    for (let i = 0; i < 60 && !ver; i++) {
      await sleep(250);
      try { ver = await httpJson(`http://127.0.0.1:${port}/json/version`); } catch { }
    }
    if (!ver) throw new Error('调试口没起来（在沙箱里跑会被拦，要脱离沙箱）');

    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('WS 连不上')); });
    const cdp = new CDP(ws);

    const errors = [], reqs = [], failed = [];
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

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: S } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, S);
    await cdp.send('Log.enable', {}, S);
    await cdp.send('Page.enable', {}, S);
    await cdp.send('Network.enable', {}, S);
    cdp.on(m => {
      if (m.sessionId !== S) return;
      if (m.method === 'Network.requestWillBeSent') reqs.push(m.params.request.url);
      if (m.method === 'Network.loadingFailed') failed.push(m.params.errorText);
    });

    // 视口锁死 —— 截图口径必须确定，否则「刚好放得下」每次都不一样
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { ...EXPECT.viewport, deviceScaleFactor: 2, mobile: false }, S);

    await cdp.send('Page.navigate', { url: pathToFileURL(PAGE).href }, S);
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      const r = await cdp.send('Runtime.evaluate',
        { expression: 'document.readyState === "complete"', returnByValue: true }, S);
      if (r.result.value) break;
    }
    await sleep(2500);   // 等天气 / favicon 的异步尾巴

    const probe = async expr => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }, S);
      return r.exceptionDetails ? 'ERR: ' + r.exceptionDetails.text : r.result.value;
    };

    console.log('\n【基本渲染】');
    const cards = await probe('document.querySelectorAll(".domain-card").length');
    line(cards === EXPECT.cards, `域名卡片 ${cards} 张（期望 ${EXPECT.cards}）`);
    // ⚠️ 不能拿 .page-chip 的 DOM 总数当「可见 chip 数」：buildOverflowChips 会额外
    //    产出一个 display:none 容器 + 一个「还有 N 个」按钮，两者都带 .page-chip。
    //    所以改读**页面自己标的数字**。
    const perCard = await probe(`[...document.querySelectorAll('.mission-page-count')].map(e=>parseInt(e.textContent,10))`);
    const sum = perCard.reduce((a, b) => a + b, 0);
    line(sum === EXPECT.tabs, `每张卡标记的标签页数合计 ${sum}（期望 ${EXPECT.tabs}）`);
    console.log('  · 分区计数:', await probe('document.getElementById("openTabsSectionCount").textContent'));
    console.log('  · 卡片标题:', await probe(`[...document.querySelectorAll(".mission-name")].map(e=>e.textContent).join(" | ")`));

    console.log('\n【默认设置真的生效了吗（这是这一页存在的理由）】');
    const sb = await probe('getComputedStyle(document.getElementById("searchBar")).display');
    const qs = await probe('getComputedStyle(document.getElementById("quickSites")).display');
    line(sb === 'none', `搜索框 display=${sb}（默认关 → none）`);
    line(qs === 'none', `常用站点条 display=${qs}（默认关 → none）`);
    const theme = await probe('document.documentElement.dataset.theme');
    line(theme === EXPECT.theme, `主题 data-theme=${theme}（默认 ${EXPECT.theme}）`);
    console.log('  · html lang =', await probe('document.documentElement.lang'));

    console.log('\n【内容】');
    console.log('  · 问候语:', await probe('document.getElementById("greeting").textContent'));
    console.log('  · 日期:', await probe('document.getElementById("dateDisplay").textContent'));
    console.log('  · 天气:', await probe('document.getElementById("weatherCity").textContent'),
      await probe('document.getElementById("weatherDesc").textContent'),
      await probe('document.getElementById("weatherTemp").textContent'),
      await probe('document.getElementById("weatherRange").textContent'));
    const wCity = await probe('document.getElementById("weatherCity").textContent');
    line(wCity.includes(EXPECT.city), `城市是默认的「${EXPECT.city}」→ ${wCity}`);
    line(await probe('getComputedStyle(document.getElementById("weather")).display') !== 'none', '天气条可见（默认开）');

    console.log('\n【版面】');
    const over = await probe('document.documentElement.scrollWidth - document.documentElement.clientWidth');
    line(over <= 0, `横向溢出 ${over}px（要 ≤ 0）`);
    /* 「一屏拍全」的判据是**仪表盘**放得下，不是整页 —— 页脚本来就在折线以下，
       真实新标签页也一样（标签页一多，页脚必然要滚）。拿整页高度当判据会逼着
       我去砍内容或藏页脚，那是为了断言好看而骗人。 */
    const dashBottom = await probe(
      `Math.round(document.getElementById('dashboardColumns').getBoundingClientRect().bottom + scrollY)`);
    line(dashBottom <= EXPECT.viewport.height,
      `仪表盘底 ${dashBottom}px ≤ 视口 ${EXPECT.viewport.height}px（整个仪表盘一屏拍得下）`);
    console.log('  · 整页高度:', await probe('document.body.scrollHeight'),
      'px（页脚在折线以下，要滚一下才有 —— 真实页面亦然）');
    console.log('  · 网格底 / 页脚顶:', await probe(`JSON.stringify((()=>{
      const b=[...document.querySelectorAll('.domain-card')].map(c=>Math.round(c.getBoundingClientRect().bottom+scrollY));
      const f=document.querySelector('footer');
      return {gridBottom:Math.max(...b), footerTop:Math.round(f.getBoundingClientRect().top+scrollY)};
    })())`));
    const broken = await probe(`[...document.images].filter(i => !i.complete || i.naturalWidth === 0).length`);
    line(broken === 0, `破图 ${broken} 张（要 0）`);
    // ⚠️ 这条是断言不是打印：上一版这里是 console.log，于是「23/24 带图标」被打印
    //    出来却不算失败，少的正是 search.bilibili.com（兄弟子域查不到那张图）。
    const withIcon = await probe(`[...document.images].filter(i => i.naturalWidth > 0).length`);
    line(withIcon === EXPECT.icons, `有图标的 chip ${withIcon} 个（期望 ${EXPECT.icons} = 每条 chip 都有）`);

    console.log('\n【控制台 / 网络】');
    line(errors.length === 0, `错误 ${errors.length} 条`);
    errors.slice(0, 10).forEach(e => console.log('      ' + e.slice(0, 160)));
    const ext = reqs.filter(u => !u.startsWith('file:') && !u.startsWith('data:'));
    line(ext.length === 0, `对外网络请求 ${ext.length} 条（要 0 —— 这一页除了天气桩不联网）`);
    ext.slice(0, 5).forEach(u => console.log('      ' + u));
    line(failed.length === 0, `失败的请求 ${failed.length} 条`);

    const shot1 = await cdp.send('Page.captureScreenshot', { format: 'png' }, S);
    fs.writeFileSync(path.join(OUT, 'preview-viewport.png'), Buffer.from(shot1.data, 'base64'));
    const shot2 = await cdp.send('Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: true }, S);
    fs.writeFileSync(path.join(OUT, 'preview-fullpage.png'), Buffer.from(shot2.data, 'base64'));
    console.log('\n截图:', OUT);
  } catch (e) {
    ok = false;
    console.log('崩溃:', e.message);
  } finally {
    proc.kill('SIGKILL');
    await sleep(300);
    console.log('\n' + (ok ? '✅ 全过' : '❌ 有问题'));
    process.exit(ok ? 0 : 1);
  }
})();
