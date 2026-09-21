/* 主题色的变异测试。
   每条新守卫都要证明它「坏掉时会变红」—— 一条永远不会失败的断言不是守卫，
   只是装饰。做法：把仓库复制到 /tmp 再改，**绝不碰真实仓库**。
   跑法：node tests/mutations/theme.js */
const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = path.join(__dirname, '..', '..');
const WORK = '/tmp/guilong-theme-mut-' + process.pid;
const NODE = process.execPath;

function copyRepo() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  // 整个仓库都复制（除了 .git）：冒烟测试会读 LICENSE（校验上游署名），
  // 只复制 extension/ 和 tests/ 会漏掉它，然后基线就是红的。
  for (const name of fs.readdirSync(SRC)) {
    if (name === '.git') continue;
    fs.cpSync(path.join(SRC, name), path.join(WORK, name), { recursive: true });
  }
}

function runSmoke() {
  try {
    execFileSync(NODE, ['tests/smoke.js'], { cwd: WORK, stdio: 'pipe' });
    return { code: 0, out: '' };
  } catch (e) {
    return { code: e.status || 1, out: String(e.stdout || '') };
  }
}

const MUTATIONS = [
  /* ---- 存储定型：主题最容易被存成布尔 ---- */
  { n: 'setUiPref 改回一律 !!value（主题存成布尔）', f: 'extension/app.js',
    from: "  prefs[key] = typeof UI_PREFS_DEFAULTS[key] === 'boolean' ? !!value : String(value);",
    to:   '  prefs[key] = !!value;' },

  { n: '主题不认识的值也照存（脏值留在存储里）', f: 'extension/app.js',
    from: "  if (key === 'theme') {\n    prefs.theme = normalizeTheme(prefs.theme);",
    to:   "  if (key === 'theme' && false) {\n    prefs.theme = normalizeTheme(prefs.theme);" },

  /* ---- 跟随系统的解析 ---- */
  { n: '跟随系统的深浅反了', f: 'extension/app.js',
    from: "  if (pref === THEME_SYSTEM) return systemPrefersDark() ? 'dark' : 'light';",
    to:   "  if (pref === THEME_SYSTEM) return systemPrefersDark() ? 'light' : 'dark';" },

  { n: 'normalizeTheme 把 system 也拉回默认（下拉里就显示不回「跟随系统」了）',
    f: 'extension/app.js',
    from: "  if (pref === THEME_SYSTEM) return THEME_SYSTEM;",
    to:   '  if (false) return THEME_SYSTEM;' },

  // 锚点必须带上函数名：normalizeTheme 里有一行一模一样的 return
  { n: 'resolveTheme 不认识的值不回默认', f: 'extension/app.js',
    from: "function resolveTheme(pref) {\n  if (pref === THEME_SYSTEM) return systemPrefersDark() ? 'dark' : 'light';\n  return THEME_IDS.indexOf(pref) !== -1 ? pref : DEFAULT_THEME;",
    to:   "function resolveTheme(pref) {\n  if (pref === THEME_SYSTEM) return systemPrefersDark() ? 'dark' : 'light';\n  return pref;" },

  /* ---- 落到 DOM ---- */
  { n: 'paintTheme 不写 data-theme（选了没反应）', f: 'extension/app.js',
    from: '  root.dataset.theme = id;', to: '  // (变异) 不写' },

  { n: 'color-scheme 恒为 light（深色主题挂一条亮滚动条）', f: 'extension/app.js',
    from: "  root.style.colorScheme = isDarkTheme(id) ? 'dark' : 'light';",
    to:   "  root.style.colorScheme = 'light';" },

  { n: 'applyUiPrefs 把下拉当开关同步（读 checked）', f: 'extension/app.js',
    from: "    if (el.tagName === 'SELECT') el.value = String(prefs[key]);\n    else el.checked = !!prefs[key];",
    to:   '    el.checked = !!prefs[key];' },

  { n: 'readSettingValue 不认 SELECT（选主题读到 undefined）', f: 'extension/app.js',
    from: "  return el.tagName === 'SELECT' ? el.value : !!el.checked;",
    to:   '  return !!el.checked;' },

  /* ---- localStorage 镜像 ---- */
  { n: 'mirrorTheme 不写镜像（深色每开一页白闪一下）', f: 'extension/app.js',
    from: '    localStorage.setItem(THEME_MIRROR_KEY, normalizeTheme(pref));',
    to:   '    // (变异) 不写镜像' },

  { n: 'applyUiPrefs 不再画主题', f: 'extension/app.js',
    from: "  const themeId = paintTheme(prefs.theme);\n  mirrorTheme(prefs.theme);",
    to:   '  const themeId = resolveTheme(prefs.theme);' },

  /* ---- theme-boot.js（预加载那一步） ---- */
  { n: '预加载不读镜像（永远按默认画，深色会白闪）', f: 'extension/theme-boot.js',
    from: "    pref = localStorage.getItem(MIRROR_KEY) || FALLBACK;",
    to:   '    pref = FALLBACK;' },

  { n: '预加载把 system 原样写到 data-theme 上（CSS 里没这套）', f: 'extension/theme-boot.js',
    from: "    id = dark ? 'dark' : 'light';", to: "    id = 'system';" },

  { n: '预加载的清单少一个主题', f: 'extension/theme-boot.js',
    from: "var THEME_IDS = ['paper', 'light', 'mint', 'sky', 'dark', 'forest', 'ink'];",
    to:   "var THEME_IDS = ['paper', 'light', 'mint', 'sky', 'dark', 'forest'];" },

  { n: '预加载不做合法性检查', f: 'extension/theme-boot.js',
    from: '  if (THEME_IDS.indexOf(id) === -1) id = FALLBACK;', to: '' },

  /* ---- index.html ---- */
  { n: 'theme-boot.js 挪到 body 末尾（等于白做）', f: 'extension/index.html',
    from: '  <script src="theme-boot.js" data-page-node-id="T1H3m3B00t"></script>\n</head>',
    to:   '</head>' },

  { n: '下拉少一个选项', f: 'extension/index.html',
    from: '        <option value="ink"    data-i18n="theme.ink"></option>\n', to: '' },

  { n: '选项的名字不进文案表', f: 'extension/index.html',
    from: '<option value="forest" data-i18n="theme.forest"></option>',
    to:   '<option value="forest">松林</option>' },

  /* ---- CSS：主题块只该覆盖三元组 ---- */
  { n: '松林主题少写一个三元组（有一块颜色不跟着变）', f: 'extension/style.css',
    from: 'html[data-theme="forest"] {\n  --rgb-ink: 226 236 228;\n',
    to:   'html[data-theme="forest"] {\n' },

  { n: '深色主题里塞一个写死的 rgba', f: 'extension/style.css',
    from: 'html[data-theme="dark"] {\n', to: 'html[data-theme="dark"] {\n  --shadow: rgba(0, 0, 0, 0.5);\n' },

  // 把选择器改错一个字母 —— CSS 里就没有 ink 这一套了，页面上会静默退回 :root
  { n: '墨蓝主题块的选择器写错（等于没有这个主题）', f: 'extension/style.css',
    from: 'html[data-theme="ink"] {', to: 'html[data-theme="inkk"] {' },

  /* ---- 浅绿 / 浅蓝 ---- */
  { n: '浅绿主题少了一个三元组', f: 'extension/style.css',
    from: 'html[data-theme="mint"] {\n  --rgb-ink: 26 34 28;\n',
    to:   'html[data-theme="mint"] {\n' },

  { n: 'app.js 的清单里漏掉浅绿（下拉里就没有它）', f: 'extension/app.js',
    from: "const THEME_IDS = ['paper', 'light', 'mint', 'sky', 'dark', 'forest', 'ink'];",
    to:   "const THEME_IDS = ['paper', 'light', 'sky', 'dark', 'forest', 'ink'];" },

  { n: 'theme-boot.js 的清单里漏掉浅蓝（开新页会白闪）', f: 'extension/theme-boot.js',
    from: "var THEME_IDS = ['paper', 'light', 'mint', 'sky', 'dark', 'forest', 'ink'];",
    to:   "var THEME_IDS = ['paper', 'light', 'mint', 'dark', 'forest', 'ink'];" },

  /* ---- 对比度守卫 ---- */
  { n: '浅绿的正文太浅（字看不清）', f: 'extension/style.css',
    from: 'html[data-theme="mint"] {\n  --rgb-ink: 26 34 28;',
    to:   'html[data-theme="mint"] {\n  --rgb-ink: 150 160 152;' },

  { n: '浅蓝的主色太浅（实心按钮上的白字看不清）', f: 'extension/style.css',
    from: '  --rgb-accent-sage: 66 116 132;', to: '  --rgb-accent-sage: 150 192 208;' },

  { n: '浅蓝的次要字比现有主题更淡', f: 'extension/style.css',
    from: '  --rgb-muted: 130 142 156;', to: '  --rgb-muted: 176 186 196;' },
];

copyRepo();
const base = runSmoke();
console.log('基线（未变异）：' + (base.code === 0 ? '全绿 ✓' : '红 ✗ 基线就是坏的，后面的结论不可信'));
if (base.code !== 0) { console.log(base.out.split('\n').filter(l => l.includes('FAIL')).join('\n')); process.exit(1); }

let bad = 0;
console.log('');
for (const m of MUTATIONS) {
  copyRepo();
  const p = path.join(WORK, m.f);
  const src = fs.readFileSync(p, 'utf8');
  const hits = src.split(m.from).length - 1;
  if (hits !== 1) {
    console.log(`  ??  ${m.n} —— 锚点在源码里出现 ${hits} 次（要求 1 次），这条没测到`);
    bad++;
    continue;
  }
  fs.writeFileSync(p, src.split(m.from).join(m.to));
  const r = runSmoke();
  if (r.code === 0) {
    console.log(`  ✗  ${m.n} —— 改坏了但测试还是全绿，这条守卫是假的`);
    bad++;
  } else {
    const f = r.out.split('\n').filter(l => l.includes('FAIL')).map(l => l.trim().replace(/^FAIL\s+/, '').split('  →')[0]);
    console.log(`  ✓  ${m.n} —— 变红，抓到 ${f.length} 条：${f[0] || ''}`);
  }
}
fs.rmSync(WORK, { recursive: true, force: true });
console.log('\n' + (bad === 0 ? `全部 ${MUTATIONS.length} 条变异都被抓住了` : `${bad} 条变异没被抓住`));
process.exit(bad === 0 ? 0 : 1);
