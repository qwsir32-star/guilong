/* =====================================================================
   PART 20 的变异测试 —— 「出网主机白名单」这条守卫真的会红吗？

   做法：把**整个仓库**复制到 /tmp（只复制 extension/ + tests/ 会漏 LICENSE，
   基线直接就是红的），在副本上逐条改坏源码，跑 tests/smoke.js，看它是否变红。
   真实仓库全程只读。

   每条变异都声明「锚点该命中几次」。命中数不符就跳过并报错 —— 一条 0 次命中
   的变异是假通过（改了个不存在的地方，仓库当然还是绿的）。
   另外还要求「替换后确实变了」，只改注释那种改不动东西的变异也会被点名。
   ===================================================================== */

const fs   = require('fs');
const path = require('path');
const cp   = require('child_process');

const SRC_REPO = path.join(__dirname, '..', '..');
const DST      = `/tmp/gl-favmut-${Date.now()}`;

console.log(`复制仓库到 ${DST} …`);
fs.cpSync(SRC_REPO, DST, { recursive: true });

const APP = 'extension/app.js';

const MUTATIONS = [
  {
    name: '把三处图标改回直连 google s2（这次修掉的洞原样搬回来）',
    red: true,
    pairs: [
      { file: APP, find: 'const faviconUrl = faviconUrlFor(tab.url, 16);',  expect: 2,
        repl: 'const faviconUrl = `https://www.google.com/s2/favicons?domain=x&sz=16`;' },
      { file: APP, find: 'const faviconUrl = faviconUrlFor(item.url, 16);', expect: 1,
        repl: 'const faviconUrl = `https://www.google.com/s2/favicons?domain=x&sz=16`;' },
    ],
  },
  {
    name: '换掉天气接口的主机（换一家服务 = 名单里就多一个陌生主机）',
    red: true,
    pairs: [
      { file: APP, find: 'https://api.open-meteo.com', expect: 1,
        repl: 'https://api.open-meteo-cdn.example.com' },
    ],
  },
  {
    name: '在 handleFaviconError 里把 img.src 接回去（兜底又去联网）',
    red: true,
    pairs: [
      { file: APP, find: 'function handleFaviconError(img) {\n  img.remove();\n}', expect: 1,
        repl: 'function handleFaviconError(img) {\n  img.src = `https://www.google.com/s2/favicons?domain=${img.dataset.host}`;\n}' },
    ],
  },
  {
    name: '去掉「稍后再看」那处的空串守卫（Firefox 上空串会去加载当前页）',
    red: true,
    pairs: [
      { file: APP, find: '${faviconUrl ? `<img src="${faviconUrl}" alt="" style=', expect: 1,
        repl: '${`<img src="${faviconUrl}" alt="" style=' },
    ],
  },
  {
    name: '把 host 字段加回 resolveSiteIcon（给这个洞留一条接回去的线）',
    red: true,
    pairs: [
      { file: APP, find: 'return { img: faviconUrlFor(site.url, 32), letter: first };', expect: 1,
        repl: 'return { img: faviconUrlFor(site.url, 32), letter: first, host: hostnameOf(site.url) };' },
    ],
  },
  {
    name: '重命名 handleFaviconError（块切不出来时，守卫必须自己承认是假绿）',
    red: true,
    pairs: [
      { file: APP, find: 'function handleFaviconError(img) {', expect: 1,
        repl: 'function handleFaviconErrorX(img) {' },
    ],
  },
  {
    name: '新增一个 extension/extra-helper.js，里面带外部主机（守卫最容易漏的就是文件清单）',
    red: true,
    pairs: [
      { file: 'extension/extra-helper.js', find: null, expect: 0,
        repl: "const ENDPOINT = 'https://telemetry.example.net/beacon';\n" },
    ],
  },
  {
    name: '边界：把 s2 地址写进注释（剥注释之后应当仍是绿的）',
    red: false,
    pairs: [
      { file: APP, find: 'function handleFaviconError(img) {', expect: 1,
        repl: '// 曾经退到 https://www.google.com/s2/favicons?domain=x\nfunction handleFaviconError(img) {' },
    ],
  },
];

const run = () => cp.spawnSync(process.execPath, ['tests/smoke.js'], { cwd: DST, encoding: 'utf8' }).status;

// 基线必须是绿的，否则「变红」说明不了任何事
const base = run();
console.log(`基线：${base === 0 ? '绿 ✓' : `红 ✗（exit ${base}）`}`);
if (base !== 0) {
  console.log('基线不绿，后面的结论都不可信，先修基线。');
  process.exit(1);
}

let red = 0, green = 0, skipped = 0;

for (const m of MUTATIONS) {
  const snapshots = new Map();
  let applied = true;

  for (const p of m.pairs) {
    const abs = path.join(DST, p.file);
    const before = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    if (!snapshots.has(abs)) snapshots.set(abs, before);

    if (p.find === null) {                       // 新增文件
      fs.writeFileSync(abs, p.repl);
      continue;
    }
    if (before === null) { applied = false; console.log(`  ⚠️ ${p.file} 不存在`); break; }

    const hits = before.split(p.find).length - 1;
    if (hits !== p.expect) {
      applied = false;
      console.log(`  ⚠️ 跳过「${m.name}」：锚点在 ${p.file} 命中 ${hits} 次，期望 ${p.expect}`);
      break;
    }
    const after = before.split(p.find).join(p.repl);
    if (after === before) {                      // 改不动东西的变异
      applied = false;
      console.log(`  ⚠️ 跳过「${m.name}」：替换之后内容没变`);
      break;
    }
    fs.writeFileSync(abs, after);
  }

  let status = null;
  if (applied) status = run();

  // 无论结果如何，先把副本还原回原样
  for (const [abs, before] of snapshots) {
    if (before === null) { if (fs.existsSync(abs)) fs.unlinkSync(abs); }
    else fs.writeFileSync(abs, before);
  }

  if (!applied) { skipped++; continue; }

  const wentRed = status !== 0;
  const ok = m.red ? wentRed : !wentRed;
  if (!ok) skipped++;                            // 当成失败统计，最后一起报

  if (m.red && wentRed)   red++;
  if (!m.red && !wentRed) green++;

  console.log(`  ${ok ? '✓' : '✗'} ${m.name}`);
  console.log(`      → ${wentRed ? `红（exit ${status}）` : '绿'}`);
}

console.log('');
console.log(`红 ${red} / 该红 ${MUTATIONS.filter(m => m.red).length}；` +
            `绿（边界）${green} / 该绿 ${MUTATIONS.filter(m => !m.red).length}；异常 ${skipped}`);
const allGood = red === MUTATIONS.filter(m => m.red).length
             && green === MUTATIONS.filter(m => !m.red).length
             && skipped === 0;
console.log(allGood ? '全部符合预期 ✓' : '有不符合预期的变异 ✗');
process.exit(allGood ? 0 : 1);
