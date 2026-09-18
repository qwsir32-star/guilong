/* =====================================================================
   check-favicon-network.js —— 取证：归拢会不会向第三方图标服务发请求？

   PRIVACY.md 写的是「这是整个扩展唯一一次联网」（指天气）。这条承诺最容易被
   **图标**破掉。

   【第一轮 · 2026-09-19 修复前】
   app.js 里有**四处**图标地址直连
   `https://www.google.com/s2/favicons?domain=...` 当 <img src>，
   其中三处是**主路径**（不是失败兜底）：
     卡片里每个 chip / 「+N」展开的 chip / 「稍后再看」每一条
   而 chip 代表的是**当前开着的标签页** —— 每开一次新标签页就在向 Google
   报一遍你在逛哪些站。首装测试看不到它，因为这个场景需要
   「同一个域名开了很多标签页」，一行放不下才走溢出分支。

   当时抓到的：26 个同域名标签页 → DOM 里 26 张 google 图、0 张 _favicon，
   网络层真抓到 google.com/s2 → 302 → t0.gstatic.com。

   【第二轮 · 修复后（现在的判据，反向的）】
   四处统一改成 faviconUrlFor()（本地 _favicon 端点），兜底改成直接删图。所以：
     · DOM 里指向 google/gstatic 的图必须是 0
     · DOM 里指向 _favicon 的图必须 > 0（图标真的还在，不是全删了）
     · 网络层对外请求里不许有 google / gstatic
   ⚠️ 第三项别只看条数，要按主机名过一遍 —— 条数对了不代表没打到 Google。

   跑法：
     node tools/check-favicon-network.js                    # 验源码目录
     GL_EXT=dist/chrome node tools/check-favicon-network.js # 验打好的商店包

   ⚠️ **要在沙箱外跑。** Chrome 启动时会写自己的配置目录
   （`~/Library/Application Support/Google/RLZ/…`），被沙箱拦住就起不来。
   ===================================================================== */
const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.GL_CHROME
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const extArg = process.env.GL_EXT;
const EXT = extArg
  ? (path.isAbsolute(extArg) ? extArg : path.join(ROOT, extArg))
  : path.join(ROOT, 'extension');
const EXT_URL = 'chrome-extension://ihejaehbfjlhnbdkkinphfcojpifldlk/index.html';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const httpJson = url => new Promise((res, rej) => {
  http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

const SAME_DOMAIN_TABS = 26;

(async () => {
  console.log(`要验的扩展目录：${EXT}`);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-leak-'));
  const port = 9666;
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check',
    '--window-size=1280,900', 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  await sleep(3500);
  const ver = await httpJson(`http://127.0.0.1:${port}/json/version`);
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
  let seq = 0; const pending = new Map(); const reqs = []; const sent = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); return; }
    if (m.method === 'Network.requestWillBeSent') { sent.set(m.params.requestId, m.params.request.url); reqs.push(m.params.request.url); }
  };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const id = ++seq; pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });

  await send('Extensions.loadUnpacked', { path: EXT });
  await sleep(1200);

  // 先制造「一个域名开了很多标签页」的真实场景
  console.log(`造 ${SAME_DOMAIN_TABS} 个同域名标签页…`);
  for (let i = 0; i < SAME_DOMAIN_TABS; i++) {
    await send('Target.createTarget', { url: `https://example.com/#gl-${i}` });
  }
  await sleep(4000);

  // 再开仪表盘
  const { targetId } = await send('Target.createTarget', { url: EXT_URL });
  const { sessionId: S } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, S); await send('Page.enable', {}, S); await send('Network.enable', {}, S);
  await sleep(6000);

  const ev = async e => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, S)).result.value;

  console.log('标签页数（chrome.tabs.query 视角）:', await ev('new Promise(r=>chrome.tabs.query({},t=>r(t.length)))'));
  console.log('卡片数量:', await ev('document.querySelectorAll(".page-chip").length'));
  console.log('\n=== DOM 里 src 指向 google.com 的图片 ===');
  const goog = await ev(`JSON.stringify([...document.images]
     .map(i => i.src).filter(u => u.includes('google.com') || u.includes('gstatic')), null, 1)`);
  console.log(goog);
  console.log('\n=== DOM 里 src 指向 _favicon 的图片 ===');
  const localN = await ev(`[...document.images]
     .map(i => i.src.replace(/^chrome-extension:\\/\\/[a-z]+\\//,''))
     .filter(u => u.startsWith('_favicon')).length`);
  console.log(await ev(`JSON.stringify([...document.images]
     .map(i => i.src.replace(/^chrome-extension:\\/\\/[a-z]+\\//,''))
     .filter(u => u.startsWith('_favicon')).slice(0,3), null, 1)`));

  console.log('\n=== 网络层：真正发出去的对外请求 ===');
  const ext = [...new Set(reqs)].filter(u => !u.startsWith('chrome-extension://') && !u.startsWith('about:') && !u.startsWith('data:'));
  ext.forEach(u => console.log('   → ' + u.slice(0, 150)));
  console.log(`   共 ${ext.length} 条`);

  const bad = ext.filter(u => /google|gstatic/i.test(u));
  const googN = JSON.parse(goog).length;
  console.log('\n=== 结论 ===');
  console.log(`  DOM 里指向 google/gstatic 的图：${googN} 张（期望 0）`);
  console.log(`  DOM 里走本地 _favicon 的图：${localN} 张（期望 > 0，否则是「把图标全删了」而不是「改成本地了」）`);
  console.log(`  网络层打到 google/gstatic 的请求：${bad.length} 条（期望 0）`);

  const ok = googN === 0 && bad.length === 0 && localN > 0;
  console.log(ok ? '\n图标已全部本地化 ✓' : '\n✗ 不符合预期（仍在向 Google 联网，或图标被整个删掉了）');

  proc.kill('SIGKILL'); await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(ok ? 0 : 1);
})();
