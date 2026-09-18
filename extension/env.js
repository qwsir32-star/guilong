/**
 * env.js — 浏览器环境判定
 *
 * 归拢要同时跑在 Chrome / Edge / Firefox 上。三家绝大部分 API 是一样的
 * （都走 `chrome.*`，Firefox 把 `chrome` 当 `browser` 的别名），真正不同的
 * 只有下面这几件小事。把差异**全部收在这一个文件里**，别的地方不许再写
 * `navigator.userAgent`、不许再硬编码 `chrome://` 开头的地址 —— 散着写的话，
 * 加一个浏览器就要全仓搜一遍。
 *
 * 使用时读 `GL_ENV.xxx`。冒烟测试的沙箱里没有 navigator，也没加载本文件，
 * 所以 app.js / background.js 里都走 `envOf()` 拿——拿不到就按 Chromium 处理，
 * 那正是测试要验的那条路。
 */

(function (root) {
  'use strict';

  /**
   * makeEnv(ua) — 由 UA 串算出这一台浏览器的一切差异
   *
   * 抽成「吃 UA 字符串」的纯函数是为了可测：真机是 Firefox 还是 Chrome 造
   * 不出来，但 UA 串可以随便喂（tests/smoke.js 里直接喂 Firefox 的 UA 断言）。
   */
  function makeEnv(ua) {
    var isFirefox = /Firefox|FxiOS/.test(ua || '');

    return {
      isFirefox: isFirefox,

      /**
       * 浏览器**自带**的新标签页地址。扩展自己的那张（index.html）不算在内，
       * 它要用 chrome.runtime.getURL() 现算 —— Firefox 上是 moz-extension://，
       * 写死 chrome-extension:// 就永远匹配不上。
       */
      browserNewtabUrls: isFirefox
        ? ['about:newtab', 'about:home']
        : ['chrome://newtab/', 'edge://newtab/'],

      /**
       * 改快捷键的页面。Firefox 没有直达地址，只能进 about:addons 让用户自己找
       * （而且 Firefox 其实支持 commands.update()，只是我们没走那条路）。
       */
      shortcutsUrl: isFirefox
        ? 'about:addons'
        : 'chrome://extensions/shortcuts',

      /**
       * 有没有 _favicon 端点。
       *
       * ⚠️ 这是唯一一处**功能**差异，不是地址差异：_favicon 是 Chromium 专有的，
       * Firefox 没有等价物（Mozilla 没打算补）。所以 Firefox 上常用站点的自动
       * 图标一律不建 <img>，直接露首字母色块 —— 宁可朴素，也不要为了一张图
       * 去访问站点自己的服务器（那会把「唯一联网的是天气」这句话戳破）。
       */
      hasFaviconEndpoint: !isFirefox,
    };
  }

  /**
   * 浏览器内部页的前缀 —— 这些不算「真实网页」：角标不计数、不进标签页列表。
   *
   * `about:` 一并盖住了 about:blank / about:newtab / about:home / about:addons。
   * 三家浏览器的扩展页后缀不同（chrome-extension / moz-extension），全列上。
   */
  var INTERNAL_PREFIXES = [
    'about:',
    'chrome://', 'edge://', 'brave://', 'opera://', 'vivaldi://',
    'chrome-extension://', 'moz-extension://', 'edge-extension://',
  ];

  /** isInternalUrl(url) — 是不是浏览器内部页 */
  function isInternalUrl(url) {
    var u = String(url || '');
    for (var i = 0; i < INTERNAL_PREFIXES.length; i += 1) {
      if (u.indexOf(INTERNAL_PREFIXES[i]) === 0) return true;
    }
    return false;
  }

  var ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';

  var env = makeEnv(ua);
  env.makeEnv = makeEnv;
  env.isInternalUrl = isInternalUrl;
  env.INTERNAL_PREFIXES = INTERNAL_PREFIXES;

  root.GL_ENV = env;
}(typeof globalThis !== 'undefined' ? globalThis : this));
