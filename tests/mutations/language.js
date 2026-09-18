/**
 * 变异测试：界面语言守卫（tests/smoke.js PART 17 + PART 7 的默认值）
 *
 * 守的是五件「改坏了本地看不出来」的事：
 *   ① 默认语言必须**跟随系统**，而不是悄悄变成中文或英文
 *   ② 取不到系统语言时必须回默认中文（回英文会让中文用户一脸茫然）
 *   ③ 站点条 / 搜索框的默认值（新标签页先给一屏干净的标签页）
 *   ④ 语言必须在 applyStaticStrings 之前落定（否则先画一屏旧语言）
 *   ⑤ 换语言要整块重画、且不抢光标；页面标题也得跟着换
 *
 * 做法：整仓复制到 /tmp，逐条把源码改坏，smoke.js 必须变红。
 * ⚠️ 绝不碰真实仓库。复制整仓（不是只复制 extension/ + tests/），
 *    少一份 LICENSE 基线就是红的。
 *
 * 跑法：node tests/mutations/language.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SRC = path.join(__dirname, '..', '..');
const WORK = '/tmp/gl-lang-mut-work';

function sh(cmd, cwd) {
  try { return { code: 0, out: execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { code: e.status, out: (e.stdout || '') + (e.stderr || '') }; }
}

sh(`mkdir -p ${WORK} && rsync -a --exclude '.git' --exclude '.workbuddy' ${SRC}/ ${WORK}/`);

const F = {
  strings: path.join(WORK, 'extension/strings.js'),
  app:     path.join(WORK, 'extension/app.js'),
  html:    path.join(WORK, 'extension/index.html'),
  readme:  path.join(WORK, 'README.md'),
  store:   path.join(WORK, 'store/上架文案.md'),
  agents:  path.join(WORK, 'AGENTS.md'),
};
const ORIG = Object.fromEntries(
  Object.entries(F).map(([k, p]) => [k, fs.readFileSync(p, 'utf8')]));

// 一条变异改哪个文件、锚点是什么、怎么改
const mutations = [
  {
    name: '默认语言从「跟随系统」变成写死中文',
    file: 'strings', anchor: 'const DEFAULT_LANGUAGE = LANG_SYSTEM;',
    apply: s => s.replace('const DEFAULT_LANGUAGE = LANG_SYSTEM;',
                          "const DEFAULT_LANGUAGE = 'zh';"),
  },
  {
    name: '取不到系统语言时跳英文（中文用户打开就是英文）',
    file: 'strings', anchor: 'if (!tag) return DEFAULT_LANG;',
    apply: s => s.replace('if (!tag) return DEFAULT_LANG;',
                          "if (!tag) return 'en';"),
  },
  {
    name: 'normalizeLanguage 把不认识的值拉回中文，而不是「跟随系统」',
    file: 'strings', anchor: 'return LANG_IDS.indexOf(pref) !== -1 ? pref : DEFAULT_LANGUAGE;',
    apply: s => s.replace(
      'return LANG_IDS.indexOf(pref) !== -1 ? pref : DEFAULT_LANGUAGE;',
      "return LANG_IDS.indexOf(pref) !== -1 ? pref : 'zh';"),
  },
  {
    name: '站点条默认值改回「开」（新标签页又满血）',
    file: 'app', anchor: 'showQuickSites: false,',
    apply: s => s.replace('showQuickSites: false,', 'showQuickSites: true,'),
  },
  {
    name: '搜索框默认值改回「开」',
    file: 'app', anchor: 'showSearchBox:  false,',
    apply: s => s.replace('showSearchBox:  false,', 'showSearchBox:  true,'),
  },
  {
    name: '把 applyStaticStrings 提到 applyUiPrefs 前面（先画一屏旧语言）',
    file: 'app',
    anchor: '  const prefs = await applyUiPrefs();\n',
    apply: s => s.replace(
      '  const prefs = await applyUiPrefs();\n\n' +
      '  // 再把 index.html 里带 data-i18n 的静态文案填上（按钮、label、placeholder 那些）\n' +
      '  applyStaticStrings();\n',
      '  applyStaticStrings();\n\n' +
      '  // 再把 index.html 里带 data-i18n 的静态文案填上（按钮、label、placeholder 那些）\n' +
      '  const prefs = await applyUiPrefs();\n'),
  },
  {
    name: '换语言不再整块重画（页面中英混着）',
    file: 'app', anchor: "  if (key === 'language') {",
    apply: s => s.replace(
      "  if (key === 'language') {\n" +
      '    await renderDashboard({ focus: false });\n' +
      '    return;\n' +
      '  }\n', ''),
  },
  {
    name: '语言下拉少一个选项（英文没了）',
    file: 'html', anchor: '<option value="en"     data-i18n="lang.en"></option>',
    apply: s => s.replace('<option value="en"     data-i18n="lang.en"></option>', ''),
  },
  {
    name: '语言下拉的 value 改成不认识的值（选中项显示空白）',
    file: 'html', anchor: '<option value="system" data-i18n="lang.system"></option>',
    apply: s => s.replace('<option value="system" data-i18n="lang.system"></option>',
                          '<option value="auto"   data-i18n="lang.system"></option>'),
  },
  {
    name: '英文页面标题忘了翻（切英文后标签页还是「归拢」）',
    file: 'strings', anchor: "'doc.title':              'Guilong',",
    apply: s => s.replace("'doc.title':              'Guilong',",
                          "'doc.title':              '归拢',"),
  },
  {
    name: 'applyStaticStrings 不再改 document.title',
    file: 'strings', anchor: "if ('title' in document) document.title = T('doc.title');",
    apply: s => s.replace("if ('title' in document) document.title = T('doc.title');", ''),
  },
  {
    name: '边界：只改设置面板里那句说明文字（本该绿着）',
    file: 'strings', anchor: "'settings.language.desc': '默认跟随系统。',",
    apply: s => s.replace("'settings.language.desc': '默认跟随系统。',",
                          "'settings.language.desc': '默认跟着系统走。',"),
    expectGreen: true,
  },
  {
    name: 'README 设置表的「默认」列没跟着代码改（代码关了，文档还写开）',
    file: 'readme', anchor: '| 常用站点条 | 关 |',
    apply: s => s.replace('| 常用站点条 | 关 |', '| 常用站点条 | 开 |'),
  },
  {
    name: 'README 设置表把界面语言的默认写成中文',
    file: 'readme', anchor: '| 界面语言 | 跟随系统 |',
    apply: s => s.replace('| 界面语言 | 跟随系统 |', '| 界面语言 | 中文 |'),
  },
  {
    name: '商店文案还写着「默认中文」（对外说错话）',
    file: 'store', anchor: '【中英双语】默认跟随系统，',
    apply: s => s.replace('【中英双语】默认跟随系统，', '【中英双语】默认中文，'),
  },
  {
    name: 'AGENTS.md 还写着「默认中文」',
    file: 'agents', anchor: '默认跟随系统（系统说中文就用中文',
    apply: s => s.replace('默认跟随系统（系统说中文就用中文',
                          '默认中文（系统说中文就用中文'),
  },
];

function restore() {
  for (const [k, p] of Object.entries(F)) fs.writeFileSync(p, ORIG[k]);
}
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
  const src = ORIG[m.file];
  // ① 锚点必须唯一 —— 0 次命中说明变异没生效，「通过」是假的
  const hits = src.split(m.anchor).length - 1;
  if (hits === 0) {
    console.log(`⚠️  锚点没命中，变异没生效：${m.name}`); noop++; continue;
  }
  if (hits > 1) {
    console.log(`⚠️  锚点出现 ${hits} 次（不唯一，可能改错地方）：${m.name}`); noop++; continue;
  }
  const after = m.apply(src);
  // ② 确认变异真的改坏了东西 —— 只改注释的变异绿着是变异没生效
  if (after === src) {
    console.log(`⚠️  改完没变化，变异没生效：${m.name}`); noop++; continue;
  }
  fs.writeFileSync(F[m.file], after);

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
