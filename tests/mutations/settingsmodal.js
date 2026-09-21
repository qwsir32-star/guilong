/**
 * 变异测试：设置面板「居中悬浮的模态」守卫（tests/smoke.js PART 18）
 *
 * 用户原话：「按一下设置按钮之后的逻辑不是让设置面板出现在和页面平行的空间中，
 *           而是类似于一个独立的面板，不改变页面的逻辑，居中悬浮的感觉，页面虚化。」
 *
 * 翻成三条要守的性质：
 *   ① **不改变页面布局** —— 面板必须脱离文档流（<dialog> + showModal()）。
 *      退回「普通 div + 切 class」的话它还在流里，下面的网格会被顶下去。
 *   ② **居中悬浮** —— 位置靠 position:fixed + inset:0 + margin:auto 自己写死。
 *      UA 的模态 dialog 只归零**纵向** inset，横向还停在静态位置（贴左上角）。
 *   ③ **页面虚化** —— backdrop-filter 只能挂 ::backdrop。挂到面板本身上虚化的
 *      是面板自己，观感正好相反，而且**不报错**。
 *   外加两条行为安全：重复 showModal() 会抛 InvalidStateError；开没开读原生
 *   panel.open（Esc 关闭不走点击分支，class 会过期）。
 *
 * 做法：整仓复制到 /tmp，逐条把源码改坏，tests/smoke.js 必须变红。
 * ⚠️ 绝不碰真实仓库。复制整仓（不是只复制 extension/ + tests/），少一份
 *    LICENSE 基线就是红的。
 *
 * 跑法：node tests/mutations/settingsmodal.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SRC = path.join(__dirname, '..', '..');
const WORK = '/tmp/gl-modal-mut-work-' + process.pid;

function sh(cmd, cwd) {
  try { return { code: 0, out: execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { code: e.status, out: (e.stdout || '') + (e.stderr || '') }; }
}

sh(`mkdir -p ${WORK} && rsync -a --delete --exclude '.git' --exclude '.workbuddy' ${SRC}/ ${WORK}/`);

const F = {
  app:  path.join(WORK, 'extension/app.js'),
  html: path.join(WORK, 'extension/index.html'),
  css:  path.join(WORK, 'extension/style.css'),
};
const ORIG = Object.fromEntries(
  Object.entries(F).map(([k, p]) => [k, fs.readFileSync(p, 'utf8')]));

// 一条变异改哪个文件、锚点是什么、怎么改
const mutations = [
  /* ---- ① 脱离文档流：必须是 dialog 的原生开关，不是切 class ---- */
  {
    name: '退回「切 class」（面板回到文档流里，下面的网格会被顶下去）',
    file: 'app', anchor: '    if (!panel.open) panel.showModal();',
    apply: s => s.replace('    if (!panel.open) panel.showModal();',
                          "    panel.classList.add('open');"),
  },
  {
    name: '去掉重复打开保护（再点一下齿轮会抛 InvalidStateError）',
    file: 'app', anchor: '    if (!panel.open) panel.showModal();',
    apply: s => s.replace('    if (!panel.open) panel.showModal();',
                          '    panel.showModal();'),
  },
  {
    name: '关闭不再走原生 close()（面板关不掉）',
    file: 'app',
    anchor: '    if (typeof panel.close === \'function\') panel.close();\n' +
            "    else panel.removeAttribute('open');",
    apply: s => s.replace(
      '    if (typeof panel.close === \'function\') panel.close();\n' +
      "    else panel.removeAttribute('open');", '    void 0;'),
  },
  {
    name: '面板不再是 <dialog>（拿不到 top layer，也没有背板）',
    file: 'html', anchor: '<dialog class="settings-panel" id="settingsPanel">',
    apply: s => s.replace('<dialog class="settings-panel" id="settingsPanel">',
                          '<div class="settings-panel" id="settingsPanel">'),
  },

  /* ---- Esc / 背板关闭后，齿轮状态要同步 ---- */
  {
    name: '不挂 close 事件（Esc 关掉后齿轮还亮着，像坏了）',
    file: 'app',
    anchor: "  panel.addEventListener('close', () => {\n" +
            "    const toggle = document.getElementById('settingsToggle');\n" +
            "    if (toggle) toggle.classList.remove('open');\n" +
            '  });\n',
    apply: s => s.replace(
      "  panel.addEventListener('close', () => {\n" +
      "    const toggle = document.getElementById('settingsToggle');\n" +
      "    if (toggle) toggle.classList.remove('open');\n" +
      '  });\n', ''),
  },
  {
    name: '点背板关闭前不判落点（点面板内边距也会被误关）',
    file: 'app', anchor: 'if (e.target !== panel) return;',
    apply: s => s.replace('if (e.target !== panel) return;', 'if (false) return;'),
  },
  {
    name: '开没开读 class 而不是原生 panel.open（Esc 关过之后按下没反应）',
    file: 'app', anchor: '    if (panel.open) { closeSettingsPanel(); return; }',
    apply: s => s.replace('    if (panel.open) { closeSettingsPanel(); return; }',
      "    if (panel.classList.contains('open')) { closeSettingsPanel(); return; }"),
  },

  /* ---- ② 居中自己写死（UA 只管纵向） ---- */
  {
    name: 'CSS 去掉 position:fixed（面板贴左上角，不像「居中悬浮」）',
    file: 'css', anchor: '.settings-panel {\n  position: fixed;\n  inset: 0;',
    apply: s => s.replace('.settings-panel {\n  position: fixed;\n  inset: 0;',
                          '.settings-panel {\n  inset: 0;'),
  },
  {
    name: 'CSS 给面板写 display（和 dialog 自己的开关状态打架，面板一直杵着）',
    file: 'css', anchor: '.settings-panel {\n  position: fixed;',
    apply: s => s.replace('.settings-panel {\n  position: fixed;',
                          '.settings-panel {\n  display: block;\n  position: fixed;'),
  },

  /* ---- ③ 页面虚化挂在 ::backdrop 上 ---- */
  {
    name: '::backdrop 不再虚化（页面不变糊，只看得出压暗）',
    file: 'css',
    anchor: '.settings-panel::backdrop {\n' +
            '  background: rgb(var(--rgb-ink) / 0.2);\n' +
            '  backdrop-filter: blur(3px);\n}',
    apply: s => s.replace(
      '.settings-panel::backdrop {\n' +
      '  background: rgb(var(--rgb-ink) / 0.2);\n' +
      '  backdrop-filter: blur(3px);\n}',
      '.settings-panel::backdrop {\n' +
      '  background: rgb(var(--rgb-ink) / 0.2);\n}'),
  },
  {
    name: '虚化错挂到面板本身上（虚化的是面板自己，观感正好相反）',
    file: 'css', anchor: '.settings-panel {\n  position: fixed;',
    apply: s => s.replace('.settings-panel {\n  position: fixed;',
                          '.settings-panel {\n  backdrop-filter: blur(3px);\n  position: fixed;'),
  },

  /* ---- 关闭按钮 ---- */
  {
    name: '关闭按钮的 data-action 改错（× 点了没反应）',
    file: 'html', anchor: 'data-action="close-settings"',
    apply: s => s.replace('data-action="close-settings"', 'data-action="dismiss-settings"'),
  },

  /* ---- 边界：不该管的别管 ---- */
  {
    name: '边界：虚化强度从 3px 调到 6px（守卫不该锁死数值）',
    file: 'css', anchor: '  backdrop-filter: blur(3px);',
    apply: s => s.replace('  backdrop-filter: blur(3px);', '  backdrop-filter: blur(6px);'),
    expectGreen: true,
  },
  {
    name: '边界：× 图标的路径改个形状（守卫不该管图标长什么样）',
    file: 'html', anchor: 'd="M4.5 4.5l7 7M11.5 4.5l-7 7"',
    apply: s => s.replace('d="M4.5 4.5l7 7M11.5 4.5l-7 7"', 'd="M3 3l10 10M13 3L3 13"'),
    expectGreen: true,
  },
];

function restore() {
  for (const [k, p] of Object.entries(F)) fs.writeFileSync(p, ORIG[k]);
}
function runSmoke() {
  const r = sh(JSON.stringify(process.execPath) + ' tests/smoke.js', WORK);
  return { exit: r.code, fails: (r.out.match(/^\s*FAIL\s+(.+)$/gm) || []).map(s => s.trim()) };
}

const base = runSmoke();
if (base.exit !== 0 || base.fails.length) {
  console.log('❌ 基线就是红的，变异结果不可信：');
  base.fails.forEach(f => console.log('   ' + f));
  process.exit(1);
}
console.log('✅ 基线绿\n');

let red = 0, green = 0, noop = 0;
for (const m of mutations) {
  restore();
  const src = ORIG[m.file];
  // ① 锚点必须唯一 —— 0 次命中说明变异没生效，「通过」是假的
  const hits = src.split(m.anchor).length - 1;
  if (hits === 0) { console.log(`⚠️  锚点没命中，变异没生效：${m.name}`); noop++; continue; }
  if (hits > 1)  { console.log(`⚠️  锚点出现 ${hits} 次（不唯一，可能改错地方）：${m.name}`); noop++; continue; }
  const after = m.apply(src);
  // ② 确认变异真的改坏了东西 —— 只改注释的变异绿着是变异没生效
  if (after === src) { console.log(`⚠️  改完没变化，变异没生效：${m.name}`); noop++; continue; }
  fs.writeFileSync(F[m.file], after);

  const r = runSmoke();
  const isRed = r.exit !== 0 || r.fails.length > 0;
  if (m.expectGreen) {
    if (isRed) { green++; console.log(`❌ 意外变红（本该绿）：${m.name}`); }
    else { red++; console.log(`✅ 如预期绿着：${m.name}`); }
  } else if (isRed) {
    red++;
    console.log(`✅ 变红（守住了）：${m.name}`);
    r.fails.slice(0, 2).forEach(f => console.log('      ' + f.replace(/^FAIL\s+/, '')));
  } else {
    green++;
    console.log(`❌ 还是绿的，这条守卫是装饰：${m.name}`);
  }
}
restore();

/* ---- 最后确认真实仓库一个字节都没动过 ---- */
// ⚠️ 不能对整块输出 .trim() —— 会吃掉**第一行**开头那个状态空格，
//    于是第一行按 3 字符切完就成了 "xtension/app.js"（假报警）。
const dirty = sh(`git -C ${SRC} status --porcelain`, SRC).out.split('\n')
  .map(l => l.replace(/\s+$/, ''))
  .filter(Boolean)
  .filter(l => !l.startsWith('??'))
  .map(l => l.replace(/^[\s?!MADRCU]{2}\s/, ''));
const expected = ['extension/app.js', 'extension/index.html', 'extension/manifest.json',
                  'extension/strings.js', 'extension/style.css', 'tests/smoke.js'];
const unexpected = dirty.filter(f => !expected.includes(f));
if (unexpected.length) {
  console.log(`\n❌ 真实仓库被动过（不该）：${unexpected.join(', ')}`);
  process.exit(1);
}
console.log('\n（真实仓库一个字节都没动过 ✅）');
console.log(`\n结果：${red} 条按预期 / ${green} 条没按预期 / ${noop} 条没生效。`);
process.exit(green === 0 && noop === 0 ? 0 : 1);
