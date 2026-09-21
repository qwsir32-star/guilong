/**
 * 由 extension/icons/icon.svg（母版）导出各尺寸 PNG。
 * 母版是唯一真源 —— 改图标只改 icon.svg，然后重跑这个脚本。
 *
 * 跑法：
 *   npm i @resvg/resvg-js                 # 归拢本身零依赖，只有出图标才需要它
 *   node tools/make-icons.js
 *   （resvg 装在哪儿都行，用 NODE_PATH 指过去也可以）
 */
const { Resvg } = require('@resvg/resvg-js');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ICONS = path.join(ROOT, 'extension', 'icons');
const master = fs.readFileSync(path.join(ICONS, 'icon.svg'), 'utf8');

const SIZES = [16, 32, 48, 128];
let bad = 0;

for (const size of SIZES) {
  const png = new Resvg(master, { fitTo: { mode: 'width', value: size } }).render().asPng();
  const file = path.join(ICONS, `icon${size}.png`);
  fs.writeFileSync(file, png);

  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  const ok = w === size && h === size;
  if (!ok) bad++;
  console.log(`${ok ? 'OK  ' : 'BAD '} icon${size}.png  ${w}x${h}  ${png.length} bytes`);
}

if (bad) {
  console.error(`\n有 ${bad} 张尺寸不对，别提交。`);
  process.exit(1);
}
console.log('\n四张图标已由 icon.svg 导出。');
