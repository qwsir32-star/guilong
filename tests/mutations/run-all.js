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

/* 摘要行怎么挑 —— 这比看上去重要。

   每份脚本自己打印格式，一共三种收尾：
     · 「全部 N 条变异都被抓住了」/「N 条变异没被抓住」   （weather / theme / …）
     · 「结果：N 条按预期 / M 条没按预期 / K 条没生效。」（language / settingsmodal / …）
     · 「OK  基线：全绿  退出码 0」                      （shortcut / toolbar）
   原来只认 `条变异|没被抓住|基线`。**「基线」这个词太宽**：多数脚本开头都会打一行
   「✅ 基线绿」，于是 filter().pop() 抓到的是**基线那行**，不是结论 ——
   失败时会打成 `✗ ✅ 基线绿`，读起来像「只有基线过了」。
   现在：先找「真正的结论行」（必须提到条数或结果），找不到才退到末行。 */
const verdictOf = (out) => {
  const ls = String(out || '').trim().split('\n').map(s => s.trim()).filter(Boolean);
  const strong = ls.filter(l =>
    /条变异/.test(l) || /条按预期/.test(l) || /^\s*结果：/.test(l) || /守卫都真的在守/.test(l));
  return (strong.length ? strong[strong.length - 1] : (ls[ls.length - 1] || ''));
};

for (const f of files) {
  process.stdout.write(`▶ ${f.padEnd(20)} `);
  // 每份自己会打到 /tmp，互不干扰
  const r = spawnSync(process.execPath, [path.join(DIR, f)], { encoding: 'utf8' });
  const verdict = verdictOf(r.stdout);

  if (r.status === 0) {
    console.log('✓  ' + verdict.slice(0, 70));
  } else {
    console.log('✗  ' + (verdict || String(r.stderr || '').trim() || '(无输出)').slice(0, 70));
    // 挂了就得能查。把末几行原样带出来，省得再单独跑一遍（单跑要一分钟起）。
    const tail = String(r.stdout || '').trim().split('\n').slice(-3)
      .map(s => '        ' + s.trim()).join('\n');
    if (tail.trim()) console.log(tail);
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
