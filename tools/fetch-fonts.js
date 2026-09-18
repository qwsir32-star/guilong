/**
 * fetch-fonts.js — 把界面字体下载进扩展里，改成自托管
 *
 * 跑法：node tools/fetch-fonts.js
 * 产物：extension/fonts/*.woff2 + extension/fonts/fonts.css
 *
 * 为什么要有它：
 *   原来 index.html 里挂着一条 <link href="https://fonts.googleapis.com/...">，
 *   每次开新标签页都往 Google 发一次请求。三个后果：
 *     ① README 和 PRIVACY.md 都写着「唯一的对外请求是天气」—— 声明是错的；
 *     ② 国内打不开时，Mac 回退苹方、**Windows 回退微软雅黑 / 宋体** ——
 *        同一个扩展在两个系统上长得不一样；
 *     ③ 商店审核员点开页面看到请求 Google 会问。
 *   自托管之后：零网络请求、离线可用、两个系统完全一致。
 *
 * ⚠️ 只有 latin 和 latin-ext 两个子集进了包（中文本来就不在这两个字体里）。
 *    中文走 style.css 里的系统字体栈（苹方 / 微软雅黑），别指望这两个字体
 *    能显示汉字 —— 想让中文也一致就得包一个 10MB+ 的中文字体，不值得。
 *
 * 只在「换字体」或「补字重」时才需要跑。平时加载扩展不需要任何构建。
 */

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIR  = path.join(ROOT, 'extension', 'fonts');

/* 字重按**区间**请求（300..600），Google 才会给回可变字体的一张 woff2
   —— 一个个列（300;400;500;600）会给回同一张文件配四份 @font-face，白白重复。

   ⚠️ Newsreader **故意不带 `opsz` 轴**：带上它是 450 KB，不带 217 KB ——
   多出来的 287 KB 买的是「不同字号下笔画粗细自动微调」，在一个仪表盘上
   根本看不出来。斜体必须留（style.css 里有 5 处 font-style: italic）。 */
const FAMILIES = [
  'DM+Sans:wght@300..600',
  'Newsreader:ital,wght@0,300..600;1,300..600',
];

/* 只要这两个子集。cyrillic / greek / vietnamese 界面上一个字都用不到，
   带进来只是白增体积。 */
const KEEP_SUBSETS = new Set(['latin', 'latin-ext']);

/* 带一个 Chrome 的 UA，Google 才给 woff2；给 curl 的默认 UA 会拿回 ttf。 */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
         + '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

let failed = 0;
function check(label, cond, detail) {
  if (cond) { console.log('  ✓  ' + label); return; }
  failed++;
  console.log('  ✗  ' + label + (detail ? `  → ${detail}` : ''));
}

function curl(args) {
  return execFileSync('curl', ['-sS', '--max-time', '30', '-A', UA, ...args]);
}

/* ─── 1. 拿 CSS ─────────────────────────────────────────────────────────── */

const cssUrl = 'https://fonts.googleapis.com/css2?'
  + FAMILIES.map(f => 'family=' + f).join('&')
  + '&display=swap';

console.log('向 Google Fonts 要 CSS…');
const css = curl([cssUrl]).toString();
check('拿到了 CSS', css.includes('@font-face'), css.slice(0, 200));
if (!css.includes('@font-face')) process.exit(1);

/* ─── 2. 切出每个 @font-face，只留要的子集 ───────────────────────────────── */

// 注释 /* latin */ 就在 @font-face 前面，用它认子集
const blocks = [];
const re = /\/\*\s*([a-z-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g;
let m;
while ((m = re.exec(css)) !== null) {
  const subset = m[1];
  const body   = m[2];
  if (!KEEP_SUBSETS.has(subset)) continue;

  const get = k => (body.match(new RegExp(k + ':\\s*([^;]+);')) || [])[1] || '';
  blocks.push({
    subset,
    family: get('font-family').replace(/['"]/g, '').trim(),
    style:  get('font-style').trim()   || 'normal',
    weight: get('font-weight').trim(),
    url:    (body.match(/url\(([^)]+)\)/) || [])[1],
    range:  get('unicode-range').trim(),
  });
}

check('解析出了 @font-face', blocks.length > 0, `${blocks.length} 条`);
console.log(`  留了 ${blocks.length} 条（子集：${[...KEEP_SUBSETS].join(' / ')}）`);

const missing = blocks.filter(b => !b.url || !b.family);
check('每条的字体名与地址都在', missing.length === 0, JSON.stringify(missing[0] || {}));
if (missing.length) process.exit(1);

/* ─── 3. 去重：同一张文件可能被好几条 @font-face 指着 ─────────────────────── */

const byUrl = new Map();
for (const b of blocks) {
  if (!byUrl.has(b.url)) byUrl.set(b.url, { ...b, usedBy: [] });
  byUrl.get(b.url).usedBy.push(`${b.family} ${b.style} ${b.weight} ${b.subset}`);
}

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

console.log(`\n下载 ${byUrl.size} 张 woff2 → extension/fonts/`);
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

const nameOf = new Map();
let n = 0;
for (const [url, b] of byUrl) {
  n += 1;
  const name = `${slug(b.family)}-${b.style}-${b.subset}.woff2`;
  const out  = path.join(DIR, name);
  curl(['-o', out, url]);
  nameOf.set(url, name);

  const kb = (fs.statSync(out).size / 1024).toFixed(0);
  console.log(`  ${name.padEnd(36)} ${kb} KB`);
  // woff2 的魔数是 wOF2
  const head = fs.readFileSync(out).subarray(0, 4).toString('latin1');
  check(`    ${name} 是张真 woff2`, head === 'wOF2', head);
  if (n >= 12) break;   // 安全阀：不至于一个写错的循环下一堆文件
}

/* ─── 4. 写 fonts.css（地址全改成本地相对路径）───────────────────────────── */

const lines = [
  '/* 由 tools/fetch-fonts.js 生成 —— 别手改，重跑脚本即可。',
  '   ',
  '   为什么要自托管：从 fonts.googleapis.com 现拉的话，每开一个新标签页就往',
  '   Google 发一次请求；国内拉不到时 Mac 回退苹方、Windows 回退微软雅黑/宋体，',
  '   同一个扩展两个系统长得不一样。自托管之后零网络请求，两边完全一致。',
  '   ',
  '   ⚠️ 只有 latin / latin-ext 两个子集 —— 这两个字体里没有汉字。中文走',
  '   style.css 里的系统字体栈。 */',
  '',
];

for (const b of blocks) {
  const file = nameOf.get(b.url);
  if (!file) continue;
  lines.push(`/* ${b.subset} */`);
  lines.push('@font-face {');
  lines.push(`  font-family: '${b.family}';`);
  lines.push(`  font-style: ${b.style};`);
  lines.push(`  font-weight: ${b.weight};`);
  lines.push('  font-display: swap;');
  lines.push(`  src: url('${file}') format('woff2');`);
  if (b.range) lines.push(`  unicode-range: ${b.range};`);
  lines.push('}');
  lines.push('');
}

const outCss = lines.join('\n');
fs.writeFileSync(path.join(DIR, 'fonts.css'), outCss);

/* ─── 5. 断言：产物必须站得住 ───────────────────────────────────────────── */

console.log('\n产物检查');
check('fonts.css 里没有任何外链', !outCss.includes('http://') && !outCss.includes('https://'));
check('  全是本地相对路径', /src: url\('[a-z0-9-]+\.woff2'\)/.test(outCss));
for (const f of nameOf.values()) {
  check(`  文件在：${f}`, fs.existsSync(path.join(DIR, f)));
}
check('两个字体都进来了',
  outCss.includes("'DM Sans'") && outCss.includes("'Newsreader'"));
check('斜体也在（CSS 里用到了）', outCss.includes('font-style: italic'));

const total = fs.readdirSync(DIR)
  .filter(f => f.endsWith('.woff2'))
  .reduce((s, f) => s + fs.statSync(path.join(DIR, f)).size, 0);
console.log(`\n字体总计 ${(total / 1024).toFixed(0)} KB`);
check('体积没失控（< 400 KB）', total < 400 * 1024, `${(total / 1024).toFixed(0)} KB`);

if (failed > 0) {
  console.log(`\n${failed} 条断言没过 —— 别把这个结果提交上去。`);
  process.exit(1);
}
console.log('\n好了。接下来：把 index.html 里那条 fonts.googleapis.com 的 <link> 换成 fonts/fonts.css。');
