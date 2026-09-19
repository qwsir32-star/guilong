/* =====================================================================
   check-screenshot-page.js —— 把 make-screenshot-page.js 生成的那几页
   放进真 Chrome 跑一遍，确认它们「该显示的都显示了、而且能拍」

   为什么不能只看生成器的自检：生成器只能看**字符串**（锚点命中几次、
   字体有没有内联）。而这几页的价值全在**跑起来之后**——
   搜索框真的 display:none 吗？主题真的是 paper 吗？每条 chip 都有图标吗？
   「还有 N 个」折叠 chip、橙条、重复徽章真的渲染出来了吗？
   这些都只有真 Chrome 量得出来。

   ⚠️ 上一版把「图标数量」写成 console.log，于是「23/24 张 chip 带图标」
   被打印出来却不算失败 —— 少的正是 search.bilibili.com（兄弟子域查不到表里
   www.bilibili.com 那张图）。**打印不是守卫，断言才是。**

   ⚠️「折叠与重复」那页尤其需要这一层：数据被改坏（比如把 github 的 13 条
   改回 3 条）时，那页**照样生成成功**，只是什么也演示不出来 ——
   这种失败在生成器的字符串自检里根本看不见。

   跑法（⚠️ 必须脱离沙箱：Chrome 要写 ~/Library/Application Support/Google/RLZ）：
     node tools/check-screenshot-page.js
   可覆盖：GL_CHROME（Chrome 可执行文件）、GL_OUT（截图输出目录）、
           GL_ONLY（只跑某一页，按 label 关键字，如 GL_ONLY=折叠）
   ===================================================================== */
const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const http = require('http');
const { pathToFileURL } = require('url');

const CHROME = process.env.GL_CHROME
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT_DIR = path.join(__dirname, '..', '..', 'outputs');
// ⚠️ 不要把图丢进 outputs/guilong-fresh-install/ —— 那是 check-fresh-install.js
//    用**真扩展 + 全新 profile** 拍的（空状态），跟这里的「演示数据页」是两回事。
const OUT = process.env.GL_OUT || path.join(OUT_DIR, 'guilong-screenshot-page');

const VIEWPORT = { width: 1280, height: 800 };

/* 每页的期望值。改 make-screenshot-page.js 的数据时这几个数要跟着改 ——
   改错了这里会红，那正是它的用处。
   ⚠️ `icons` 是**带图标的 chip 数**，比标签页数少 1 的地方是「还有 N 个」那颗
   按钮（它带 .page-chip 但没有图标）。 */
const PAGES = [
  {
    label: '默认（全新安装）',
    file:  path.join(OUT_DIR, 'guilong-全新安装预览.html'),
    shot:  'preview-default',
    expect: { tabs: 24, cards: 8, icons: 24, theme: 'paper', city: '上海' },
    extra: [],
  },
  {
    label: '折叠与重复',
    file:  path.join(OUT_DIR, 'guilong-折叠与重复预览.html'),
    shot:  'preview-folded',
    expect: { tabs: 28, cards: 6, icons: 27, theme: 'paper', city: '上海' },
    /* 这两样是这页存在的**唯一理由**，所以逐条断言到具体文案。
       ⚠️「还有 4 个」里的 4 = 12 - 8（app.js:1711 的 slice(0,8)），
       改了 github 的条数就要改这里。 */
    extra: [
      ['「还有 4 个」折叠 chip 渲染出来了',
        `document.querySelectorAll('.page-chip-overflow').length === 1 &&
         /还有 4 个/.test(document.querySelector('.page-chip-overflow').textContent)`],
      ['折叠容器里真的藏了 4 条 chip（不是空壳）',
        `document.querySelectorAll('.page-chips-overflow .page-chip').length === 4`],
      ['恰好 1 张卡带橙条（= 有重复）',
        `document.querySelectorAll('.domain-card.has-amber-bar').length === 1`],
      ['那张带橙条的卡是 GitHub',
        `document.querySelector('.domain-card.has-amber-bar .mission-name').textContent === 'GitHub'`],
      ['「1 个重复」徽章出现',
        `[...document.querySelectorAll('[data-badge="dupes"]')].map(e => e.textContent.trim()).join() === '1 个重复'`],
      ['重复的那条 chip 带 (2x) 标记',
        `[...document.querySelectorAll('.chip-dupe-badge')].map(e => e.textContent.trim()).join() === '(2x)'`],
      ['「关闭 1 个重复」按钮出现',
        `[...document.querySelectorAll('[data-action="dedup-keep-one"]')].map(e => e.textContent.trim()).join() === '关闭 1 个重复'`],
      ['github 卡标的是 13 条（含重复那条）',
        `document.querySelector('.domain-card[data-domain-id="domain-github-com"] .mission-page-count').textContent === '13'`],
      /* ⚠️ 这条是「别把两件事搞混」的守卫：#tabOutDupeBanner 说的是
         「你开了好几个**归拢页**」，跟「同一网址开两次」是两回事，
         商店截图里不该出现那种「你开多了」的提示。 */
      ['#tabOutDupeBanner 不出现（它管的是「开了多个归拢页」，不是重复标签页）',
        `getComputedStyle(document.getElementById('tabOutDupeBanner')).display === 'none'`],
    ],
  },
];

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

let ok = true;
const line = (good, text) => { if (!good) ok = false; console.log((good ? '  ✓ ' : '  ✗ ') + text); };

async function checkPage(cdp, cfg) {
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
    { ...VIEWPORT, deviceScaleFactor: 2, mobile: false }, S);

  await cdp.send('Page.navigate', { url: pathToFileURL(cfg.file).href }, S);
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

  const E = cfg.expect;
  console.log(`\n【${cfg.label}】${path.basename(cfg.file)}`);

  const cards = await probe('document.querySelectorAll(".domain-card").length');
  line(cards === E.cards, `域名卡片 ${cards} 张（期望 ${E.cards}）`);
  // ⚠️ 不能拿 .page-chip 的 DOM 总数当「可见 chip 数」：buildOverflowChips 会额外
  //    产出一个 display:none 容器 + 一个「还有 N 个」按钮，两者都带 .page-chip。
  //    所以改读**页面自己标的数字**。
  const perCard = await probe(`[...document.querySelectorAll('.mission-page-count')].map(e=>parseInt(e.textContent,10))`);
  const sum = perCard.reduce((a, b) => a + b, 0);
  line(sum === E.tabs, `每张卡标记的标签页数合计 ${sum}（期望 ${E.tabs}）`);
  console.log('  · 卡片标题:', await probe(`[...document.querySelectorAll(".mission-name")].map(e=>e.textContent).join(" | ")`));

  console.log('  —— 默认设置真的生效了吗（这是这些页面存在的理由）');
  const sb = await probe('getComputedStyle(document.getElementById("searchBar")).display');
  const qs = await probe('getComputedStyle(document.getElementById("quickSites")).display');
  line(sb === 'none', `搜索框 display=${sb}（默认关 → none）`);
  line(qs === 'none', `常用站点条 display=${qs}（默认关 → none）`);
  const theme = await probe('document.documentElement.dataset.theme');
  line(theme === E.theme, `主题 data-theme=${theme}（默认 ${E.theme}）`);

  console.log('  —— 内容');
  console.log('  · 问候语:', await probe('document.getElementById("greeting").textContent'),
    '| 日期:', await probe('document.getElementById("dateDisplay").textContent'));
  const wCity = await probe('document.getElementById("weatherCity").textContent');
  console.log('  · 天气:', wCity,
    await probe('document.getElementById("weatherDesc").textContent'),
    await probe('document.getElementById("weatherTemp").textContent'),
    await probe('document.getElementById("weatherRange").textContent'));
  line(wCity.includes(E.city), `城市是默认的「${E.city}」→ ${wCity}`);
  line(await probe('getComputedStyle(document.getElementById("weather")).display') !== 'none', '天气条可见（默认开）');

  console.log('  —— 版面');
  const over = await probe('document.documentElement.scrollWidth - document.documentElement.clientWidth');
  line(over <= 0, `横向溢出 ${over}px（要 ≤ 0）`);
  /* 「一屏拍全」的判据是**仪表盘**放得下，不是整页 —— 页脚本来就在折线以下，
     真实新标签页也一样（标签页一多，页脚必然要滚）。拿整页高度当判据会逼着
     我去砍内容或藏页脚，那是为了断言好看而骗人。 */
  const dashBottom = await probe(
    `Math.round(document.getElementById('dashboardColumns').getBoundingClientRect().bottom + scrollY)`);
  line(dashBottom <= VIEWPORT.height,
    `仪表盘底 ${dashBottom}px ≤ 视口 ${VIEWPORT.height}px（整个仪表盘一屏拍得下）`);
  console.log('  · 整页高度:', await probe('document.body.scrollHeight'),
    'px（页脚在折线以下，要滚一下才有 —— 真实页面亦然）');
  const broken = await probe(`[...document.images].filter(i => !i.complete || i.naturalWidth === 0).length`);
  line(broken === 0, `破图 ${broken} 张（要 0）`);
  const withIcon = await probe(`[...document.images].filter(i => i.naturalWidth > 0).length`);
  line(withIcon === E.icons, `有图标的 chip ${withIcon} 个（期望 ${E.icons}）`);

  if (cfg.extra.length) {
    console.log('  —— 这一页专属的画面（它存在的理由）');
    for (const [name, expr] of cfg.extra) {
      const v = await probe(`(() => { return (${expr}); })()`);
      line(v === true, name + (v === true ? '' : `   → 实得 ${JSON.stringify(v)}`));
    }
  }

  console.log('  —— 控制台 / 网络');
  line(errors.length === 0, `错误 ${errors.length} 条`);
  errors.slice(0, 10).forEach(e => console.log('      ' + e.slice(0, 160)));
  const ext = reqs.filter(u => !u.startsWith('file:') && !u.startsWith('data:'));
  line(ext.length === 0, `对外网络请求 ${ext.length} 条（要 0 —— 这些页面除了天气桩不联网）`);
  ext.slice(0, 5).forEach(u => console.log('      ' + u));
  line(failed.length === 0, `失败的请求 ${failed.length} 条`);

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, S);
  fs.writeFileSync(path.join(OUT, cfg.shot + '.png'), Buffer.from(shot.data, 'base64'));
}

(async () => {
  const want = process.env.GL_ONLY;
  const pages = want ? PAGES.filter(p => p.label.includes(want)) : PAGES;
  if (!pages.length) { console.error('❌ GL_ONLY 没匹配到任何页面：' + want); process.exit(1); }
  for (const p of pages) {
    if (!fs.existsSync(p.file)) {
      console.error('❌ 页面不存在，先跑 node tools/make-screenshot-page.js\n   ' + p.file);
      process.exit(1);
    }
  }
  fs.mkdirSync(OUT, { recursive: true });

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-shot-'));
  const port = 9500 + Math.floor(Math.random() * 300);
  const proc = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    '--lang=zh-CN', '--accept-lang=zh-CN',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr.on('data', () => {});

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

    for (const p of pages) await checkPage(cdp, p);
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
