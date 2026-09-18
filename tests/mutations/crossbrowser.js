/* 「跨浏览器」的变异测试。
   每条新守卫都要证明它「坏掉时会变红」—— 一条永远不会失败的断言不是守卫，
   只是装饰。做法：把仓库复制到 /tmp 再改，**绝不碰真实仓库**。
   跑法：node tests/mutations/crossbrowser.js */
const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = path.join(__dirname, '..', '..');
const WORK = '/tmp/guilong-crossbrowser-mut';
const NODE = process.execPath;

function copyRepo() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
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

/* 每条变异是若干组 [文件名, from, to]。锚点必须唯一 —— 出现次数不对的
   那条会报 ?? ，那是「没测到」，不是「通过了」。 */
const MUTATIONS = [
  /* ---- env.js：判定本身 ---- */
  { n: '永远认成 Chromium（Firefox 用户拿到 Chrome 的地址）',
    pairs: [['extension/env.js', "var isFirefox = /Firefox|FxiOS/.test(ua || '');", 'var isFirefox = false;']] },

  { n: 'Firefox 的新标签页地址写成 chrome://newtab/',
    pairs: [['extension/env.js', "        ? ['about:newtab', 'about:home']", "        ? ['chrome://newtab/', 'edge://newtab/']"]] },

  { n: 'Firefox 改快捷键也跳 chrome://extensions/shortcuts',
    pairs: [['extension/env.js',
      "      shortcutsUrl: isFirefox\n        ? 'about:addons'\n        : 'chrome://extensions/shortcuts',",
      "      shortcutsUrl: 'chrome://extensions/shortcuts',"]] },

  { n: '假装 Firefox 也有 _favicon 端点',
    pairs: [['extension/env.js', 'hasFaviconEndpoint: !isFirefox,', 'hasFaviconEndpoint: true,']] },

  /* ---- env.js：内部页清单 ---- */
  { n: '内部页清单里漏掉 moz-extension://（角标会把 Firefox 扩展页数进去）',
    pairs: [['extension/env.js',
      "    'chrome-extension://', 'moz-extension://', 'edge-extension://',",
      "    'chrome-extension://', 'edge-extension://',"]] },

  { n: '内部页清单里漏掉 about:（about:newtab 会被当成真网页）',
    pairs: [['extension/env.js', "    'about:',\n", '']] },

  { n: 'isInternalUrl 永远返回 false',
    pairs: [['extension/env.js',
      '      if (u.indexOf(INTERNAL_PREFIXES[i]) === 0) return true;',
      '      if (false) return true;']] },

  /* ---- app.js：favicon ---- */
  { n: 'faviconUrlFor 不看 hasFaviconEndpoint（Firefox 上发出必然失败的请求）',
    pairs: [['extension/app.js',
      "  if (!envOf().hasFaviconEndpoint) return '';\n  return chrome.runtime.getURL(",
      '  return chrome.runtime.getURL(']] },

  { n: 'faviconUrlFor 写死 chrome-extension://（Firefox 上全部取不到图标）',
    pairs: [['extension/app.js',
      '  return chrome.runtime.getURL(`_favicon/?pageUrl=${encodeURIComponent(url)}&size=${size}`);',
      '  return `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(url)}&size=${size}`;']] },

  { n: 'getDefaultFaviconSignature 不再认 hasFaviconEndpoint',
    pairs: [['extension/app.js',
      "    defaultFaviconSig = envOf().hasFaviconEndpoint\n      ? faviconSignature(faviconUrlFor(DEFAULT_FAVICON_PROBE, 32))\n      : Promise.resolve(null);",
      '    defaultFaviconSig = faviconSignature(faviconUrlFor(DEFAULT_FAVICON_PROBE, 32));']] },

  /* ---- app.js：地址与兜底 ---- */
  { n: 'SHORTCUTS_URL 写死回 chrome://extensions/shortcuts',
    pairs: [['extension/app.js',
      'const SHORTCUTS_URL = envOf().shortcutsUrl;',
      "const SHORTCUTS_URL = 'chrome://extensions/shortcuts';"]] },

  { n: 'envOf() 的兜底跟 env.js 算出来的值不一致（两套行为）',
    pairs: [['extension/app.js',
      "browserNewtabUrls: ['chrome://newtab/', 'edge://newtab/'], shortcutsUrl:",
      "browserNewtabUrls: ['chrome://newtab/'], shortcutsUrl:"]] },

  { n: 'getRealTabs 改回手写 chrome:// 前缀判断（漏掉 Firefox）',
    pairs: [['extension/app.js',
      "  const isInternal = envOf().isInternalUrl;\n  return openTabs.filter(t => !isInternal(t.url));",
      "  return openTabs.filter(t => !(t.url || '').startsWith('chrome://'));"]] },

  /* ---- background.js ---- */
  { n: 'background.js 不再自己拉 env.js（Chrome 的 service worker 拿不到 GL_ENV）',
    pairs: [['extension/background.js',
      "if (typeof globalThis.GL_ENV === 'undefined' && typeof importScripts === 'function') {\n  importScripts('./env.js');\n}",
      '']] },

  { n: 'updateBadge 改回手写 chrome:// 前缀判断（Firefox 会把内部页数进去）',
    pairs: [['extension/background.js',
      "    const isInternal = bgEnv().isInternalUrl;\n\n    // Only count actual web pages — skip browser internals and extension pages\n    const count = tabs.filter(t => !isInternal(t.url)).length;",
      "    const count = tabs.filter(t => !(t.url || '').startsWith('chrome://')).length;"]] },

  { n: 'focusOrOpenDashboard 写死回 chrome://newtab/',
    pairs: [['extension/background.js',
      '  const existing = tabs.find(t => t.url === dashboardUrl || newtabs.indexOf(t.url) !== -1);',
      "  const existing = tabs.find(t => t.url === dashboardUrl || t.url === 'chrome://newtab/');"]] },

  /* ---- index.html ---- */
  { n: '忘了把 env.js 引进页面',
    pairs: [['extension/index.html', '<script src="env.js"></script>\n\n', '']] },

  { n: 'env.js 排到了 app.js 后面（app.js 顶层就已经要用它了）',
    pairs: [
      ['extension/index.html', '<script src="env.js"></script>\n\n', ''],
      ['extension/index.html', '<script src="app.js"></script>\n</body>',
        '<script src="app.js"></script>\n<script src="env.js"></script>\n</body>'],
    ] },

  /* ---- 文案 ---- */
  { n: '文案里写死 chrome://extensions/shortcuts（Firefox 上是错的）',
    pairs: [['extension/strings.js',
      "    'toast.shortcutUnavailable': '没能打开快捷键设置页，请在地址栏手动输入 {url}',",
      "    'toast.shortcutUnavailable': '没能打开快捷键设置页，请在地址栏手动输入 chrome://extensions/shortcuts',"]] },
];

copyRepo();
const base = runSmoke();
console.log('基线（未变异）：' + (base.code === 0 ? '全绿 ✓' : '红 ✗ 基线就是坏的，后面的结论不可信'));
if (base.code !== 0) {
  console.log(base.out.split('\n').filter(l => l.includes('FAIL')).join('\n'));
  process.exit(1);
}

let bad = 0;
console.log('');
for (const m of MUTATIONS) {
  copyRepo();
  let skipped = false;
  for (const [f, from, to] of m.pairs) {
    const p   = path.join(WORK, f);
    const src = fs.readFileSync(p, 'utf8');
    const hits = src.split(from).length - 1;
    if (hits !== 1) {
      console.log(`  ??  ${m.n} —— 「${from.slice(0, 40)}…」出现 ${hits} 次（要求 1 次），这条没测到`);
      bad++; skipped = true;
      break;
    }
    fs.writeFileSync(p, src.split(from).join(to));
  }
  if (skipped) continue;

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
