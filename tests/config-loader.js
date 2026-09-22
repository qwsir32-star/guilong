const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../extension/config-loader.js'), 'utf8');
async function check(mode) {
  const scripts = [];
  let complete = false;
  const context = vm.createContext({
    chrome: { runtime: mode === 'unsupported' ? {} : {
      getPackageDirectoryEntry: callback => {
        if (mode === 'throws') throw new Error('unavailable');
        callback({ getFile: (name, options, yes, no) => {
          assert.equal(name, 'config.local.js');
          assert.equal(options.create, false);
          mode === 'missing' ? no() : yes();
        } });
      },
    } },
    document: { createElement: () => ({}), head: { appendChild: script => scripts.push(script) } },
  });
  vm.runInContext(source, context);
  context.GL_CONFIG_READY.then(() => { complete = true; });
  await Promise.resolve();
  if (mode === 'present' || mode === 'load-error') {
    assert.equal(complete, false, 'render waits for personal rules');
    assert.equal(scripts.length, 1);
    assert.equal(scripts[0].src, 'config.local.js');
    scripts[0][mode === 'present' ? 'onload' : 'onerror']();
  } else {
    assert.equal(scripts.length, 0, 'missing rules never create a network request');
  }
  await context.GL_CONFIG_READY;
  assert.equal(complete, true);
}
(async () => {
  for (const mode of ['missing', 'present', 'unsupported', 'throws', 'load-error']) await check(mode);
  console.log('Optional config loading: 5 scenarios passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
