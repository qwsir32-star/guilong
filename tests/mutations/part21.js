/**
 * PART 21「测试文件自己的一致性」的变异测试。
 *
 * 规矩（本仓库铁律）：
 *   1. 整仓副本放进临时目录再改 —— 绝不碰真实仓库。
 *   2. **一条永远不会失败的断言不是守卫，只是装饰。** 每个变异都必须变红。
 *   3. 光看「红了」不够：要确认它是**红在对的那条断言**上。锚点打歪了、
 *      不小心把文件改成了语法错误，同样会红 —— 那是假红。
 *   4. 阴性对照：有一处改动**不该**变红，它得真的绿着。否则说明判据太粗，
 *      什么改动都报警，等于没有判据。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const REPO = '/Users/qwsir/WorkBuddy/拿来主义ai项目/guilong';
const SMOKE_REL = path.join('tests', 'smoke.js');

/* ---- 整仓副本 ----
   ⚠️ **整个仓库都复制**（只跳过 .git），别挑着复制。冒烟测试会读 LICENSE
   （校验上游署名）、AGENTS.md、README.md、docs/、store/ —— 少一样基线就是红的，
   然后你会以为是守卫在守，其实守的是「文件没复制全」。
   （踩过两次：第一次漏 LICENSE，第二次漏 AGENTS.md。） */
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-p21-'));
for (const name of fs.readdirSync(REPO)) {
  if (name === '.git') continue;
  fs.cpSync(path.join(REPO, name), path.join(work, name), { recursive: true });
}
console.log(`副本：${work}\n`);

const smokePath = path.join(work, SMOKE_REL);
const ORIGINAL = fs.readFileSync(smokePath, 'utf8');

/** 跑一次 smoke，返回 { code, fails: [失败标签] } */
function runSmoke() {
  const r = spawnSync(process.execPath, [smokePath], { cwd: work, encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  // 语法错误会让 smoke 一行 PASS/FAIL 都不打出来 —— 那种红是假红
  const fails = out.split('\n').filter(l => l.includes('FAIL')).map(l => l.trim());
  const sawAny = /PASS|FAIL/.test(out);
  return { code: r.status, fails, sawAny, out };
}

let bad = 0;
const verdict = (ok, name, extra = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? '  —— ' + extra : ''}`);
  if (!ok) bad++;
};

/* ---- 0. 基线必须绿 ---- */
fs.writeFileSync(smokePath, ORIGINAL);
{
  const { code, fails } = runSmoke();
  verdict(code === 0 && fails.length === 0, '基线：绿',
    `exit=${code} 失败 ${fails.length} 条`);
}

/* ---- 变异：每条 = 一处改动 + 期望红在哪 ---- */
const M = [];
const mut = (name, from, to, expect) => M.push({ name, from, to, expect });

/* 1. 把目录注释里 PART 10 那行改回旧标题（就是这次修掉的漂移） */
mut('目录标题漂回「版式静态守卫」',
  ' *   PART 10 呼出快捷键（命令名 / 跳转地址 / manifest 声明）',
  ' *   PART 10 版式静态守卫（页头网格 / 天气条位置 / 设置面板结构）',
  '没有漂移的标题');

/* 2. 正文标题改回全角括号 */
mut('PART 8 标题改回全角括号',
  "console.log('\\n[PART 8] 页头三栏：每个孩子都必须显式指定栏位');",
  "console.log('\\n【PART 8】页头三栏：每个孩子都必须显式指定栏位');",
  '一律用半角');

/* 3. 编号跳号（21 → 22，中间空一个） */
mut('分区编号跳号',
  "console.log('\\n[PART 21] 测试文件自己的一致性（分区编号 / 标题格式 / 目录注释）');",
  "console.log('\\n[PART 22] 测试文件自己的一致性（分区编号 / 标题格式 / 目录注释）');",
  '连续');

/* 4. 目录注释漏掉一行（多一行也一样会红，判据是集合相等） */
mut('目录注释漏掉 PART 21 那行',
  ' *   PART 21 测试文件自己的一致性（分区编号 / 标题格式 / 目录注释不许漂移）\n',
  '',
  '集合');

/* 5. 目录标题和正文标题说的不是同一件事（判据本身的正面检验） */
mut('目录标题换成本节无关的事',
  ' *   PART 12 主题色（解析 / 落 <html> / localStorage 镜像 / 主题块只写三元组）',
  ' *   PART 12 隔壁老王的天气插件（随便写点什么都行）',
  '没有漂移的标题');

/* 6. 反向：改**正文**标题，目录没跟着改，也得红 */
mut('正文标题改了、目录没跟',
  "console.log('\\n[PART 16] README 结构（目录锚点 / 无死链 / 许可证压轴）');",
  "console.log('\\n[PART 16] 隔壁老王的天气插件');",
  '没有漂移的标题');

for (const m of M) {
  const hits = ORIGINAL.split(m.from).length - 1;
  if (hits !== 1) { verdict(false, `变异 ${m.name}`, `锚点命中 ${hits} 次（要求 1 次），跳过`); continue; }

  fs.writeFileSync(smokePath, ORIGINAL.replace(m.from, () => m.to));
  const { code, fails, sawAny } = runSmoke();
  const hitRight = fails.some(l => l.includes(m.expect));
  const detail = `exit=${code}，红在 ${fails.length} 条上` +
    (hitRight ? '' : `（但没红在含「${m.expect}」的那条 —— 假红）`);
  verdict(code !== 0 && sawAny && hitRight, `变异：${m.name}`, detail);
}

/* ---- 阴性对照：改一处**不影响**「同一件事」判据的目录文字，必须仍然绿 ---- */
{
  const from = ' *   PART 17 界面语言（中英切换 / 默认跟随系统 / 标题走文案表）';
  const to   = ' *   PART 17 界面语言（中英切换 / 默认跟随系统 / 标题走文案表，另含回退顺序）';
  const hits = ORIGINAL.split(from).length - 1;
  if (hits !== 1) {
    verdict(false, '阴性对照', `锚点命中 ${hits} 次（要求 1 次）`);
  } else {
    fs.writeFileSync(smokePath, ORIGINAL.replace(from, () => to));
    const { code, fails } = runSmoke();
    verdict(code === 0 && fails.length === 0, '阴性对照：目录行补充说明后**不该**报漂移',
      `exit=${code}，失败 ${fails.length} 条`);
  }
}

/* ---- 真实仓库一个字都不能动 ---- */
{
  const real = fs.readFileSync(path.join(REPO, SMOKE_REL), 'utf8');
  verdict(real === ORIGINAL, '真实仓库的 tests/smoke.js 未被改动');
}

console.log(`\n${bad === 0 ? '全绿：PART 21 真在守' : `${bad} 条不对`}`);
console.log(`（副本留在 ${work}，要清理自己删）`);
process.exit(bad === 0 ? 0 : 1);
