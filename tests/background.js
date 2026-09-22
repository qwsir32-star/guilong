// 零依赖后台行为测试：在真实事件入口上控制异步查询，复现批量操作。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function main() {
  const listeners = {};
  const event = name => ({ addListener: fn => { listeners[name] = fn; } });
  const queries = [];
  const badges = [];
  const colors = [];
  let rejectWrites = false;
  const chrome = {
    tabs: {
      query: () => new Promise((resolve, reject) => queries.push({ resolve, reject })),
      onCreated: event('created'), onRemoved: event('removed'),
      onUpdated: event('updated'), onReplaced: event('replaced'),
    },
    action: {
      onClicked: event('clicked'),
      setBadgeText: async ({ text }) => {
        if (rejectWrites) throw new Error('Browser shutting down');
        badges.push(text);
      },
      setBadgeBackgroundColor: async ({ color }) => { colors.push(color); },
    },
    runtime: { onInstalled: event('installed'), onStartup: event('startup') },
    commands: { onCommand: event('command') },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8'), { chrome });
  assert.equal(queries.length, 1, '启动时立即刷新');
  for (let i = 0; i < 100; i++) listeners.removed(i);
  assert.equal(queries.length, 1, '批量关闭期间只有一条在途查询');
  queries[0].resolve([{ url: 'https://example.org' }, { url: 'chrome://settings/' }]);
  await tick();
  assert.equal(queries.length, 2, '批量事件合并成一次后续刷新');
  queries[1].resolve([]);
  await tick();
  assert.deepEqual(badges, ['1', ''], '最终显示最新计数，内部页不计入');
  assert.deepEqual(colors, ['#3d7a4a']);
  for (const info of [{ status: 'loading' }, { title: 'New title' }, { favIconUrl: 'icon' }]) {
    listeners.updated(1, info);
  }
  assert.equal(queries.length, 2, '无关属性更新不触发全量查询');
  listeners.updated(1, { url: 'https://example.org/new' });
  assert.equal(queries.length, 3, 'URL 变化触发刷新');
  queries[2].resolve(Array.from({ length: 11 }, () => ({ url: 'https://example.org' })));
  await tick();
  assert.equal(colors.at(-1), '#b8892e');
  listeners.replaced(2, 1);
  queries[3].resolve(Array.from({ length: 21 }, () => ({ url: 'https://example.org' })));
  await tick();
  assert.equal(colors.at(-1), '#b35a5a', '替换标签页时也刷新');
  listeners.created({});
  queries[4].reject(new Error('Query failed'));
  await tick();
  assert.equal(badges.at(-1), '', '查询失败清除旧计数');
  rejectWrites = true;
  listeners.removed(1);
  queries[5].resolve([]);
  await tick();
  rejectWrites = false;
  listeners.created({});
  queries[6].resolve([{ url: 'https://example.org' }]);
  await tick();
  assert.equal(badges.at(-1), '1', '写入失败后下一次事件仍能恢复');
  console.log('后台事件回归全部通过（批量合并、URL 过滤、替换、颜色和错误恢复）');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
