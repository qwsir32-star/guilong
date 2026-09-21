/**
 * 变异测试：空状态三件套的黑名单条目（tests/smoke.js PART 9 的 BANNED）
 *
 * 做法：整仓复制到 /tmp，把 app.js 改回「写死英文」的旧样子，跑 smoke.js，
 * 断言「没有重新写死的英文界面文案」必须变红。全红 = 黑名单有效。
 *
 * 跑法：node tests/mutations/emptystate.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SRC = path.join(__dirname, '..', '..');
const WORK = '/tmp/gl-empty-mut-work-' + process.pid;

function sh(cmd, cwd) {
  try { return { code: 0, out: execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { code: e.status, out: (e.stdout || '') + (e.stderr || '') }; }
}

sh(`mkdir -p ${WORK} && rsync -a --exclude '.git' --exclude '.workbuddy' ${SRC}/ ${WORK}/`);
const APP = path.join(WORK, 'extension', 'app.js');
const PRISTINE = fs.readFileSync(APP, 'utf8');

function runSmoke() {
  const r = sh(JSON.stringify(process.execPath) + ' tests/smoke.js', WORK);
  const fails = (r.out.match(/^\s*FAIL\s+(.+)$/gm) || []).map(s => s.trim());
  return { exit: r.code, fails };
}

// 基线必须绿
const base = runSmoke();
if (base.exit !== 0 || base.fails.length) {
  console.log('❌ 基线就是红的，变异结果不可信：');
  base.fails.forEach(f => console.log('   ' + f));
  process.exit(1);
}
console.log('✅ 基线绿\n');

const fix = `
      <div class="empty-title">\${T('openTabs.emptyTitle')}</div>
      <div class="empty-subtitle">\${T('openTabs.emptySubtitle')}</div>
    </div>
  \`;

  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.textContent = Tn('badge.domain', 'badge.domains', 0);`;

const mutations = [
  {
    name: '标题写回模板字符串（裸 HTML，当年的写法）',
    anchor: "T('openTabs.emptyTitle')",
    apply: s => s.replace(fix, fix
      .replace("${T('openTabs.emptyTitle')}", "Inbox zero, but for tabs.")),
  },
  {
    name: '副标题写回模板字符串',
    anchor: "T('openTabs.emptySubtitle')",
    apply: s => s.replace(fix, fix
      .replace("${T('openTabs.emptySubtitle')}", "You're free.")),
  },
  {
    name: '计数写回 0 domains 字符串字面量',
    anchor: "Tn('badge.domain', 'badge.domains', 0)",
    apply: s => s.replace("countEl.textContent = Tn('badge.domain', 'badge.domains', 0);",
                          "countEl.textContent = '0 domains';"),
  },
  {
    name: '换成一句全新的英文写死（黑名单抓不到没栽过的句子）',
    anchor: "T('openTabs.emptySubtitle')",
    apply: s => s.replace("${T('openTabs.emptySubtitle')}", "All clear."),
    expectMessage: '这一条**应该红不了** —— 它证明黑名单只抓「栽过的句子」，',
  },
];

let red = 0, green = 0, noop = 0;
for (const m of mutations) {
  fs.writeFileSync(APP, PRISTINE);
  if (PRISTINE.indexOf(m.anchor) === -1) { console.log(`⚠️ 锚点没命中：${m.name}`); noop++; continue; }
  const after = m.apply(PRISTINE);
  if (after === PRISTINE) { console.log(`⚠️ 变异没生效：${m.name}`); noop++; continue; }
  fs.writeFileSync(APP, after);

  const r = runSmoke();
  const hit = r.fails.some(f => f.includes('没有重新写死的英文界面文案'));
  if (r.exit !== 0 || r.fails.length) {
    if (hit) { red++;   console.log(`✅ 变红（黑名单抓住了）：${m.name}`); }
    else      { red++;  console.log(`✅ 变红（但不是黑名单那条）：${m.name}`); }
    r.fails.filter(f => f.includes('英文')).slice(0, 2)
      .forEach(f => console.log('      ' + f.replace(/^FAIL\s+/, '')));
  } else {
    green++;
    console.log(`${m.expectMessage ? 'ℹ️  如预期绿着' : '❌ 没抓住'}：${m.name}`);
    if (m.expectMessage) console.log(`      ${m.expectMessage}`);
  }
}
fs.writeFileSync(APP, PRISTINE);

console.log(`\n结果：${red} 红 / ${green} 绿 / ${noop} 没生效。`);
process.exit(green === 1 && noop === 0 ? 0 : 1);
