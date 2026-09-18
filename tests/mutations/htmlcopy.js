/**
 * 变异测试：PART 19 —— index.html 里不许写死界面文案
 *
 * 守的是一个**真实漏过的洞**：2026-09-19 用全新 profile 跑 Chrome（en-US 系统）
 * 发现页脚那条指向仓库的链接文字是硬编码的「归拢」—— 切英文后 document.title
 * 变成 Guilong，页脚还写着「归拢」。
 * 根因是 PART 9 那条「没有绕开文案表写死的中文文案」只扫了 app.js。
 *
 * 做法：整仓复制到 /tmp，逐条改坏，tests/smoke.js 必须变红。
 * ⚠️ 绝不碰真实仓库。
 *
 * 跑法：node tests/mutations/htmlcopy.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SRC = path.join(__dirname, '..', '..');
const WORK = '/tmp/gl-htmlcopy-work';

function sh(cmd, cwd) {
  try { return { code: 0, out: execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { code: e.status, out: (e.stdout || '') + (e.stderr || '') }; }
}

sh(`mkdir -p ${WORK} && rsync -a --delete --exclude '.git' --exclude '.workbuddy' --exclude 'dist' ${SRC}/ ${WORK}/`);

const F = {
  html:    path.join(WORK, 'extension/index.html'),
  strings: path.join(WORK, 'extension/strings.js'),
};
const ORIG = Object.fromEntries(
  Object.entries(F).map(([k, p]) => [k, fs.readFileSync(p, 'utf8')]));

const FOOT_LINK = 'data-page-node-id="aZOt6LDjPo72lqCVl6KCza" data-i18n="footer.brand"></a>';

const mutations = [
  {
    name: '页脚链接的文字改回硬编码「归拢」（就是漏过的那个 bug）',
    file: 'html', anchor: FOOT_LINK,
    apply: s => s.replace(FOOT_LINK, 'data-page-node-id="aZOt6LDjPo72lqCVl6KCza">归拢</a>'),
  },
  {
    name: '页脚链接被指向别处（不再指向仓库）',
    file: 'html', anchor: 'href="https://github.com/qwsir32-star/guilong"',
    apply: s => s.replace('href="https://github.com/qwsir32-star/guilong"', 'href="https://example.com"'),
  },
  {
    name: '正文里塞一句写死的中文（证明扫的是整页、不只是页脚）',
    file: 'html', anchor: '</footer>',
    apply: s => s.replace('</footer>', '<span>确定</span></footer>'),
  },
  {
    name: '页脚的 key 打错（HTML 引了一个表里没有的 key）',
    file: 'html', anchor: 'data-i18n="footer.brand"',
    apply: s => s.replace('data-i18n="footer.brand"', 'data-i18n="footer.brandX"'),
  },
  {
    name: '英文表里漏了 footer.brand',
    file: 'strings', anchor: "    'footer.brand':           'Guilong',\n",
    apply: s => s.replace("    'footer.brand':           'Guilong',\n", ''),
  },
  {
    name: '边界：多加一段中文 HTML 注释（注释不该被算成漏网）',
    file: 'html', anchor: '</footer>',
    apply: s => s.replace('</footer>', '<!-- 这里是给未来的自己看的说明 --></footer>'),
    expectGreen: true,
  },
  {
    name: '边界：静态 <title> 换成别的中文（它是启动前的默认值，允许写死）',
    file: 'html', anchor: '<title>归拢</title>',
    apply: s => s.replace('<title>归拢</title>', '<title>归拢 · 新标签页</title>'),
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
  const hits = src.split(m.anchor).length - 1;
  if (hits === 0) { console.log(`⚠️  锚点没命中，变异没生效：${m.name}`); noop++; continue; }
  if (hits > 1)  { console.log(`⚠️  锚点出现 ${hits} 次（不唯一）：${m.name}`); noop++; continue; }
  const after = m.apply(src);
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

// ⚠️ 不能对整块输出 .trim() —— 会吃掉第一行开头的状态空格，切路径就少一位
const dirty = sh(`git -C ${SRC} status --porcelain`, SRC).out.split('\n')
  .map(l => l.replace(/\s+$/, '')).filter(Boolean)
  .filter(l => !l.startsWith('??'))
  .map(l => l.replace(/^[\s?!MADRCU]{2}\s/, ''));
const allowed = ['extension/app.js', 'extension/index.html', 'extension/manifest.json',
                 'extension/strings.js', 'extension/style.css', 'tests/smoke.js',
                 'tools/build-store.js'];
const unexpected = dirty.filter(f => !allowed.includes(f));
if (unexpected.length) {
  console.log(`\n❌ 真实仓库里有计划外的改动：${unexpected.join(', ')}`);
  process.exit(1);
}
console.log('\n（真实仓库只动了本次工作本身的文件 ✅）');
console.log(`\n结果：${red} 条按预期 / ${green} 条没按预期 / ${noop} 条没生效。`);
process.exit(green === 0 && noop === 0 ? 0 : 1);
