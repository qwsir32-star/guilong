/**
 * 变异测试：故意破坏，确认守卫会变红。
 * 两处都是本轮新加/刚修的覆盖面，必须证明它们不是摆设。
 *
 * ⚠️ 2026-09-19 返修：原来直接写 `ROOT/extension/{icon32.png,background.js}`
 *    再还原 —— 中途抛错就把真实仓库留在改坏的状态。规则是「绝不碰真实仓库」，
 *    改成先在 /tmp 复制整仓，所有变异都打在副本上。
 *    顺便：resvg 自己解析出路径（GL_RESVG → 仓库 node_modules → 托管工作区），
 *    不再依赖调用方先设 NODE_PATH，也不把用户名写死。
 *
 * 跑法：node tests/mutations/guard.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = path.join(__dirname, '..', '..');
const WORK = '/tmp/gl-guard-mut-work';
const NODE = process.execPath;
// resvg **不在本仓库里**（归拢是零构建的，不装依赖），所以这里得自己找。
// GL_RESVG 优先；否则按两个常见位置猜 —— 别把用户名写死（用 homedir() 拼），
// 换台机器、换个用户名都还能用。
const RESVG = process.env.GL_RESVG || [
  path.join(__dirname, '..', '..', 'node_modules', '@resvg', 'resvg-js'),
  path.join(os.homedir(), '.workbuddy', 'binaries', 'node',
            'workspace', 'node_modules', '@resvg', 'resvg-js'),
].find(p => fs.existsSync(p)) || '';

if (!RESVG) {
  console.error('找不到 @resvg/resvg-js。用 GL_RESVG=/path/to/@resvg/resvg-js 指过来，');
  console.error('或者 cd tools && npm i（重出图标才需要它）。');
  process.exit(1);
}

// 整仓复制（含 LICENSE / docs / tests），排除 .git 与工作区元数据
execFileSync('bash', ['-c',
  `mkdir -p ${WORK} && rsync -a --exclude '.git' --exclude '.workbuddy' ${SRC}/ ${WORK}/`]);

function runSmoke() {
  try {
    return execFileSync(NODE, [path.join(WORK, 'tests/smoke.js')], { cwd: WORK, encoding: 'utf8' });
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '');
  }
}

function expectRed(label, assertionFragment) {
  const out = runSmoke();
  const lines = out.split('\n');
  const failLine = lines.find(l => l.includes('FAIL') && l.includes(assertionFragment));
  const passLine = lines.find(l => l.includes('PASS') && l.includes(assertionFragment));
  if (failLine) {
    console.log(`OK    破坏「${label}」→ 守卫变红（${assertionFragment}）`);
    return true;
  }
  if (passLine) {
    console.log(`BAD   破坏「${label}」→ 守卫仍然 PASS，覆盖不了！`);
    return false;
  }
  console.log(`BAD   破坏「${label}」→ 没找到那条断言，测试可能整体崩了`);
  return false;
}

function expectGreen(label) {
  const out = runSmoke();
  const ok = out.includes('全部通过');
  console.log(`${ok ? 'OK   ' : 'BAD  '} 还原后（${label}）${ok ? '恢复全绿' : '仍然不是全绿'}`);
  return ok;
}

let allOk = true;

/* ---- 变异一：把一张 PNG 换成尺寸不符的，图标守卫必须发现 ---- */
const icon32 = path.join(WORK, 'extension/icons/icon32.png');
const icon32Backup = fs.readFileSync(icon32);
try {
  const { Resvg } = require(RESVG);
  const wrong = new Resvg(fs.readFileSync(path.join(WORK, 'extension/icons/icon.svg'), 'utf8'),
    { fitTo: { mode: 'width', value: 100 } }).render().asPng();   // 100 而不是 32
  fs.writeFileSync(icon32, wrong);
  allOk = expectRed('icon32.png 尺寸改成 100', '尺寸对得上') && allOk;
} finally {
  fs.writeFileSync(icon32, icon32Backup);
}

/* ---- 变异二：往 background.js 里塞回旧品牌名，品牌守卫必须发现 ---- */
const bg = path.join(WORK, 'extension/background.js');
const bgBackup = fs.readFileSync(bg);
try {
  fs.writeFileSync(bg, bgBackup.toString('utf8') + '\n// legacy name check: Tab Out\n');
  allOk = expectRed('background.js 里塞回 Tab Out', '残留旧品牌名') && allOk;
} finally {
  fs.writeFileSync(bg, bgBackup);
}

allOk = expectGreen('两处变异都还原') && allOk;

// 真实仓库必须一个字节都没动过
const repoUntouched =
  fs.readFileSync(path.join(SRC, 'extension/background.js'), 'utf8') === bgBackup.toString('utf8')
  && Buffer.compare(fs.readFileSync(path.join(SRC, 'extension/icons/icon32.png')), icon32Backup) === 0;
allOk = repoUntouched && allOk;
console.log(`${repoUntouched ? 'OK   ' : 'BAD  '} 真实仓库一个字节都没动过`);

console.log('\n' + (allOk ? '两条守卫都真的在守。' : '有守卫没守住，别提交。'));
process.exit(allOk ? 0 : 1);
