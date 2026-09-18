/**
 * 变异测试：证明 PART 10 的两条守卫真的会红，而不是永远绿。
 *
 *   变异 A —— 把 mac 的 suggested_key 改成用户最初想要的 Command+\
 *              （反斜杠不合法 → 白名单守卫必须变红）
 *   变异 B —— 在 app.js 里塞一个 chrome.commands.update(...) 调用
 *              （Chrome 没这个 API → 「别调不存在的 API」守卫必须变红）
 *              用 if (false) 包住，保证只是静态可见、运行时不会真的执行，
 *              免得沙箱里因为 chrome.commands 不存在而整个崩掉。
 *
 * ⚠️ 2026-09-19 两处返修：
 *   ① **改成操作 /tmp 里的整仓副本**，不再碰真实仓库。老版本直接写
 *      `ROOT/extension/{manifest.json,app.js}` 再还原 —— 一旦中途抛错，
 *      真实仓库就留在改坏的状态里。规则是「绝不碰真实仓库」。
 *      注意要复制整仓（不是只复制 extension/ + tests/），漏了 LICENSE 基线就红。
 *   ② 变异 B 的锚点跟着「跨浏览器」那次重构更新：SHORTCUTS_URL 早已从写死的
 *      chrome:// 地址变成了 envOf().shortcutsUrl。老的锚点 0 次命中，
 *      于是「没改到文件 → 守卫没红」被误读成「守卫失效」。锚点 0 次命中的
 *      「通过」是假的，脚本必须自己把它报出来。
 *
 * 跑法：node tests/mutations/shortcut.js
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..');
const WORK = '/tmp/gl-shortcut-mut-work';
const NODE = process.execPath;
const MF  = path.join(WORK, 'extension/manifest.json');
const APP = path.join(WORK, 'extension/app.js');

// 整仓复制（含 LICENSE / docs / tests），排除 .git 与工作区元数据
execFileSync('bash', ['-c',
  `mkdir -p ${WORK} && rsync -a --exclude '.git' --exclude '.workbuddy' ${SRC}/ ${WORK}/`]);

const mfOrig  = fs.readFileSync(MF,  'utf8');
const appOrig = fs.readFileSync(APP, 'utf8');

let fails = 0, noop = 0;
function say(ok, label, extra) {
  if (!ok) fails++;
  console.log((ok ? '  OK   ' : '  FAIL ') + label + (extra ? '  ' + extra : ''));
}
function skip(label) { noop++; console.log('  ⚠️   锚点没命中，变异没生效：' + label); }

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
  fs.writeFileSync(MF,  mfOrig);
  fs.writeFileSync(APP, appOrig);
}

console.log('\n变异测试 — 快捷键守卫（在 /tmp 副本上做，不碰真实仓库）\n');

const base = runSmoke();
say(base.code === 0, '基线：全绿', '退出码 ' + base.code);

// ── 变异 A：suggested_key 用反斜杠 ───────────────────────────────────────────
{
  const anchor = '"mac": "Command+Shift+K"';
  const mutatedMf = mfOrig.replace(anchor, '"mac": "Command+\\\\"');
  if (mfOrig.indexOf(anchor) === -1 || mutatedMf === mfOrig) skip('变异 A');
  else {
    say(mutatedMf !== mfOrig, '变异 A 确实改到了文件');
    fs.writeFileSync(MF, mutatedMf);
    const a = runSmoke();
    say(a.code !== 0, '变异 A（mac 用反斜杠）→ 守卫变红', '退出码 ' + a.code);
    say(/不认识的键/.test(a.out), '变异 A 红了正确的那一条',
      (/不认识的键.*/.exec(a.out) || [''])[0].slice(0, 70));
  }
  restore();
}

// ── 变异 B：调用 Chrome 没有的 commands.update ────────────────────────────────
{
  // 锚点跟着跨浏览器重构更新：现在是 envOf().shortcutsUrl
  const anchor = 'const SHORTCUTS_URL = envOf().shortcutsUrl;';
  const mutatedApp = appOrig.replace(anchor,
    anchor + "\nif (false) chrome.commands.update({ name: COMMAND_NAME, shortcut: 'Ctrl+K' });");
  if (appOrig.indexOf(anchor) === -1 || mutatedApp === appOrig) skip('变异 B');
  else {
    say(mutatedApp !== appOrig, '变异 B 确实改到了文件');
    fs.writeFileSync(APP, mutatedApp);
    const b = runSmoke();
    say(b.code !== 0, '变异 B（调不存在的 API）→ 守卫变红', '退出码 ' + b.code);
    say(/commands\.update \/ reset/.test(b.out), '变异 B 红了正确的那一条');
  }
  restore();
}

// ── 还原 + 真实仓库没被动过 ──────────────────────────────────────────────────
say(fs.readFileSync(MF,  'utf8') === mfOrig,  'manifest.json 已还原成原样');
say(fs.readFileSync(APP, 'utf8') === appOrig, 'app.js 已还原成原样');
// ⚠️ 别拿 indexOf('commands.update') 判真实仓库 —— app.js 的注释里本来就
//    提了这两个 API 的名字，那样判必然为假。直接和开工时的原文比对。
say(fs.readFileSync(path.join(SRC, 'extension/app.js'), 'utf8') === appOrig,
  '真实仓库的 app.js 一个字节都没动过');
const after = runSmoke();
say(after.code === 0, '还原后：重新全绿', '退出码 ' + after.code);

console.log('\n' + (fails === 0 && noop === 0
  ? '变异测试全部通过（守卫既会红、也会绿）'
  : `${fails} 条不符合预期 / ${noop} 条没生效`));
process.exit(fails === 0 && noop === 0 ? 0 : 1);
