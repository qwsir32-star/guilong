/* =====================================================================
   一次跑完 tests/mutations/ 下所有变异脚本。

   每个变异脚本自己会：
     1. 整仓复制到 /tmp（绝不碰真实仓库）
     2. 先验证基线是绿的（否则后面「变红」说明不了任何事）
     3. 逐条改坏源码，要求 tests/smoke.js 变红
   所以这里只负责挨个跑、汇总，任一失败就以非零退出。

   跑法：node tests/mutations/run-all.js
   （单个跑也行：node tests/mutations/weather.js）
   ===================================================================== */
const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR   = __dirname;
const SELF  = path.basename(__filename);
const files = fs.readdirSync(DIR)
  .filter(f => f.endsWith('.js') && f !== SELF)
  .sort();

if (files.length === 0) {
  console.log('tests/mutations/ 里没有变异脚本');
  process.exit(1);
}

console.log(`跑 ${files.length} 份变异脚本…\n`);
const failed = [];

for (const f of files) {
  process.stdout.write(`▶ ${f.padEnd(20)} `);
  // 每份自己会打到 /tmp，互不干扰
  const r = spawnSync(process.execPath, [path.join(DIR, f)], { encoding: 'utf8' });
  const lines = String(r.stdout || '').trim().split('\n');
  const verdict = lines.filter(l => /条变异|没被抓住|基线/.test(l)).pop() || lines.pop() || '';

  if (r.status === 0) {
    console.log('✓  ' + verdict.trim().slice(0, 70));
  } else {
    console.log('✗  ' + (verdict.trim() || String(r.stderr || '').trim()).slice(0, 70));
    failed.push(f);
  }
}

console.log('');
console.log(`${files.length - failed.length}/${files.length} 通过`);
if (failed.length) {
  console.log('未通过：' + failed.join(', '));
  console.log('（`基线` 那行也要看 —— 基线是红的说明那份脚本的断言本来就坏，结论不可信）');
}
// ⚠️ 有失败必须以非零退出。写成「永远 0」就等于一条永远不会失败的守卫 ——
// 而这批脚本存在的全部意义就是「坏掉时必须变红」。
process.exit(failed.length ? 1 : 0);
