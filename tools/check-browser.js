/* Real browser integration tests. Node >=22, no npm dependencies.
 * GL_BROWSER=chrome|edge|firefox GL_BROWSER_BIN=/path/to/browser
 * GL_EXT=extension (Firefox: dist/firefox) GL_OUT=dist/browser-check
 * Uses a fresh temporary profile and local fixture pages only.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const ROOT = path.join(__dirname, '..');
const kind = process.env.GL_BROWSER || 'chrome';
const binary = process.env.GL_BROWSER_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ext = path.resolve(ROOT, process.env.GL_EXT || (kind === 'firefox' ? 'dist/firefox' : 'extension'));
const out = path.resolve(ROOT, process.env.GL_OUT || `dist/browser-check/${kind}`);
const uuid = '84d33971-3311-47d1-b1b3-8b507fb86e53';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'guilong-integration-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { browser: kind, extensionVersion: JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'))).version, platform: `${os.platform()} ${os.release()} ${os.arch()}`, checks: [] };
fs.mkdirSync(out, { recursive: true });
let proc, ws, api, context, session, dashboard, port, fixtures;
const errors = [];
async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (pending.has(message.id)) {
      const p = pending.get(message.id); pending.delete(message.id); clearTimeout(p.timer);
      message.error ? p.reject(new Error(JSON.stringify(message))) : p.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown' ||
      (message.method === 'log.entryAdded' && message.params.level === 'error')) {
      errors.push(message);
    }
  };
  ws = socket;
  return (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
async function evaluate(expression) {
  if (kind === 'firefox') {
    const r = await api('script.evaluate', { target: { context }, expression: `(async () => JSON.stringify(await (${expression})))()`, awaitPromise: true });
    if (r.type === 'exception') throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value === undefined ? undefined : JSON.parse(r.result.value);
  }
  const r = await api('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session);
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function waitFor(expression) {
  for (let i = 0; i < 60; i++) {
    try { if (await evaluate(expression)) return; } catch {}
    await sleep(100);
  }
  throw new Error(`Condition not reached: ${expression}`);
}
async function check(name, fn) {
  try { await fn(); report.checks.push({ name, pass: true }); console.log(`PASS ${name}`); }
  catch (e) { report.checks.push({ name, pass: false, error: e.message }); throw e; }
}
async function click(selector) {
  await waitFor(`!!document.querySelector(${JSON.stringify(selector)})`);
  await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw Error('Missing control: ' + ${JSON.stringify(selector)}); e.click(); return true; })()`);
}
async function navigate(url) {
  if (kind === 'firefox') await api('browsingContext.navigate', { context, url, wait: 'complete' });
  else await api('Page.navigate', { url }, session);
  await waitFor('typeof renderDashboard === "function" && document.querySelector("#statTabs")?.textContent !== "—"');
  await sleep(400);
}
async function start(install) {
  port = 10000 + Math.floor(Math.random() * 15000);
  const args = kind === 'firefox'
    ? ['--headless', '--no-remote', '--remote-allow-system-access', '--profile', profile, '--remote-debugging-port', String(port)]
    : ['--headless=new', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', 'about:blank'];
  const log = fs.openSync(path.join(out, 'browser.log'), 'a');
  proc = spawn(binary, args, { stdio: ['ignore', 'ignore', log] });
  fs.closeSync(log);
  let launchError;
  proc.on('error', e => { launchError = e; });
  for (let i = 0; i < 100; i++) {
    if (launchError) throw launchError;
    try {
      if (kind === 'firefox') api = await connect(`ws://127.0.0.1:${port}/session`);
      else {
        const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        report.browserVersion = ver.Browser;
        api = await connect(ver.webSocketDebuggerUrl);
      }
      break;
    } catch { await sleep(200); }
  }
  if (!api) throw Error('Browser did not start');
  if (kind === 'firefox') {
    const result = await api('session.new', { capabilities: {} });
    report.browserVersion = result.capabilities.browserVersion;
    await api('session.subscribe', { events: ['log.entryAdded'] });
    if (install) await api('webExtension.install', { extensionData: { type: 'path', path: ext } });
    ({ context } = await api('browsingContext.create', { type: 'tab' }));
    dashboard = `moz-extension://${uuid}/index.html`;
  } else {
    if (install) {
      const loaded = await api('Extensions.loadUnpacked', { path: ext });
      dashboard = `chrome-extension://${loaded.id}/index.html`;
    }
    const { targetId } = await api('Target.createTarget', { url: 'about:blank' });
    ({ sessionId: session } = await api('Target.attachToTarget', { targetId, flatten: true }));
    await api('Runtime.enable', {}, session);
    await api('Page.enable', {}, session);
  }
}
async function stop() {
  if (!proc) return;
  const child = proc;
  const exited = new Promise(r => { if (child.exitCode !== null) r(); else child.once('exit', r); });
  try { await api(kind === 'firefox' ? 'browser.close' : 'Browser.close'); } catch {}
  ws?.close();
  await Promise.race([exited, sleep(2500)]);
  if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.race([exited, sleep(1500)]);
  proc = null; api = null;
}
(async () => {
  if (kind === 'firefox') {
    fs.writeFileSync(path.join(profile, 'user.js'), `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ 'guilong@qwsir32-star.github.io': uuid }))});\n`);
  }
  fixtures = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Guilong browser fixture</title><p>Local browser test</p>');
  });
  await new Promise(r => fixtures.listen(0, '127.0.0.1', r));
  const n = fixtures.address().port;
  const first = `http://127.0.0.1:${n}/article`;
  const second = `http://localhost:${n}/reading`;
  await start(true);
  await check('new tab override and first render', async () => {
    if (kind === 'firefox') {
      const native = await api('browsingContext.getTree', {'moz:scope':'chrome'});
      report.nativeContexts = native.contexts.map(c=>({context:c.context,url:c.url}));
      const windowContext = native.contexts.find(c=>c.url.includes('browser.xhtml')) || native.contexts[0];
      const opened = await api('script.evaluate', {target:{context:windowContext.context}, expression:'document.querySelector("#tabs-newtab-button, #new-tab-button").click(); true', awaitPromise:false});
      if(opened.type === 'exception') throw Error(JSON.stringify(opened));
      for (let i=0;i<50;i++) {
        const tree=await api('browsingContext.getTree');
        const tab=tree.contexts.find(t=>t.url.startsWith('moz-extension:'));
        if(tab){context=tab.context;dashboard=tab.url;break;}
        await sleep(100);
      }
      await waitFor('typeof renderDashboard === "function"');
    } else {
      await navigate(kind === 'edge' ? 'edge://newtab/' : 'chrome://newtab/');
    }
    assert.match(await evaluate('location.href'), /(?:chrome|moz)-extension:/);
    assert.equal(await evaluate('getComputedStyle(document.documentElement).getPropertyValue("--ink").trim() !== ""'), true);
  });
  await check('group tabs and update real toolbar badge', async () => {
    await evaluate(`(async () => { await setUiPref('showWeather', false); for (const url of ${JSON.stringify([first, first, second])}) await chrome.tabs.create({url, active:false}); await new Promise(r=>setTimeout(r,500)); await renderDashboard(); return true; })()`);
    await waitFor('document.querySelectorAll("[data-action=focus-tab]").length >= 2');
    await waitFor('(async()=> (await chrome.action.getBadgeText({})) === String((await chrome.tabs.query({})).filter(t=>!envOf().isInternalUrl(t.url)).length))()');
    assert.equal(await evaluate('domainGroups.some(g=>g.tabs.some(t=>t.url.includes("127.0.0.1")))'), true);
    assert.equal(await evaluate('domainGroups.some(g=>g.tabs.some(t=>t.url.includes("localhost")))'), true);
  });
  await check('deduplicate via actual UI event', async () => {
    await click('[data-action="dedup-keep-one"]');
    await waitFor(`(async()=> (await chrome.tabs.query({})).filter(t=>t.url===${JSON.stringify(first)}).length===1)()`);
    await evaluate('renderDashboard().then(()=>true)');
  });
  await check('save, archive and restore via UI', async () => {
    await click(`[data-action="defer-single-tab"][data-tab-url="${first}"]`);
    await waitFor('(async()=> (await getSavedTabs()).active.length === 1)()');
    await waitFor(`(async()=> !(await chrome.tabs.query({})).some(t=>t.url===${JSON.stringify(first)}))()`);
    await click('[data-action="check-deferred"]');
    await waitFor('(async()=> (await getSavedTabs()).archived.length === 1)()');
    await sleep(1300);
    await click('[data-action="restore-archived"]');
    await waitFor('(async()=> (await getSavedTabs()).active.length === 1 && (await getSavedTabs()).archived.length === 0)()');
  });
  await check('focus tab in a different window', async () => {
    await evaluate(`(async()=>{ await chrome.windows.create({url:${JSON.stringify(first + '?window=2')},focused:false}); await new Promise(r=>setTimeout(r,500)); await renderDashboard(); return true; })()`);
    await click(`[data-action="focus-tab"][data-tab-url="${first}?window=2"]`);
    await waitFor(`(async()=> {const t=(await chrome.tabs.query({})).find(t=>t.url===${JSON.stringify(first+'?window=2')}); return t?.active && (await chrome.windows.get(t.windowId)).focused;})()`);
  });
  await check('settings modal, language, theme and pin storage', async () => {
    await click('[data-action="toggle-settings"]');
    assert.equal(await evaluate('document.querySelector("#settingsPanel").open'), true);
    await evaluate(`(() => { for(const [key,value] of [['language','en'],['theme','dark']]) {const e=document.querySelector('[data-setting="'+key+'"]');e.value=value;e.dispatchEvent(new Event('change',{bubbles:true}));} return true; })()`);
    await waitFor('document.title === "Guilong" && document.documentElement.dataset.theme === "dark"');
    assert.equal((await evaluate(`pinSite({url:"https://example.com/reading",title:"Test pin",icon:"T"})`)).ok, true);
    await click('[data-action="close-settings"]');
    assert.equal(await evaluate('document.querySelector("#settingsPanel").open'), false);
  });
  await check('reload retains saved items, theme, language and pins', async () => {
    await navigate(dashboard);
    assert.equal(await evaluate('(async()=> (await getSavedTabs()).active.length)()'), 1);
    assert.equal(await evaluate('document.documentElement.dataset.theme'), 'dark');
    assert.equal(await evaluate('(async()=> (await getPinnedSites()).length)()'), 1);
  });
  await check('group close requires two clicks and preserves other group', async () => {
    const selector = '[data-action="close-domain-tabs"][data-domain-id="domain-localhost"]';
    await click(selector);
    assert.equal(await evaluate(`(async()=> (await chrome.tabs.query({})).some(t=>t.url===${JSON.stringify(second)}))()`), true);
    await click(selector);
    await waitFor(`(async()=> !(await chrome.tabs.query({})).some(t=>t.url===${JSON.stringify(second)}))()`);
    assert.equal(await evaluate(`(async()=> (await chrome.tabs.query({})).some(t=>t.url===${JSON.stringify(first+'?window=2')}))()`), true);
  });
  await check('shortcut registered', async () => {
    const commands = await evaluate('chrome.commands.getAll()');
    const shortcut = commands.find(c => c.name === 'open-dashboard')?.shortcut;
    assert.ok(shortcut, 'Browser must register a nonempty shortcut');
    report.shortcut = shortcut;
  });
  await evaluate('(async()=>{const t=await chrome.tabs.getCurrent();await chrome.tabs.update(t.id,{active:true});await chrome.windows.update(t.windowId,{focused:true});await renderDashboard();return true;})()');
  await sleep(1200);
  if (kind !== 'firefox') {
    const screenshot = await api('Page.captureScreenshot', { format: 'png' }, session);
    fs.writeFileSync(path.join(out, 'dashboard.png'), Buffer.from(screenshot.data, 'base64'));
  } else {
    report.screenshot = 'Not captured: Firefox BiDi does not support privileged extension screenshots';
  }
  await stop();
  await start(kind !== 'firefox');
  await check('browser restart, reload test extension and data persistence', async () => {
    if (kind === 'firefox') {
      await api('browsingContext.navigate', { context, url: 'about:newtab', wait: 'complete' });
      assert.equal(await evaluate('typeof renderDashboard'), 'undefined', 'Temporary extension must not persist');
      await api('webExtension.install', { extensionData: { type: 'path', path: ext } });
    }
    await navigate(dashboard);
    assert.equal(await evaluate('(async()=> (await getSavedTabs()).active.length)()'), 1);
    assert.equal(await evaluate('(async()=> (await getPinnedSites()).length)()'), 1);
    assert.equal(await evaluate('document.documentElement.dataset.theme'), 'dark');
    assert.equal(await evaluate('document.title'), 'Guilong');
  });
  report.errors = errors;
  assert.equal(errors.length, 0, 'No page runtime errors');
})().catch(async e => { report.failure = e.message; console.error(e); try { report.diagnostic = await evaluate('({url:location.href,title:document.title,body:document.body.innerText.slice(0,800),render:typeof renderDashboard})'); console.log(report.diagnostic); } catch(d) { console.log('Diagnostic:',d.message); } if (process.env.GITHUB_ACTIONS) {
    const diagnostic = JSON.stringify({ failure: report.failure, lastCheck: report.checks.at(-1), diagnostic: report.diagnostic }).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    console.log(`::error title=Browser test failure::${diagnostic}`);
  }
  process.exitCode = 1; }).finally(async () => {
  await stop();
  fixtures?.close();
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Report: ${path.join(out, 'report.json')}`);
  fs.rmSync(profile, { recursive: true, force: true });
});
