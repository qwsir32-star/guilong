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
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('WebSocket connection timeout')); }, 3000);
    socket.onopen = () => { clearTimeout(timer); resolve(); };
    socket.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket connection failed')); };
    socket.onclose = () => { clearTimeout(timer); reject(new Error('WebSocket closed before connection')); };
  });
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
    if (proc.exitCode !== null || proc.signalCode !== null) throw Error('Browser exited during startup; see browser.log');
    try {
      if (kind === 'firefox') api = await connect(`ws://127.0.0.1:${port}/session`);
      else {
        const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`, {signal:AbortSignal.timeout(3000)})).json();
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
  await check('card count sorting, drag swap and persistence', async () => {
    const order = 'Array.from(document.querySelectorAll("#openTabsMissions .domain-card"), c=>c.dataset.groupKey)';
    assert.deepEqual(await evaluate(order), ['127.0.0.1', 'localhost']);
    await evaluate(`(() => {
      const cards = document.querySelectorAll('#openTabsMissions .domain-card');
      const dataTransfer = new DataTransfer();
      cards[1].querySelector('.card-drag-handle').dispatchEvent(new DragEvent('dragstart', {bubbles:true,dataTransfer}));
      cards[0].dispatchEvent(new DragEvent('dragover', {bubbles:true,cancelable:true,dataTransfer}));
      cards[0].dispatchEvent(new DragEvent('drop', {bubbles:true,cancelable:true,dataTransfer}));
      return true;
    })()`);
    await waitFor(`(${order})[0] === 'localhost'`);
    await navigate(dashboard);
    assert.deepEqual(await evaluate(order), ['localhost','127.0.0.1']);
    await click('[data-action="card-reset"]');
    await waitFor(`(${order})[0] === '127.0.0.1'`);
    await navigate(dashboard);
    assert.deepEqual(await evaluate(order), ['127.0.0.1','localhost']);
  });
  await check('tab count growth overrides saved swaps and reset restores automatic order', async () => {
    const order = 'Array.from(document.querySelectorAll("#openTabsMissions .domain-card"), c=>c.dataset.groupKey)';
    await evaluate("updateCardOrder('swap','127.0.0.1','localhost').then(()=>true)");
    assert.equal((await evaluate(order))[0],'localhost');
    const extra = await evaluate(`(async()=>{const ids=[];for(let i=0;i<3;i++) ids.push((await chrome.tabs.create({url:${JSON.stringify(first)},active:false})).id);return ids;})()`);
    await waitFor(`(async()=> (await chrome.tabs.query({})).filter(t=>t.url===${JSON.stringify(first)}).length===5)()`);
    await evaluate('renderDashboard().then(()=>true)');
    assert.equal((await evaluate(order))[0],'127.0.0.1','Five tabs must move back above the saved one-tab card');
    await navigate(dashboard);
    assert.equal((await evaluate(order))[0],'127.0.0.1');
    await evaluate(`(async()=>{await chrome.tabs.remove(${JSON.stringify(extra)});await renderDashboard();return true;})()`);
    assert.equal((await evaluate(order))[0],'127.0.0.1','Count decrease must not resurrect the earlier saved swap');
    await evaluate(`chrome.storage.local.set({domainCardOrder:{}}).then(()=>renderDashboard()).then(()=>true)`);
  });
  await check('unequal height cards swap visual columns without replaying entrance animations', async () => {
    // Exercise a visible page; Firefox BiDi cannot activate privileged extension contexts.
    if (kind === 'firefox') await evaluate('(async()=>{const tab=await chrome.tabs.getCurrent();await chrome.tabs.update(tab.id,{active:true});return true;})()');
    else await api('Page.bringToFront', {}, session);
    await waitFor('document.visibilityState === "visible"');
    const result = await evaluate(`(async () => {
      await chrome.storage.local.set({domainCardOrder:{}});
      const container = document.getElementById('openTabsMissions');
      container.style.width = '900px';
      const sample = domainGroups[0].tabs[0];
      domainGroups = Array.from({length:18}, (_,i)=>({domain:'layout-'+i, tabs:Array.from({length:i===0?8:1},(_,j)=>({...sample,url:'https://layout-'+i+'.test/page-'+j,title:'Page '+j}))}));
      container.innerHTML = domainGroups.map(renderDomainCard).join('');
      if (typeof layoutDomainCards === 'function') layoutDomainCards({});
      await new Promise(r=>setTimeout(r,1000));
      const rect = c => {const r=c.getBoundingClientRect(); return {key:c.dataset.groupKey,x:r.x,y:r.y};};
      const before = Array.from(container.querySelectorAll('.domain-card'),rect);
      const first = before[0];
      const target = before.find(c=>c.x>first.x+100 && Math.abs(c.y-first.y)<5);
      if (!target) throw Error('Fixture needs two cards at the tops of different columns: '+JSON.stringify(before));
      let animations=0;
      const listener = e=>{if(e.animationName==='fadeUp') animations++;};
      container.addEventListener('animationstart',listener);
      await updateCardOrder('swap',first.key,target.key);
      await new Promise(r=>setTimeout(r,800));
      const after = Array.from(container.querySelectorAll('.domain-card'),rect);
      container.removeEventListener('animationstart',listener);
      await updateCardOrder('top',first.key);
      const topped = rect(container.querySelector('[data-group-key="'+first.key+'"]'));
      await updateCardOrder('bottom',first.key);
      const bottomed = rect(container.querySelector('[data-group-key="'+first.key+'"]'));
      const snapshot = () => Array.from(container.querySelectorAll('.domain-card-column'), col => Array.from(col.children,c=>c.dataset.groupKey));
      const expected = snapshot();
      const persisted = (await chrome.storage.local.get('domainCardOrder')).domainCardOrder;
      container.innerHTML = domainGroups.map(renderDomainCard).join('');
      layoutDomainCards(persisted);
      const restored = snapshot();
      const waitForColumns = async count => {
        for (let i=0;i<60;i++) {
          if (snapshot().length===count) return;
          await new Promise(r=>setTimeout(r,50));
        }
        throw Error('Resize did not reach '+count+' columns; width='+container.clientWidth);
      };
      container.style.width='280px';
      await waitForColumns(1);
      const narrow = snapshot();
      container.style.width='900px';
      await waitForColumns(3);
      const widened = snapshot();
      return {first,target,after,animations,topped,bottomed,expected,restored,narrow,widened};
    })()`);
    const moved = result.after.find(c=>c.key===result.first.key);
    assert.ok(Math.abs(moved.x-result.target.x)<5 && Math.abs(moved.y-result.target.y)<5, JSON.stringify(result));
    assert.equal(result.animations,0,'Reordering must not replay fadeUp');
    assert.deepEqual(result.restored,result.expected,'Reopening preserves columns');
    assert.equal(result.narrow.length,1);
    assert.equal(result.narrow[0].length,18);
    assert.deepEqual(result.widened,result.expected,'Resizing back preserves columns');
    assert.ok(Math.abs(result.topped.x-result.target.x)<5,'Top must stay in its column: '+JSON.stringify(result));
    assert.ok(Math.abs(result.bottomed.x-result.target.x)<5,'Bottom must stay in its column: '+JSON.stringify(result));
    assert.ok(Math.abs(result.topped.y-result.target.y)<5,'Top must be at the top of its own column');
    assert.equal(result.expected.find(col=>col.includes(result.first.key)).at(-1),result.first.key);
    if (kind !== 'firefox') {
      const shot = await api('Page.captureScreenshot', {format:'png',captureBeyondViewport:true}, session);
      fs.writeFileSync(path.join(out,'card-columns.png'),Buffer.from(shot.data,'base64'));
    }
    await evaluate(`(async()=>{document.getElementById('openTabsMissions').style.width='';await chrome.storage.local.set({domainCardOrder:{}});await renderDashboard();return true;})()`);
  });
  await check('automatic columns fill actual height gaps instead of leaving a trailing card in the longest column', async () => {
    const geometry = await evaluate(`(async()=>{
      const container=document.getElementById('openTabsMissions');container.style.width='900px';
      const sample=domainGroups[0].tabs[0];
      domainGroups=Array.from({length:18},(_,i)=>({domain:'balance-'+String(i).padStart(2,'0'),tabs:Array.from({length:i===0?12:1},(_,j)=>({...sample,url:'https://balance-'+i+'.test/'+j,title:'Page '+j}))}));
      container.innerHTML=domainGroups.map(renderDomainCard).join('');layoutDomainCards({});
      const geometry=()=>({ends:Array.from(container.querySelectorAll('.domain-card-column')).map(c=>c.getBoundingClientRect().bottom),shortCardHeight:container.querySelector('[data-group-key="balance-01"]').getBoundingClientRect().height+12});
      const initial=geometry();
      container.querySelector('[data-group-key="balance-00"] [data-action="expand-chips"]').click();
      const expanded=geometry();
      animateCardOut(container.querySelector('[data-group-key="balance-00"]'));
      await new Promise(resolve=>setTimeout(resolve,400));
      return {initial,expanded,closed:geometry(),remaining:domainGroups.length};
    })()`);
    for (const step of ['initial','expanded','closed']) {
      const value=geometry[step];
      assert.ok(Math.max(...value.ends)-Math.min(...value.ends)<=value.shortCardHeight+2,step+': '+JSON.stringify(value));
    }
    assert.equal(geometry.remaining,17,'Closing a card must remove its group before repacking');
    await evaluate(`(async()=>{document.getElementById('openTabsMissions').style.width='';await chrome.storage.local.set({domainCardOrder:{}});await renderDashboard();return true;})()`);
  });
  await check('legacy stacked top pins prioritize counts and show cancellable pin state', async () => {
    const result = await evaluate(`(async()=>{
      const container=document.getElementById('openTabsMissions');container.style.width='900px';
      const sample=domainGroups[0].tabs[0];
      domainGroups=['falin.top','github.com','example.test'].map(domain=>({domain,tabs:Array.from({length:domain==='github.com'?2:1},(_,i)=>({...sample,url:'https://'+domain+'/page-'+i,title:'Page '+i}))}));
      const old={layouts:{3:{columns:[['example.test'],[],['falin.top','github.com']],top:['falin.top','github.com'],bottom:[],counts:[['example.test',1],['falin.top',1],['github.com',2]]}}};
      const state=reconcileCardOrder(domainGroups,old);await chrome.storage.local.set({domainCardOrder:state});
      container.innerHTML=domainGroups.map(renderDomainCard).join('');layoutDomainCards(state);
      const card=container.querySelector('[data-group-key="github.com"]');
      const rect=card.getBoundingClientRect();const first=container.querySelector('.domain-card').getBoundingClientRect();
      return {deltaY:rect.y-first.y,label:card.querySelector('[data-action="card-top"]').textContent,pressed:card.querySelector('[data-action="card-top"]').getAttribute('aria-pressed')};
    })()`);
    assert.ok(Math.abs(result.deltaY)<5,'GitHub must be in the top row');
    assert.equal(result.pressed,'true');
    await click('[data-group-key="github.com"] [data-action="card-top"]');
    await waitFor(`document.querySelector('[data-group-key="github.com"] [data-action="card-top"]')?.getAttribute('aria-pressed') === 'false'`);
    assert.equal(await evaluate('document.querySelector("#openTabsMissions .domain-card").dataset.groupKey'),'github.com');
    await evaluate(`(async()=>{document.getElementById('openTabsMissions').style.width='';await chrome.storage.local.set({domainCardOrder:{}});await renderDashboard();return true;})()`);
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
  if (process.env.GITHUB_ACTIONS) {
    console.log('::notice title=Browser test report::' + JSON.stringify({browser:kind,version:report.browserVersion,platform:report.platform,extensionVersion:report.extensionVersion,passed:report.checks.length,shortcut:report.shortcut}));
  }
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
