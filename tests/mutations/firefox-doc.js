/**
 * 变异测试：Firefox「选错 manifest」这条坑的守卫（tests/smoke.js PART 14 末尾）
 *
 * 守卫对象已经从 README 挪到 docs/firefox-安装指南.md —— README 面向用户，
 * 不放「从源码加载」的细节；但坑本身必须留在指南里，不能哪天被顺手删掉。
 *
 * 做法：整仓复制到 /tmp，逐条把指南/README 改坏，跑 smoke.js 断言必须变红。
 *
 * 跑法：node tests/mutations/firefox-doc.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SRC = path.join(__dirname, '..', '..');
const WORK = '/tmp/gl-doc-mut-work-' + process.pid;

function sh(cmd, cwd) {
  try { return { code: 0, out: execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { code: e.status, out: (e.stdout || '') + (e.stderr || '') }; }
}

sh(`mkdir -p ${WORK} && rsync -a --exclude '.git' --exclude '.workbuddy' ${SRC}/ ${WORK}/`);

const README = path.join(WORK, 'README.md');
const GUIDE  = path.join(WORK, 'docs', 'firefox-安装指南.md');
const README_P = fs.readFileSync(README, 'utf8');
const GUIDE_P  = fs.readFileSync(GUIDE, 'utf8');

function restore() {
  fs.writeFileSync(README, README_P);
  fs.writeFileSync(GUIDE, GUIDE_P);
}
function runSmoke() {
  const r = sh(JSON.stringify(process.execPath) + ' tests/smoke.js', WORK);
  return { exit: r.code, fails: (r.out.match(/^\s*FAIL\s+(.+)$/gm) || []).map(s => s.trim()) };
}

// 基线必须绿
const base = runSmoke();
if (base.exit !== 0 || base.fails.length) {
  console.log('❌ 基线就是红的，变异结果不可信：');
  base.fails.forEach(f => console.log('   ' + f));
  process.exit(1);
}
console.log('✅ 基线绿\n');

const mutations = [
  {
    name: '指南里「不要选 extension/manifest.json」那句被删（坑话没了）',
    where: 'GUIDE', anchor: '不要选 `extension/manifest.json`',
    apply: s => s.replace('**选 `dist/firefox/manifest.json`，不要选 `extension/manifest.json`。**',
                          '**选 Firefox 那个包就行。**'),
  },
  {
    name: '指南把 dist/firefox 换成 dist/chrome（指错包）',
    where: 'GUIDE', anchor: 'dist/firefox/manifest.json',
    apply: s => s.replace(/dist\/firefox\/manifest\.json/g, 'dist/chrome/manifest.json'),
  },
  {
    name: '指南删掉「先打包」这一步',
    where: 'GUIDE', anchor: 'node tools/build-store.js',
    apply: s => s.replace('```bash\nnode tools/build-store.js\n```\n', ''),
  },
  {
    name: '指南不再解释原因（整行删掉 service_worker）',
    where: 'GUIDE', anchor: 'background.service_worker',
    apply: s => s.split('\n').filter(l => !l.includes('background.service_worker')).join('\n'),
  },
  {
    name: '整个指南文件被删',
    where: 'GUIDE', deleteFile: true,
  },
  {
    name: 'README 删掉指向指南的链接',
    where: 'README', anchor: 'docs/firefox-安装指南.md',
    apply: s => s.split('\n').filter(l => !l.includes('docs/firefox-安装指南.md')).join('\n'),
  },
  {
    name: '改指南里一句无关的话（边界：不该红）',
    where: 'GUIDE', anchor: '## 前置条件',
    apply: s => s.replace('## 前置条件', '## 开始之前'),
    expectGreen: true,
  },
];

let red = 0, green = 0, noop = 0;
for (const m of mutations) {
  restore();
  if (m.deleteFile) {
    fs.unlinkSync(GUIDE);
  } else {
    const src = m.where === 'GUIDE' ? GUIDE_P : README_P;
    if (m.anchor && src.indexOf(m.anchor) === -1) {
      console.log(`⚠️  锚点没命中，变异没生效：${m.name}`); noop++; continue;
    }
    const after = m.apply(src);
    if (after === src) { console.log(`⚠️  改完没变化，变异没生效：${m.name}`); noop++; continue; }
    fs.writeFileSync(m.where === 'GUIDE' ? GUIDE : README, after);
  }

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
