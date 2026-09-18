/* 「字体自托管 / 零网络请求」的变异测试。
   每条新守卫都要证明它「坏掉时会变红」—— 一条永远不会失败的断言不是守卫，
   只是装饰。做法：把仓库复制到 /tmp 再改，**绝不碰真实仓库**。
   跑法：node tests/mutations/fonts.js */
const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = path.join(__dirname, '..', '..');
const WORK = '/tmp/guilong-fonts-mut';
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

const BODY_STACK = "body {\n  font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei UI', 'Microsoft YaHei', sans-serif;";

/* pairs = 文本替换（锚点必须唯一）；rm = 删文件 */
const MUTATIONS = [
  { n: '把 Google Fonts 那条外链加回 index.html',
    pairs: [['extension/index.html',
      '<link rel="stylesheet" href="fonts/fonts.css">',
      '<link href="https://fonts.googleapis.com/css2?family=DM+Sans" rel="stylesheet">']] },

  { n: '把 fonts.css 的 <link> 删了（字体静默掉回系统字体）',
    pairs: [['extension/index.html', '<link rel="stylesheet" href="fonts/fonts.css">\n\n', '']] },

  { n: 'fonts.css 里某条 src 又改成外链',
    pairs: [['extension/fonts/fonts.css',
      "src: url('dm-sans-normal-latin.woff2')",
      "src: url('https://fonts.gstatic.com/s/dmsans/x.woff2')"]] },

  { n: 'fonts.css 里指着一个不存在的文件',
    pairs: [['extension/fonts/fonts.css',
      "src: url('newsreader-normal-latin.woff2')",
      "src: url('newsreader-normal-latin-TYPO.woff2')"]] },

  { n: '删掉一张 woff2（少一张只会静默掉回系统字体）',
    rm: ['extension/fonts/newsreader-italic-latin.woff2'] },

  { n: '把一张 woff2 换成垃圾（不是真字体）',
    rm: ['extension/fonts/dm-sans-normal-latin.woff2'],
    write: [['extension/fonts/dm-sans-normal-latin.woff2', 'not a font at all']] },

  { n: '正文那条栈把中文字体删了（汉字掉回默认字体）',
    pairs: [['extension/style.css', BODY_STACK, "body {\n  font-family: 'DM Sans', sans-serif;"]] },

  { n: '正文用苹方、标题用宋体（两个系统又不一样了）',
    pairs: [['extension/style.css', BODY_STACK,
      "body {\n  font-family: 'DM Sans', 'Songti SC', 'SimSun', sans-serif;"]] },

  { n: '正文那条栈漏掉 Windows 的雅黑',
    pairs: [['extension/style.css', BODY_STACK,
      "body {\n  font-family: 'DM Sans', 'PingFang SC', 'Hiragino Sans GB', sans-serif;"]] },
];

copyRepo();
const base = runSmoke();
console.log('基线（未变异）：' + (base.code === 0 ? '全绿 ✓' : '红 ✗ 基线就是坏的，后面的结论不可信'));
if (base.code !== 0) {
  console.log(base.out.split('\n').filter(l => l.includes('FAIL')).join('\n'));
  process.exit(1);
}

let bad = 0;
console.log('');
for (const m of MUTATIONS) {
  copyRepo();
  let skipped = false;

  for (const [f, from, to] of (m.pairs || [])) {
    const p   = path.join(WORK, f);
    const src = fs.readFileSync(p, 'utf8');
    const hits = src.split(from).length - 1;
    if (hits !== 1) {
      console.log(`  ??  ${m.n} —— 「${from.slice(0, 40)}…」出现 ${hits} 次（要求 1 次），这条没测到`);
      bad++; skipped = true; break;
    }
    fs.writeFileSync(p, src.split(from).join(to));
  }
  if (skipped) continue;

  for (const f of (m.rm || [])) fs.rmSync(path.join(WORK, f), { force: true });
  for (const [f, content] of (m.write || [])) fs.writeFileSync(path.join(WORK, f), content);

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
