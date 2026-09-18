/* 「稍后再看 / 归档」的变异测试。
   每条新守卫都要证明它「坏掉时会变红」—— 一条永远不会失败的断言不是守卫，
   只是装饰。做法：把仓库复制到 /tmp 再改，**绝不碰真实仓库**。
   跑法：node tests/mutations/deferred.js */
const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = path.join(__dirname, '..', '..');
const WORK = '/tmp/guilong-deferred-mut';
const NODE = process.execPath;

function copyRepo() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  for (const name of fs.readdirSync(SRC)) {
    if (name === '.git') continue;
    fs.cpSync(path.join(SRC, name), path.join(WORK, name), { recursive: true });
  }
}

function runSmoke() {
  try {
    execFileSync(NODE, ['tests/smoke.js'], { cwd: WORK, stdio: 'pipe' });
    return { code: 0, out: '' };
  } catch (e) {
    return { code: e.status || 1, out: String(e.stdout || '') };
  }
}

const MUTATIONS = [
  /* ---- 一键删除的范围 ---- */
  { n: '一键删除把归档也一起删了', f: 'extension/app.js',
    from: "  const { active } = await getSavedTabs();\n  if (active.length === 0) return 0;\n\n  const { deferred = [] } = await chrome.storage.local.get('deferred');\n  const ids = new Set(active.map(t => t.id));",
    to:   "  const { deferred = [] } = await chrome.storage.local.get('deferred');\n  const ids = new Set(deferred.filter(t => !t.dismissed).map(t => t.id));" },

  { n: '一键删除真把数据抹掉了（不复用 dismissed 标记）', f: 'extension/app.js',
    from: "    if (ids.has(t.id)) { t.dismissed = true; removed += 1; }",
    to:   "    if (ids.has(t.id)) { removed += 1; }" },

  { n: '一键删除返回的条数永远是 0', f: 'extension/app.js',
    from: '    if (ids.has(t.id)) { t.dismissed = true; removed += 1; }',
    to:   '    if (ids.has(t.id)) { t.dismissed = true; }' },

  /* ---- 归档还原 ---- */
  { n: '还原不翻 completed（点了没反应）', f: 'extension/app.js',
    from: '  tab.completed = false;\n  delete tab.completedAt;',
    to:   '  delete tab.completedAt;' },

  { n: '还原留着旧的 completedAt', f: 'extension/app.js',
    from: '  tab.completed = false;\n  delete tab.completedAt;',
    to:   '  tab.completed = false;' },

  { n: '还原把已被删掉的条目也捞回来', f: 'extension/app.js',
    from: '  tab.completed = false;\n  delete tab.completedAt;',
    to:   '  tab.completed = false;\n  tab.dismissed = false;\n  delete tab.completedAt;' },

  { n: '还原不存在的 id 也返回 true', f: 'extension/app.js',
    from: '  if (!tab) return false;', to: '  if (!tab) return true;' },

  /* ---- 两段式确认 ---- */
  { n: '一键删除改成一点就生效（没有确认）', f: 'extension/app.js',
    from: "    const armed = confirmOrArm(\n      actionEl, `${ICONS.close}${T('toast.confirmClearSaved', { n: active.length })}`);\n    if (!armed) return;",
    to:   '    // (变异) 没有确认，直接删' },

  { n: 'confirmOrArm 第一次点就放行（等于没有确认）', f: 'extension/app.js',
    from: "  if (actionEl.dataset.confirming === '1') return true;",
    to:   '  if (true) return true;' },

  { n: 'confirmOrArm 永远不放行（按钮点了没反应）', f: 'extension/app.js',
    from: '  if (actionEl.dataset.confirming === \'1\') return true;',
    to:   '  if (false) return true;' },

  { n: '确认态不再自动复位（一直挂在危险状态上）', f: 'extension/app.js',
    from: "    actionEl.dataset.confirming = '';\n    actionEl.classList.remove('confirming');",
    to:   "    actionEl.dataset.confirming = '';" },

  { n: '复位时不检查按钮还在不在 DOM 上（会覆盖新按钮）', f: 'extension/app.js',
    from: '    if (!actionEl.isConnected) return;\n    actionEl.dataset.confirming = \'\';',
    to:   "    actionEl.dataset.confirming = '';" },

  { n: '确认态的样式改回只认 .close-tabs（新按钮点了没反应）', f: 'extension/style.css',
    from: '.action-btn.confirming {', to: '.action-btn.close-tabs.confirming {' },

  /* ---- 渲染 ---- */
  { n: '归档条目里没有还原按钮了', f: 'extension/app.js',
    from: ' data-action="restore-archived"', to: ' data-action="noop-archived"' },

  { n: '还原按钮挪到删除后面', f: 'extension/app.js',
    from: '      <button class="archive-restore" data-action="restore-archived" data-deferred-id="${item.id}" title="${T(\'archive.restore\')}">',
    to:   '      <button class="archive-restore" data-action="restore-archived-x" data-deferred-id="${item.id}" title="${T(\'archive.restore\')}">' },

  /* ---- 文案 ---- */
  { n: '文案表里少了「确认删除」那条', f: 'extension/strings.js',
    from: "    'toast.confirmClearSaved': '确认删除这 {n} 条？再点一次',\n", to: '' },
];

copyRepo();
const base = runSmoke();
console.log('基线（未变异）：' + (base.code === 0 ? '全绿 ✓' : '红 ✗ 基线就是坏的，后面的结论不可信'));
if (base.code !== 0) { console.log(base.out.split('\n').filter(l => l.includes('FAIL')).join('\n')); process.exit(1); }

let bad = 0;
console.log('');
for (const m of MUTATIONS) {
  copyRepo();
  const p = path.join(WORK, m.f);
  const src = fs.readFileSync(p, 'utf8');
  const hits = src.split(m.from).length - 1;
  if (hits !== 1) {
    console.log(`  ??  ${m.n} —— 锚点出现 ${hits} 次（要求 1 次），这条没测到`);
    bad++;
    continue;
  }
  fs.writeFileSync(p, src.split(m.from).join(m.to));
  const r = runSmoke();
  if (r.code === 0) {
    console.log(`  ✗  ${m.n} —— 改坏了但测试还是全绿，这条守卫是假的`);
    bad++;
  } else {
    const f = r.out.split('\n').filter(l => l.includes('FAIL')).map(l => l.trim().replace(/^FAIL\s+/, '').split('  →')[0]);
    console.log(`  ✓  ${m.n} —— 变红，抓到 ${f.length} 条：${f[0] || ''}`);
  }
}
fs.rmSync(WORK, { recursive: true, force: true });
console.log('\n' + (bad === 0 ? `全部 ${MUTATIONS.length} 条变异都被抓住了` : `${bad} 条变异没被抓住`));
process.exit(bad === 0 ? 0 : 1);
