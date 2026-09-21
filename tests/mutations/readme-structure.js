/**
 * 变异测试：README 结构守卫（tests/smoke.js PART 16）
 *
 * 守的是三件「改坏了本地看不出来」的事：
 *   ① 目录锚点（改标题文字 → 锚点变死链，渲染器不报错）
 *   ② 仓库内链接（文档改名/搬目录 → 404，不报错）
 *   ③ 许可证压轴（规范里唯一强制位置的一条）
 *
 * 做法：整仓复制到 /tmp，逐条把 README 改坏，smoke.js 必须变红。
 *
 * 跑法：node tests/mutations/readme-structure.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SRC = path.join(__dirname, '..', '..');
const WORK = '/tmp/gl-readme-mut-work-' + process.pid;

function sh(cmd, cwd) {
  try { return { code: 0, out: execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { code: e.status, out: (e.stdout || '') + (e.stderr || '') }; }
}

sh(`mkdir -p ${WORK} && rsync -a --exclude '.git' --exclude '.workbuddy' ${SRC}/ ${WORK}/`);

const README = path.join(WORK, 'README.md');
const README_P = fs.readFileSync(README, 'utf8');

// 删掉「## 目录」这一节（标题 + 它的列表），用来验证「README 有目录」这条
function dropToc(s) {
  const out = [];
  let inToc = false;
  for (const line of s.split('\n')) {
    if (/^##\s+目录\s*$/.test(line)) { inToc = true; continue; }
    if (inToc) {
      if (/^\s*-\s*\[.+\]\(#.+\)\s*$/.test(line)) continue;
      // 标题和列表之间那行空行也算目录的一部分 —— 漏了它 inToc 会提前复位，
      // 结果「删掉整个目录」这条变异根本没删掉列表（第一次就踩了）。
      if (line.trim() === '') continue;
      inToc = false;
    }
    out.push(line);
  }
  return out.join('\n');
}

const mutations = [
  {
    // 2026-09-19：README 里删掉了「## 隐私」一节，这里换成「## 常见问题」。
    // ⚠️ 改源码清单（删小节、加文件）时，变异脚本里照写的锚点要跟着看一遍 ——
    //    锚点 0 次命中的「通过」是假的。
    name: '改一个标题文字，目录里的锚点就成了死链',
    anchor: '## 常见问题',
    apply: s => s.replace('## 常见问题', '## 常见疑问'),
  },
  {
    name: '目录里混进了「目录」自己',
    anchor: '- [为什么做这个](#为什么做这个)',
    apply: s => s.replace('- [为什么做这个](#为什么做这个)',
                         '- [目录](#目录)\n- [为什么做这个](#为什么做这个)'),
  },
  {
    name: '内链指向一份不存在的文档（文档改名后忘了改链接）',
    anchor: '](docs/天气.md)',
    apply: s => s.replace('](docs/天气.md)', '](docs/不存在的天气.md)'),
  },
  {
    name: '许可证后面又加了一节（压轴的位置没了）',
    anchor: '## 许可证',
    apply: s => s + '\n## 变更记录\n\n还没写。\n',
  },
  {
    name: '整个目录被删掉',
    anchor: '## 目录',
    apply: dropToc,
  },
  {
    name: '边界：只改正文措辞，不碰结构（本该绿着）',
    anchor: '标签页开着开着就多了',
    apply: s => s.replace('标签页开着开着就多了，然后就开始难受。',
                          '标签页一言不合就堆成山。'),
    expectGreen: true,
  },
];

function restore() { fs.writeFileSync(README, README_P); }
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
  if (README_P.indexOf(m.anchor) === -1) {
    console.log(`⚠️  锚点没命中，变异没生效：${m.name}`); noop++; continue;
  }
  const after = m.apply(README_P);
  if (after === README_P) { console.log(`⚠️  改完没变化，变异没生效：${m.name}`); noop++; continue; }
  fs.writeFileSync(README, after);

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
console.log(`\n结果：${red} 条按预期 / ${green} 条没按预期 / ${noop} 条没生效。`);
process.exit(green === 0 && noop === 0 ? 0 : 1);
