/* 天气功能的变异测试。
   每条新守卫都要证明它「坏掉时会变红」—— 一条永远不会失败的断言不是守卫，
   只是装饰。做法：把仓库复制到 /tmp 再改，**绝不碰真实仓库**。
   跑法：node tests/mutations/weather.js */
const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = path.join(__dirname, '..', '..');
const WORK = '/tmp/guilong-mut';
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
  { n: '默认值里删掉 showWeather', f: 'extension/app.js',
    from: '  showWeather:    true,   // 当地天气（默认地点见 DEFAULT_WEATHER_LOCATION）\n', to: '' },

  { n: 'weatherShouldShow 不再看「画过没有」', f: 'extension/app.js',
    from: "return !!(prefs && prefs.showWeather && ready === '1');",
    to:   'return !!(prefs && prefs.showWeather);' },

  { n: '缓存整好到期时当新鲜（< 改成 <=）', f: 'extension/app.js',
    from: 'return age >= 0 && age < WEATHER_TTL_MS;',
    to:   'return age >= 0 && age <= WEATHER_TTL_MS;' },

  { n: '缓存不看时间倒流', f: 'extension/app.js',
    from: 'return age >= 0 && age < WEATHER_TTL_MS;',
    to:   'return age < WEATHER_TTL_MS;' },

  { n: '温度接受字符串', f: 'extension/app.js',
    from: "  if (typeof value !== 'number' || !Number.isFinite(value)) return '';",
    to:   "  if (!Number.isFinite(Number(value))) return '';" },

  { n: '实况温度不做类型检查', f: 'extension/app.js',
    from: "  if (!cur || typeof cur.temperature_2m !== 'number' || !Number.isFinite(cur.temperature_2m)) return null;",
    to:   '  if (!cur) return null;' },

  { n: '城市名不转义', f: 'extension/app.js',
    from: '${escapeAttr(p.name)}', to: '${p.name}' },

  /* ---- 本地城市搜索（#24 之后，搜索不打网络） ---- */
  { n: '搜索不按「以关键词开头」优先', f: 'extension/app.js',
    from: '    if (aHead !== bHead) return aHead - bHead;',
    to:   '    if (aHead !== bHead) return bHead - aHead;' },

  { n: '搜索结果不限条数（面板会被撑长）', f: 'extension/app.js',
    from: '  return hits.slice(0, WEATHER_PLACE_SHOW);',
    to:   '  return hits;' },

  { n: '省条目不报省会', f: 'extension/app.js',
    from: "  if (place.capital)     return T('weather.capital', { city: place.capital });",
    to:   '  if (false)               return place.capital;' },

  { n: '城市库里青岛市被改名（生成的数据坏了）', f: 'extension/china-places.js',
    from: '{"n":"青岛市"', to: '{"n":"青岛村"' },

  { n: '省条目用了几何中心而不是省会坐标', f: 'extension/china-places.js',
    from: '{"n":"山东省","la":36.675807,"lo":117.000923',
    to:   '{"n":"山东省","la":36.0,"lo":118.0' },

  { n: 'china-places.js 挪到 app.js 之后加载', f: 'extension/index.html',
    from: '<script src="china-places.js"></script>\n\n<!-- Main dashboard logic — loads last so the DOM is ready -->\n<script src="app.js"></script>',
    to:   '<!-- Main dashboard logic — loads last so the DOM is ready -->\n<script src="app.js"></script>\n<script src="china-places.js"></script>' },

  { n: '认不出的天气码没有兜底图标', f: 'extension/app.js',
    from: "  return WEATHER_ICONS[(def && def.icon) || 'cloud'] || WEATHER_ICONS.cloud;",
    to:   '  return WEATHER_ICONS[def && def.icon];' },

  { n: '换城市时不丢旧缓存', f: 'extension/app.js',
    from: '    await chrome.storage.local.remove(WEATHER_CACHE_KEY);',
    to:   '    // (变异) 故意不丢缓存' },

  { n: 'renderWeather 里加一条 toast', f: 'extension/app.js',
    from: "    console.warn('[guilong] 天气渲染失败:', err);",
    to:   "    console.warn('[guilong] 天气渲染失败:', err);\n    showToast('x');" },

  { n: '天气条挪进页头网格里', f: 'extension/index.html',
    from: '  </header>',
    to:   '    <div class="weather" id="weather" style="display:none"></div>\n  </header>' },

  { n: 'manifest 里加上 host_permissions', f: 'extension/manifest.json',
    from: '  "permissions": ["tabs", "activeTab", "storage", "topSites", "favicon", "search"],',
    to:   '  "permissions": ["tabs", "activeTab", "storage", "topSites", "favicon", "search"],\n  "host_permissions": ["https://api.open-meteo.com/*"],' },

  { n: '设置面板分隔线换回 + 选择器', f: 'extension/style.css',
    from: '.setting-row ~ .setting-row {', to: '.setting-row + .setting-row {' },

  { n: '城市搜索结果挪进城市行里面', f: 'extension/index.html',
    from: '              data-i18n="settings.weatherPlace.search"></button>\n    </div>\n    <div class="weather-results" id="weatherResults" style="display:none"></div>',
    to:   '              data-i18n="settings.weatherPlace.search"></button>\n    <div class="weather-results" id="weatherResults" style="display:none"></div>\n    </div>' },
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
