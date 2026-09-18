/* ================================================================
   归拢 —— 主题预加载

   这个文件只干一件事：**在页面画出第一帧之前把主题定下来。**

   为什么要有单独一个文件
   ──────────────────────
   主题存在 chrome.storage.local 里，但那个 API 是**异步**的。等 app.js
   读到它再写 <html data-theme>，浏览器早就把默认的米白纸面画出来了 ——
   深色主题下每开一个新标签页都会闪一下白底。这是深色模式最招骂的毛病，
   而且只在真机上出现，看代码看不出来。

   所以这里走 **localStorage**：它是同步的，放在 <head> 里就能在渲染前跑完。
   app.js 每次改主题时会往两边都写一次（见 mirrorTheme），chrome.storage
   是正主，localStorage 只是给这里预读用的镜像。

   ⚠️ 两个约束
   ──────────────────────
   1. **必须放在 <head> 里、style.css 之后**。放到 body 末尾就等于没有。
   2. **不写内联 script**。MV3 的 CSP 是 script-src 'self'，内联脚本一律
      不执行（还会在控制台刷一条拒绝执行的报错）。
   ================================================================ */

(function () {
  // 必须和 app.js 的 THEME_IDS 一一对应 —— 冒烟测试里有断言盯着这两份清单。
  // 少一个的话，那个主题在预加载阶段会被当成不认识的值退回默认，
  // 表现是「选中了深色，开新标签页还是先白一下，然后才变深」。
  var THEME_IDS = ['paper', 'light', 'dark', 'forest', 'ink'];
  var DARK_IDS  = ['dark', 'forest', 'ink'];
  var MIRROR_KEY = 'guilong.theme';
  var FALLBACK   = 'paper';

  var pref = FALLBACK;
  try {
    pref = localStorage.getItem(MIRROR_KEY) || FALLBACK;
  } catch (err) {
    // 读不到（隐私模式 / 存储被禁）就按默认来，不值得为它报错
    pref = FALLBACK;
  }

  // 「跟随系统」在这个阶段就要解析成具体的一个主题 —— CSS 里没有 system 这一套
  var id = pref;
  if (pref === 'system') {
    var dark = false;
    try {
      dark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch (err) {
      dark = false;
    }
    id = dark ? 'dark' : 'light';
  }

  if (THEME_IDS.indexOf(id) === -1) id = FALLBACK;

  var root = document.documentElement;
  root.dataset.theme = id;
  // 让滚动条、下拉框这些原生控件也跟着走，不然深色主题会挂一条亮滚动条
  root.style.colorScheme = DARK_IDS.indexOf(id) === -1 ? 'light' : 'dark';
})();
