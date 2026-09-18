/**
 * build-store.js — 把 extension/ 打成三家商店能上传的包
 *
 * 跑法：node tools/build-store.js
 * 产物：dist/guilong-<版本>-chrome.zip / -edge.zip / -firefox.zip
 *       （dist/<target>/ 是解开的目录，方便 zip 之前先看一眼）
 *
 * 为什么需要它：
 *   一份源码，三种 manifest。Chrome 和 Edge 是同一个包（Edge 是 Chromium，
 *   chrome.* 全对齐）；Firefox 只改 manifest，代码一行不动 —— 前提是只用
 *   三家都有的 API（我们做到了，差异全在 extension/env.js 里）。
 *
 * ⚠️ 每条改动都带断言。**打包脚本最容易出的错是「包打出来了，但里面是错的」**
 *    —— 缺一个文件、manifest 少一个字段，zip 照样生成成功。所以这里宁可
 *    打不出来，也不打一个错的上去。
 */

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXT  = path.join(ROOT, 'extension');
const DIST = path.join(ROOT, 'dist');

/* 永远不进包的文件：
   - config.local.js 是个人的落地页规则，本来就在 .gitignore 里
   - .DS_Store 是 macOS 的垃圾，混进包里 AMO 会报「包里有奇怪的东西」 */
const EXCLUDE = new Set(['config.local.js', '.DS_Store', 'Icon\r']);

/* ─── Firefox 的三处硬性要求 ──────────────────────────────────────────────
   ID 必须一次定好：首次签名后 AMO 就认这个了，改起来很麻烦。
   格式是 ^[a-zA-Z0-9-._]*@[a-zA-Z0-9-._]+$（MDN 明文规定）。 */
const GECKO_ID = 'guilong@qwsir32-star.github.io';

/* 版本地板是**算术**，不是拍脑袋：
     - 根证书过期（2025-03）→ 低于 115 ESR / 128 拿不到更新
     - 后台双键（service_worker + scripts）→ 121
     - data_collection_permissions 被支持 → 桌面 140 / Android 142
   取 142.0 三个都能过，lint 一条警告都不会有。 */
const GECKO_MIN_VERSION = '142.0';

let failed = 0;
function ok(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failed++;
  console.log(
    (pass ? '  ✓  ' : '  ✗  ') + label +
    (pass ? '' : `  → 实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`)
  );
}
function check(label, cond, detail) {
  if (cond) { console.log('  ✓  ' + label); return; }
  failed++;
  console.log('  ✗  ' + label + (detail ? `  → ${detail}` : ''));
}

/* ─── manifest 变换 ────────────────────────────────────────────────────── */

function chromiumManifest(base) {
  // Chrome / Edge 原样用：service_worker、固定的 key（扩展 ID 不会变）都在
  return JSON.parse(JSON.stringify(base));
}

function firefoxManifest(base) {
  const m = JSON.parse(JSON.stringify(base));

  // 1. 后台：Firefox 的 MV3 用 event page，没有 service worker
  const sw = m.background && m.background.service_worker;
  if (!sw) throw new Error('源 manifest 里没有 background.service_worker，Firefox 变换没法做');
  m.background = { scripts: ['env.js', sw] };
  // env.js 必须排在 background.js 前面：脚本数组的顺序就是加载顺序。
  // （background.js 里还有一句 importScripts 兜底，给 Chrome 用的。）

  // 2. 签名用的 ID + 数据声明 + 版本地板
  m.browser_specific_settings = {
    gecko: {
      id: GECKO_ID,
      strict_min_version: GECKO_MIN_VERSION,
      // 2025-11 起 AMO 对**所有**新扩展的硬性要求：不写就报
      // MISSING_DATA_COLLECTION_PERMISSIONS。我们确实什么都不收集，写 none。
      data_collection_permissions: { required: ['none'] },
    },
    // 故意不写 gecko_android：Firefox for Android 根本不支持
    // chrome_url_overrides（MDN 上是 "No support"），上了就是个坏的核心功能。
  };

  // 3. 删掉 Firefox 不认 / 用不上的东西
  delete m.key;   // Chrome 固定扩展 ID 用的公钥，Firefox 不认
  // favicon 权限是 Chromium 专有的（_favicon 端点），Firefox 上没有这个权限，
  // 留着会被 lint 点成「未知权限」
  m.permissions = (m.permissions || []).filter(p => p !== 'favicon');

  // 4. 快捷键：Ctrl+Shift+K 在 Firefox 里是「Web 控制台」，会撞车。
  //    Firefox 输了也不会报错，就是按了没反应 —— 那种 bug 最难查。换成 L。
  if (m.commands && m.commands['open-dashboard']) {
    m.commands['open-dashboard'].suggested_key = {
      default: 'Ctrl+Shift+L',
      mac: 'Command+Shift+L',
    };
  }

  return m;
}

/* ─── 打包 ────────────────────────────────────────────────────────────── */

/**
 * stage(target, manifest) — 把要打包的文件摊到 dist/<target>/
 *
 * ⚠️ 这个脚本**不删任何东西**，只覆写。原因很简单：它唯一想删的是自己上次
 * 生成的产物，而一个拼错的 DIST 就能让它把别的东西带走。打包脚本不配拥有
 * 删除权限。
 *
 * 代价是旧目录里可能有上次留下、这次已经不要的文件。这个风险用断言兜住：
 * 下面会比对「目录里实际有什么」和「应该有什么」，多了就报错并点名是哪个 ——
 * 由人来决定删不删。
 */
function stage(target, manifest) {
  const dir = path.join(DIST, target);
  fs.mkdirSync(dir, { recursive: true });

  const expected = new Set(['manifest.json']);

  // 只拷白名单里的：extension/ 下的文件 + 各个子目录
  for (const name of fs.readdirSync(EXT)) {
    if (EXCLUDE.has(name)) continue;
    const from = path.join(EXT, name);
    const to   = path.join(dir, name);

    if (fs.statSync(from).isDirectory()) {
      expected.add(name);
      fs.mkdirSync(to, { recursive: true });
      for (const sub of fs.readdirSync(from)) {
        if (EXCLUDE.has(sub)) continue;
        fs.copyFileSync(path.join(from, sub), path.join(to, sub));
      }
    } else {
      expected.add(name);
      fs.copyFileSync(from, to);
    }
  }

  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n'
  );

  // 多出来的（上次留下、这次源里已经没有的）会说清楚是哪个，不替人删
  const extra = fs.readdirSync(dir).filter(n => !expected.has(n));
  if (extra.length) {
    throw new Error(
      `dist/${target}/ 里有 ${extra.length} 个不属于本次打包的文件：${extra.join('、')}\n` +
      `  脚本不删东西 —— 确认没用后请手动删掉，再重跑一次。`
    );
  }
  return dir;
}

function zip(target, dir, version) {
  const zipPath = path.join(DIST, `guilong-${version}-${target}.zip`);
  // 在目录**里面**执行 zip，manifest.json 才会落在包的根目录 ——
  // 套一层子目录的话三家商店都装不上，而且报错信息不会告诉你原因。
  // -FS：就地同步，把已经不在目录里的文件从包里去掉（所以不用先删旧 zip）。
  execFileSync('zip', ['-r', '-X', '-q', '-FS', zipPath, '.'], { cwd: dir });
  return zipPath;
}

/* ─── 断言 ────────────────────────────────────────────────────────────── */

function assertCommon(target, m, dir) {
  console.log(`\n[${target}] manifest`);
  ok('manifest_version 是 3', m.manifest_version, 3);
  check('有名字', !!m.name);
  check('有描述', !!m.description);
  check('版本号像版本号', /^\d+\.\d+\.\d+$/.test(m.version || ''), m.version);
  ok('抢下新标签页（三家都支持）', m.chrome_url_overrides && m.chrome_url_overrides.newtab, 'index.html');

  // manifest 里点到的文件必须真的在包里 —— 少一个 PNG 商店能装上，
  // 但图标会是个破图，而且没人会想到是打包漏了
  for (const f of Object.values(m.icons || {})) {
    check(`图标存在：${f}`, fs.existsSync(path.join(dir, f)));
  }
  for (const f of Object.values((m.action && m.action.default_icon) || {})) {
    check(`工具栏图标存在：${f}`, fs.existsSync(path.join(dir, f)));
  }
  for (const f of ['index.html', 'app.js', 'background.js', 'env.js',
                   'strings.js', 'china-places.js', 'style.css', 'theme-boot.js']) {
    check(`页面要用的文件在包里：${f}`, fs.existsSync(path.join(dir, f)));
  }

  /* 字体随包走 —— 这个最容易漏：漏了不报错，只是字体静默掉回系统字体，
     而 Mac 和 Windows 回退出来的是两套样子。字重 / 子集变了也要跟着看。 */
  const fontsDir = path.join(dir, 'fonts');
  check('fonts/ 目录在包里', fs.existsSync(fontsDir));
  check('  fonts.css 在', fs.existsSync(path.join(fontsDir, 'fonts.css')));
  const woff2 = fs.existsSync(fontsDir)
    ? fs.readdirSync(fontsDir).filter(f => f.endsWith('.woff2')) : [];
  check(`  字体文件都在（${woff2.length} 张 woff2）`, woff2.length >= 6, true);
  check('  页面引的是本地那份 fonts.css',
    fs.readFileSync(path.join(dir, 'index.html'), 'utf8').includes('href="fonts/fonts.css"'), true);

  // 垃圾文件
  check('包里没有 .DS_Store', !fs.existsSync(path.join(dir, '.DS_Store')));
  check('包里没有 config.local.js（那是个人配置，不外发）',
    !fs.existsSync(path.join(dir, 'config.local.js')));
}

function assertChromium(m) {
  ok('后台是 service worker', !!(m.background && m.background.service_worker), true);
  check('保留了 key（扩展 ID 才不会变）', !!m.key);
  check('没有 Firefox 专有的字段', !m.browser_specific_settings);
  ok('默认快捷键是 Ctrl+Shift+K', m.commands['open-dashboard'].suggested_key.default, 'Ctrl+Shift+K');
}

function assertFirefox(m) {
  ok('后台是 scripts（Firefox 没有 service worker）',
    Array.isArray(m.background && m.background.scripts), true);
  check('  env.js 排在 background.js 前面（脚本数组顺序 = 加载顺序）',
    m.background.scripts[0] === 'env.js' && m.background.scripts[1] === 'background.js',
    JSON.stringify(m.background.scripts));
  check('后台里没有 service_worker 了', !m.background.service_worker);

  const gecko = m.browser_specific_settings && m.browser_specific_settings.gecko;
  check('有 gecko 段', !!gecko);
  if (gecko) {
    ok('gecko.id 一次定好', gecko.id, GECKO_ID);
    check('  id 格式合规（^[a-zA-Z0-9-._]*@[a-zA-Z0-9-._]+$）',
      /^[a-zA-Z0-9-._]*@[a-zA-Z0-9-._]+$/.test(gecko.id), gecko.id);
    ok('版本地板是 142.0（桌面 140 / Android 142 都能过）',
      gecko.strict_min_version, GECKO_MIN_VERSION);
    ok('声明了不收集任何数据', gecko.data_collection_permissions.required, ['none']);
  }

  check('删掉了 key（Firefox 不认）', !m.key);
  check('删掉了 Chromium 专有的 favicon 权限',
    !(m.permissions || []).includes('favicon'));
  check('topSites 权限还在（Firefox 63+ 有）',
    (m.permissions || []).includes('topSites'));
  check('search 权限还在（Firefox 111+ 有）',
    (m.permissions || []).includes('search'));
  ok('快捷键换成了 L（Ctrl+Shift+K 在 Firefox 里是 Web 控制台）',
    m.commands['open-dashboard'].suggested_key.default, 'Ctrl+Shift+L');
  check('没有写 gecko_android（Android 版 Firefox 不支持抢新标签页）',
    !m.browser_specific_settings.gecko_android);
}

function assertZip(zipPath) {
  const out = execFileSync('unzip', ['-Z1', zipPath]).toString().split('\n').filter(Boolean);
  check('manifest.json 在包的根目录（套一层子目录就装不上）',
    out.includes('manifest.json'), out.slice(0, 6).join(' | '));
  check('包里没有 .DS_Store', !out.some(f => f.includes('.DS_Store')));
  check('包里没有 config.local.js', !out.some(f => f.includes('config.local.js')));
  check('字体也打进去了', out.filter(f => f.startsWith('fonts/')).length >= 7, true);
  return out.length;
}

/* ─── 主流程 ──────────────────────────────────────────────────────────── */

const base    = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
const version = base.version;

console.log(`归拢 ${version} —— 打包到 dist/`);
console.log('  Chrome 与 Edge 用同一个包（Edge 是 Chromium，chrome.* 全对齐）');
console.log('  Firefox 只改 manifest，代码一行不动（差异都在 extension/env.js 里）');

const targets = [
  { name: 'chrome',  manifest: chromiumManifest(base), assert: assertChromium },
  { name: 'edge',    manifest: chromiumManifest(base), assert: assertChromium },
  { name: 'firefox', manifest: firefoxManifest(base),  assert: assertFirefox  },
];

const made = [];
for (const t of targets) {
  const dir = stage(t.name, t.manifest);
  assertCommon(t.name, t.manifest, dir);
  t.assert(t.manifest);

  if (failed > 0) {
    console.log(`\n  有断言没过，${t.name} 包不打了 —— 宁可打不出来，也不打一个错的上去。`);
    break;
  }
  const zipPath = zip(t.name, dir, version);
  console.log(`\n[${t.name}] 包`);
  const n = assertZip(zipPath);
  made.push({ target: t.name, zipPath, files: n });
}

console.log('');
if (failed > 0) {
  console.log(`${failed} 条断言没过 —— 包不能上传。`);
  process.exit(1);
}
for (const m of made) {
  const kb = (fs.statSync(m.zipPath).size / 1024).toFixed(0);
  console.log(`  ${m.target.padEnd(8)} ${path.relative(ROOT, m.zipPath)}  （${m.files} 个文件，${kb} KB）`);
}
console.log('\n上传前：Firefox 那份记得再跑一次 npx web-ext lint dist/firefox（本机装不上，沙箱拦了 npm）。');
