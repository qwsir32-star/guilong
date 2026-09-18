/**
 * 生成 extension/china-places.js —— 天气城市搜索的本地城市库。
 *
 * 为什么需要它：Open-Meteo 的地理编码接口对中国地名基本不可用 ——
 * 实测搜「青岛」返回 3 条（辽宁的青岛村 + 两个无人岛），真正的青岛市根本不在
 * 结果里；搜「大连」返回 5 条全是村子。正确答案不在数据里，任何筛选规则都救不了。
 * 所以城市库改成本地数据：只收录**省 / 市两级**行政区划（用户定下的框架），
 * 搜索离线完成，一次网络都不打。
 *
 * 数据来源：阿里云 DataV 行政区划边界（areas_v3），名字与坐标以 adcode 为准。
 * 结构规则（与产品约定一一对应）：
 *   · 普通省 / 自治区：省本身（坐标用省会城市的中心，不是省的几何中心）+ 各地级市
 *   · 直辖市：市本身 + 各区
 *   · 香港 / 澳门：只收自身一级（约定「到香港澳门就行了」）
 *   · 台湾省：DataV 没有下级数据，只收自身
 *   · 省直辖县级市 / 县（海南、河南、湖北、新疆那些 469xxx / 419xxx / 429xxx / 659xxx）
 *     在 v3 里已经平铺成 city 级，直接跟着收
 *
 * 重跑：node tools/make-china-places.js   （会联网，零依赖）
 * 产物是 extension 的一部分、要提交；别手改产物，改这个脚本。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT  = path.join(ROOT, 'extension', 'china-places.js');

const BASE = 'https://geo.datav.aliyun.com/areas_v3/bound';
const MUNICIPALITIES = new Set(['110000', '120000', '310000', '500000']);   // 京津沪渝
const DIRECT_ONLY    = new Set(['710000', '810000', '820000']);             // 台湾 / 香港 / 澳门

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const text = await res.text();
  // 没有数据时 DataV 返回的是 XML 错误页，不是 JSON —— 要在解析前识别
  if (text.trimStart().startsWith('<')) throw new Error(`${url} 返回的不是 JSON`);
  return JSON.parse(text);
}

/* 省会城市：adcode 以 0100 结尾的那个市（济南 370100、乌鲁木齐 650100……全国通用）。
   找不到就用列表第一个市兜底，找不到市就退回省中心 —— 但两种情况都会打警告。 */
function findCapital(cities, province) {
  const cap = cities.find(c => String(c.adcode).endsWith('0100'));
  if (cap) return cap;
  console.warn(`  ⚠ ${province.name} 没找到 0100 结尾的省会，退回列表第一个`);
  return cities[0] || null;
}

(async () => {
  const top = await getJson(`${BASE}/100000_full.json`);
  const provinces = top.features
    .map(f => f.properties)
    .filter(p => p.adcode !== '100000_JD');   // 京东那条特殊标记不是行政区

  const entries = [];
  let totalSub = 0;

  for (const p of provinces) {
    const code = String(p.adcode);
    const [lo, la] = p.center;

    if (DIRECT_ONLY.has(code)) {
      // 香港 / 澳门 / 台湾：只收自身一级
      entries.push({ n: p.name, la, lo, p: '', k: 'special' });
      console.log(`  ${p.name} → 只收自身`);
      continue;
    }

    const sub = await getJson(`${BASE}/${code}_full.json`);
    const children = sub.features.map(f => f.properties);

    if (MUNICIPALITIES.has(code)) {
      entries.push({ n: p.name, la, lo, p: '', k: 'municipality' });
      for (const d of children) {
        const [dlo, dla] = d.center;
        entries.push({ n: d.name, la: dla, lo: dlo, p: p.name, k: 'district' });
      }
      console.log(`  ${p.name} → 自身 + ${children.length} 个区`);
      totalSub += children.length;
      continue;
    }

    // 普通省 / 自治区：省条目用省会的坐标
    const capital = findCapital(children, p);
    const capName = capital ? capital.name : '';
    const [clo, cla] = capital ? capital.center : [lo, la];
    entries.push({ n: p.name, la: cla, lo: clo, p: '', k: 'province', cap: capName });
    for (const c of children) {
      const [cLo, cLa] = c.center;
      entries.push({ n: c.name, la: cLa, lo: cLo, p: p.name, k: 'city' });
    }
    console.log(`  ${p.name} → 省会${capName} + ${children.length} 个市`);
    totalSub += children.length;
  }

  /* ---- 落盘前的存在性断言（这个文件是生成的，坏数据不该悄悄写进去） ---- */
  const must = [
    ['总条目数 ≥ 480',              entries.length >= 480],
    ['一级条目（省/直辖市/特区）= 34', entries.filter(e => !e.p).length === 34],
    ['二级条目 ≥ 445（当前 449）',    totalSub >= 445],
    ['山东省有 16 个市',             entries.filter(e => e.p === '山东省').length === 16],
    ['青岛市在山东省里',             entries.some(e => e.n === '青岛市' && e.p === '山东省')],
    ['大连市在辽宁省里',             entries.some(e => e.n === '大连市' && e.p === '辽宁省')],
    ['北京市有 16 个区',             entries.filter(e => e.p === '北京市').length === 16],
    ['重庆市有 38 个区',             entries.filter(e => e.p === '重庆市').length === 38],
    ['香港只有自身一条',             entries.filter(e => e.p === '香港特别行政区' ).length === 0
                                     && entries.some(e => e.n === '香港特别行政区' && e.k === 'special')],
    ['台湾省只有自身一条',           entries.some(e => e.n === '台湾省' && e.k === 'special')],
    ['山东省的省会是济南市',         entries.find(e => e.n === '山东省').cap === '济南市'],
    ['广西的省会是南宁市',           entries.find(e => e.n === '广西壮族自治区').cap === '南宁市'],
    ['每个条目都有名字和坐标',       entries.every(e => e.n && Number.isFinite(e.la) && Number.isFinite(e.lo))],
    ['坐标都在中国范围里',           entries.every(e => e.la > 3 && e.la < 54 && e.lo > 73 && e.lo < 136)],
  ];
  const failed = must.filter(([, ok]) => !ok);
  if (failed.length) {
    console.error('\n数据没过关，不落盘：');
    failed.forEach(([label]) => console.error('  ✗ ' + label));
    process.exit(1);
  }

  const header = `/* ⚠️ 这个文件是 tools/make-china-places.js 生成的，别手改 —— 改那个脚本再重跑。
   天气城市搜索的本地城市库：中国省 / 市两级行政区划（直辖市到区，香港澳门台湾只收自身）。
   字段：n=名称  la/lo=中心坐标  p=所属一级行政区（一级条目为空）  k=province|municipality|city|district|special
   cap=省会名（仅省条目有；省条目的坐标用的是省会城市的中心，不是省的几何中心）。
   数据来源：阿里云 DataV areas_v3（adcode 为准）。共 ${entries.length} 条。 */
`;
  const body = 'const CHINA_PLACES = ' + JSON.stringify(entries, null, 0)
    .replace(/\},\{/g, '},\n{') + ';\n';

  fs.writeFileSync(OUT, header + body);
  console.log(`\n已生成 ${OUT}`);
  console.log(`共 ${entries.length} 条（一级 ${entries.filter(e => !e.p).length} / 二级 ${totalSub}），`
    + `${fs.statSync(OUT).size} 字节`);
})();
