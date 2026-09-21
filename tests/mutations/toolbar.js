/**
 * 变异测试：证明「工具栏图标」那两条守卫真的会红，而不是永远绿。
 *
 *   变异 A —— 把 onClicked 的注册删掉（模拟「图标又是死的」）
 *   变异 B —— 给 action 加一个 default_popup（模拟「点击被 popup 吃掉」）
 *
 * ⚠️ 2026-09-19 返修：原来直接写 `ROOT/extension/{background.js,manifest.json}`
 *    再还原 —— 中途抛错就把真实仓库留在改坏的状态。规则是「绝不碰真实仓库」，
 *    改成先在 /tmp 复制整仓，所有变异都打在副本上。
 *    顺便补上「锚点是否命中 / 改完是否真的变了」两条自检：0 次命中的
 *    「通过」是假的。
 *
 * 跑法：node tests/mutations/toolbar.js
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..');
const WORK = '/tmp/gl-toolbar-mut-work-' + process.pid;
const NODE = process.execPath;
const BG = path.join(WORK, 'extension/background.js');
const MF = path.join(WORK, 'extension/manifest.json');

// 整仓复制（含 LICENSE / docs / tests），排除 .git 与工作区元数据
execFileSync('bash', ['-c',
  `mkdir -p ${WORK} && rsync -a --exclude '.git' --exclude '.workbuddy' ${SRC}/ ${WORK}/`]);

const bgOrig = fs.readFileSync(BG, 'utf8');
const mfOrig = fs.readFileSync(MF, 'utf8');

let fails = 0, noop = 0;
function say(ok, label, extra) {
  if (!ok) fails++;
  console.log((ok ? '  OK   ' : '  FAIL ') + label + (extra ? '  ' + extra : ''));
}
function skip(label) { noop++; console.log('  ⚠️   锚点没命中 / 改完没变化，变异没生效：' + label); }

function runSmoke() {
  try {
    const out = execFileSync(NODE, [path.join(WORK, 'tests/smoke.js')], {
      cwd: WORK, encoding: 'utf8', stdio: 'pipe',
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

function restore() {
  fs.writeFileSync(BG, bgOrig);
  fs.writeFileSync(MF, mfOrig);
}

console.log('\n变异测试 — 工具栏图标守卫（在 /tmp 副本上做，不碰真实仓库）\n');

// ── 基线 ──────────────────────────────────────────────────────────────────────
const base = runSmoke();
say(base.code === 0, '基线：全绿', '退出码 ' + base.code);

// ── 变异 A：删掉 onClicked 注册 ───────────────────────────────────────────────
{
  const anchor = 'chrome.action.onClicked.addListener';
  const mutated = bgOrig.split(anchor).join('chrome.action.onClicked_NOPE.addListener');
  if (bgOrig.indexOf(anchor) === -1 || mutated === bgOrig) skip('变异 A');
  else {
    say(true, '变异 A 确实改到了文件');
    fs.writeFileSync(BG, mutated);
    const a = runSmoke();
    say(a.code !== 0, '变异 A（删掉 onClicked）→ 守卫变红', '退出码 ' + a.code);
    say(/图标的点击有人接/.test(a.out), '变异 A 红了正确的那一条');
  }
  restore();
}

// ── 变异 B：加上 default_popup ───────────────────────────────────────────────
{
  const anchor = '"default_title": "归拢",';
  const mutated = mfOrig.replace(anchor,
    anchor + '\n    "default_popup": "index.html",');
  if (mfOrig.indexOf(anchor) === -1 || mutated === mfOrig) skip('变异 B');
  else {
    say(true, '变异 B 确实改到了文件');
    fs.writeFileSync(MF, mutated);
    const b = runSmoke();
    say(b.code !== 0, '变异 B（加 default_popup）→ 守卫变红', '退出码 ' + b.code);
    say(/default_popup/.test(b.out), '变异 B 红了正确的那一条');
  }
  restore();
}

// ── 还原 + 真实仓库没被动过 ──────────────────────────────────────────────────
say(fs.readFileSync(BG, 'utf8') === bgOrig, 'background.js 已还原成原样');
say(fs.readFileSync(MF, 'utf8') === mfOrig, 'manifest.json 已还原成原样');
say(fs.readFileSync(path.join(SRC, 'extension/background.js'), 'utf8') === bgOrig
  && fs.readFileSync(path.join(SRC, 'extension/manifest.json'), 'utf8') === mfOrig,
  '真实仓库一个字节都没动过');
const after = runSmoke();
say(after.code === 0, '还原后：重新全绿', '退出码 ' + after.code);

console.log('\n' + (fails === 0 && noop === 0
  ? '变异测试全部通过（守卫既会红、也会绿）'
  : `${fails} 条不符合预期 / ${noop} 条没生效`));
process.exit(fails === 0 && noop === 0 ? 0 : 1);
