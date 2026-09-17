/* ================================================================
   归拢 — 文案表（STRINGS）

   这里是**所有给用户看的字**的唯一来源。
   以前文案散在 app.js 的模板字符串和 index.html 里，改一处漏一处，
   想换个说法得全仓库搜。现在统一走这张表。

   ── 三条约定 ────────────────────────────────────────────────────
   1. **默认中文**（DEFAULT_LANG = 'zh'）。原版是英文，en 表原样保留，
      以后想做语言开关只要调 setLang() 就行。
   2. **zh / en 的 key 必须一一对应**。冒烟测试里有一条断言专门比两边的
      key 集合，少一条就报错 —— 不然翻译漏了谁也不会发现。
   3. **复数 / 变位一律整条模板做一个词目**，不要拆词再拼。
      例如 `badge.tabOpen` 和 `badge.tabsOpen` 是两条独立的词目，
      而不是「'tab' + (n!==1 ? 's' : '')」。拆开之后中文表英文表就没法
      各自表达自己的语序和量词，翻译必然出错。

   ── 怎么用 ──────────────────────────────────────────────────────
   带变量的：T('toast.batchSaved', { n: 3 })      → "已存入 3 个标签页"
   不带变量：T('pin.cancel')                      → "取消"
   HTML 静态文案：在标签上写 data-i18n="pin.cancel"，由 applyStaticStrings()
   在启动时填进去（详见 index.html 里的用法）。

   注意 `data-i18n-html` 会走 innerHTML。只在你**确实需要内嵌标签**
   （比如把数字套进 <strong>）时用它，而且模板里插进去的值必须是
   程序自己生成的数字/常量，绝不能是网页标题这种外部字符串。
   ================================================================ */

'use strict';

const DEFAULT_LANG = 'zh';

// 当前语言。以后要做设置项，改这个 + 重跑 applyStaticStrings() + 重画仪表盘即可。
let LANG = DEFAULT_LANG;

// 各语言对应的 Intl 区域标识 —— 日期格式化要用（见 app.js 的 getDateDisplay）
const LANG_LOCALES = {
  zh: 'zh-CN',
  en: 'en-US',
};

const STRINGS = {

  /* ============================ 中文 ============================ */
  zh: {

    /* ---- 问候语 / 日期 / 相对时间 ---- */
    'greeting.morning':        '早上好',
    'greeting.afternoon':      '下午好',
    'greeting.evening':        '晚上好',

    'time.justNow':            '刚刚',
    'time.minutesAgo':         '{n} 分钟前',
    'time.hourAgo':            '{n} 小时前',
    'time.hoursAgo':           '{n} 小时前',
    'time.yesterday':          '昨天',
    'time.daysAgo':            '{n} 天前',

    /* ---- 搜索框 ---- */
    'search.placeholder':      '搜索，或输入网址直接打开',

    /* ---- 设置面板（页头齿轮）---- */
    'settings.button':         '设置',
    'settings.title':          '设置',
    'settings.quickSites.name': '常用站点条',
    'settings.quickSites.desc': '把常用网站钉在这里，一点就到。关掉只是不显示，钉过的不会丢。',
    'settings.searchBox.name':  '搜索框',
    'settings.searchBox.desc':  '在新标签页直接输入关键词，用你设置的默认搜索引擎去搜。',

    /* ---- 快捷键（设置面板里那一行）
       注意这一行不是开关：Chrome 不允许扩展改自己的快捷键，
       所以只能「显示当前值 + 送你到 Chrome 的页面去改」。 */
    'settings.shortcut.name':   '呼出快捷键',
    'settings.shortcut.desc':   '按一下就打开归拢。Chrome 不允许扩展自己改快捷键，所以这里只能看 —— 点右边去 Chrome 的页面设一次，回到这里会自动更新。',
    'settings.shortcut.change': '去设置',
    'settings.shortcut.unset':  '未设置',

    /* ---- 按键名（只有空格需要翻译，字母数字照抄）---- */
    'key.space':                '空格',

    /* ---- 区块标题 ---- */
    'section.openTabs':        '打开的标签页',
    'section.savedForLater':   '稍后再看',
    'section.homepages':       '主页',
    'section.localFiles':      '本地文件',
    'footer.openTabs':         '打开的标签页',

    /* ---- 左上角那排统计小标签 ---- */
    'badge.tabOpen':           '{n} 个标签页',
    'badge.tabsOpen':          '{n} 个标签页',
    'badge.duplicate':         '{n} 个重复',
    'badge.duplicates':        '{n} 个重复',
    'badge.more':              '还有 {n} 个',
    'badge.domain':            '{n} 个站点',
    'badge.domains':           '{n} 个站点',
    'badge.tabsUnit':          '个',

    /* ---- 卡片上的动作按钮 ----
       「关闭全部 N 个」在卡片和顶部批量栏两处用同一条词目：
       两处的说法本来就该一致，拆成两条只会让以后改文案时漏掉一处。 */
    'action.closeAllTabsOne':  '关闭这 1 个标签页',
    'action.closeAllTabs':     '关闭全部 {n} 个',
    'action.closeDupes':       '关闭 {n} 个重复',
    'action.saveForLater':     '存入稍后再看',
    'action.closeThisTab':     '关闭这个标签页',
    'action.saveAll':          '全部存入',
    'action.saveAllAndClose':  '存入并关闭',

    /* ---- 稍后再看 ---- */
    'deferred.itemOne':        '{n} 条',
    'deferred.items':          '{n} 条',
    'deferred.empty':          '还没存东西，活在当下。',
    'deferred.dismiss':        '删掉这条',
    'deferred.openAll':        '全部打开 {n} 个',

    /* ---- 归档 ---- */
    'archive.toggle':          '归档',
    'archive.searchPlaceholder': '搜索归档…',
    'archive.noResults':       '没有匹配的条目',
    'archive.delete':          '从归档中删除',

    /* ---- 钉住表单 ---- */
    'pin.formTitleNew':        '钉住一个网站',
    'pin.formTitleEdit':       '编辑这个入口',
    'pin.hintEmpty':           '把常用网站钉在这里，以后一点就到',
    'pin.hintEdit':            '链接、名称、图标都能改。改了链接会把这一项指到新地址。',
    'pin.labelUrl':            '链接',
    'pin.labelName':           '名称',
    'pin.labelIcon':           '图标',
    'pin.urlPlaceholder':      'github.com，或粘贴完整链接',
    'pin.namePlaceholder':     '自动抓取，可改',
    'pin.iconPlaceholder':     '留空 = 自动；也可填图片地址，或 1-2 个字',
    'pin.cancel':              '取消',
    'pin.submitNew':           '钉住',
    'pin.submitEdit':          '保存',

    /* ---- 站点条上的小按钮（tooltip）---- */
    'pin.add':                 '钉住',
    'pin.addTitle':            '钉住一个网站',
    'pin.editTitle':           '编辑',
    'pin.pinTitle':            '钉住这个网站',
    'pin.unpinTitle':          '取消钉住',
    'pin.hideTitle':           '不再显示',
    'pin.openTooltip':         '{label} · 打开 {url}',

    /* ---- 表单里那行自动识别的说明 ---- */
    'pin.badUrl':              '网址看起来不太对',
    'pin.sourceRoot':          '识别为网站首页，名称和图标都是自动抓的',
    'pin.sourceTab':           '识别为具体页面，已用它的网页标题当名称',
    'pin.sourcePage':          '识别为具体页面，建议改个名字，免得看起来像首页',

    /* ---- 操作后的提示条 ---- */
    'toast.unpinned':          '已取消钉住',
    'toast.siteHidden':        '不再显示这个站点',
    'toast.alreadyPinned':     '这个入口已经钉住了',
    'toast.pinnedCanDrag':     '已钉住，现在可以拖动排序',
    'toast.alreadyListed':     '这个入口已经在上面了',
    'toast.itemGone':          '这一项已经不在了',
    'toast.saved':             '已保存',
    'toast.pinned':            '已钉住',
    'toast.reordered':         '已调整顺序',
    'toast.tabClosed':         '已关闭标签页',
    'toast.saveFailed':        '存入失败',
    'toast.savedForLater':     '已存入稍后再看',
    'toast.archivedDeleted':   '已从归档删除',
    'toast.noItemsToOpen':     '没有可打开的条目',
    'toast.openedInBackground':'已在后台打开 {n} 个标签页',
    'toast.batchSaveFailed':   '批量存入失败',
    'toast.batchAllSkipped':   '这些页面都已经在稍后再看里了',
    'toast.nothingToSave':     '没有可存入的标签页',
    'toast.batchSavedAndClosed': '已存入 {added} 个、关闭 {closed} 个标签页',
    'toast.batchSaved':        '已存入 {n} 个标签页',
    'toast.batchSkipped':      '，跳过 {n} 个重复',
    'toast.closedFromOne':     '已关闭 {group} 的 1 个标签页',
    'toast.closedFrom':        '已关闭 {group} 的 {n} 个标签页',
    'toast.deduped':           '重复的只留了一个',
    'toast.confirmCloseAll':   '确认关闭 {n} 个标签页？再点一次',
    'toast.closedAll':         '已关闭 {n} 个标签页',
    'toast.closedExtras':      '已关掉多余的归拢标签页',
    'toast.shortcutUnavailable': '没能打开 Chrome 的快捷键页面，请在地址栏手动输入 chrome://extensions/shortcuts',

    /* ---- 「你开了好几个归拢」横幅。{count} 会被套进 <strong>，见 dupeBanner 的注释 ---- */
    'dupeBanner.text':         '你现在开着 <strong>{count}</strong> 个归拢标签页，只留当前这一个？',
    'dupeBanner.action':       '关掉多余的',
  },

  /* ============================ English ============================
     原版文案尽量原样保留（"Saved for later"、"Nothing saved. Living in
     the moment." 等），这样切回英文时观感和上游一致。 */
  en: {

    'greeting.morning':        'Good morning',
    'greeting.afternoon':      'Good afternoon',
    'greeting.evening':        'Good evening',

    'time.justNow':            'just now',
    'time.minutesAgo':         '{n} min ago',
    'time.hourAgo':            '{n} hr ago',
    'time.hoursAgo':           '{n} hrs ago',
    'time.yesterday':          'yesterday',
    'time.daysAgo':            '{n} days ago',

    'search.placeholder':      'Search, or type a URL to open it',

    'settings.button':         'Settings',
    'settings.title':          'Settings',
    'settings.quickSites.name': 'Quick sites bar',
    'settings.quickSites.desc': 'Pin the sites you use most. Turning this off only hides the bar — nothing you pinned is lost.',
    'settings.searchBox.name':  'Search box',
    'settings.searchBox.desc':  'Search straight from the new tab, using your own default search engine.',

    'settings.shortcut.name':   'Open shortcut',
    'settings.shortcut.desc':   "Opens Guilong in one keystroke. Chrome doesn't let an extension change its own shortcut, so this is read-only — click through to Chrome's page to set one; it updates here when you come back.",
    'settings.shortcut.change': 'Set it',
    'settings.shortcut.unset':  'Not set',

    'key.space':                'Space',

    'section.openTabs':        'Open tabs',
    'section.savedForLater':   'Saved for later',
    'section.homepages':       'Homepages',
    'section.localFiles':      'Local files',
    'footer.openTabs':         'Open tabs',

    'badge.tabOpen':           '{n} tab open',
    'badge.tabsOpen':          '{n} tabs open',
    'badge.duplicate':         '{n} duplicate',
    'badge.duplicates':        '{n} duplicates',
    'badge.more':              '+{n} more',
    'badge.domain':            '{n} domain',
    'badge.domains':           '{n} domains',
    'badge.tabsUnit':          'tabs',

    'action.closeAllTabsOne':  'Close this 1 tab',
    'action.closeAllTabs':     'Close all {n} tabs',
    'action.closeDupes':       'Close {n} duplicates',
    'action.saveForLater':     'Save for later',
    'action.closeThisTab':     'Close this tab',
    'action.saveAll':          'Save all',
    'action.saveAllAndClose':  'Save all and close',

    'deferred.itemOne':        '{n} item',
    'deferred.items':          '{n} items',
    'deferred.empty':          'Nothing saved. Living in the moment.',
    'deferred.dismiss':        'Dismiss',
    'deferred.openAll':        'Open all {n}',

    'archive.toggle':          'Archive',
    'archive.searchPlaceholder': 'Search archived tabs…',
    'archive.noResults':       'No results',
    'archive.delete':          'Delete from archive',

    'pin.formTitleNew':        'Pin a site',
    'pin.formTitleEdit':       'Edit this entry',
    'pin.hintEmpty':           'Pin the sites you use most — one click to get there',
    'pin.hintEdit':            'Link, name, and icon are all editable. Changing the link points this entry somewhere new.',
    'pin.labelUrl':            'Link',
    'pin.labelName':           'Name',
    'pin.labelIcon':           'Icon',
    'pin.urlPlaceholder':      'github.com, or paste a full URL',
    'pin.namePlaceholder':     'Fetched automatically — editable',
    'pin.iconPlaceholder':     'Blank = automatic; or an image URL, or 1–2 characters',
    'pin.cancel':              'Cancel',
    'pin.submitNew':           'Pin',
    'pin.submitEdit':          'Save',

    'pin.add':                 'Pin',
    'pin.addTitle':            'Pin a site',
    'pin.editTitle':           'Edit',
    'pin.pinTitle':            'Pin this site',
    'pin.unpinTitle':          'Unpin',
    'pin.hideTitle':           'Hide',
    'pin.openTooltip':         '{label} · open {url}',

    'pin.badUrl':              "That doesn't look like a URL",
    'pin.sourceRoot':          'Detected the site homepage — name and icon were fetched automatically',
    'pin.sourceTab':           'Detected a specific page — used its page title as the name',
    'pin.sourcePage':          "Detected a specific page — consider renaming it so it doesn't look like the homepage",

    'toast.unpinned':          'Unpinned',
    'toast.siteHidden':        'Site hidden',
    'toast.alreadyPinned':     'That entry is already pinned',
    'toast.pinnedCanDrag':     'Pinned — you can now drag to reorder',
    'toast.alreadyListed':     'That entry is already in the list',
    'toast.itemGone':          'That item is gone',
    'toast.saved':             'Saved',
    'toast.pinned':            'Pinned',
    'toast.reordered':         'Order updated',
    'toast.tabClosed':         'Tab closed',
    'toast.saveFailed':        'Failed to save tab',
    'toast.savedForLater':     'Saved for later',
    'toast.archivedDeleted':   'Deleted from archive',
    'toast.noItemsToOpen':     'Nothing to open',
    'toast.openedInBackground':'Opened {n} tabs in the background',
    'toast.batchSaveFailed':   'Could not save tabs',
    'toast.batchAllSkipped':   'Those tabs are already saved for later',
    'toast.nothingToSave':     'No tabs to save',
    'toast.batchSavedAndClosed': 'Saved {added} and closed {closed} tabs',
    'toast.batchSaved':        'Saved {n} tabs',
    'toast.batchSkipped':      ', skipped {n} duplicates',
    'toast.closedFromOne':     'Closed 1 tab from {group}',
    'toast.closedFrom':        'Closed {n} tabs from {group}',
    'toast.deduped':           'Closed duplicates, kept one copy each',
    'toast.confirmCloseAll':   'Close {n} tabs? Click again to confirm',
    'toast.closedAll':         'Closed {n} tabs',
    'toast.closedExtras':      'Closed extra Guilong tabs',
    'toast.shortcutUnavailable': "Couldn't open Chrome's shortcuts page — type chrome://extensions/shortcuts in the address bar",

    'dupeBanner.text':         'You have <strong>{count}</strong> Guilong tabs open. Keep just this one?',
    'dupeBanner.action':       'Close extras',
  },
};


/* ----------------------------------------------------------------
   取词
   ---------------------------------------------------------------- */

/**
 * T(key, vars) — 取一条文案
 *
 * 取不到时**不抛错**，退回中文表；中文表也没有就原样返回 key。
 * 这样少写一条词目最多是显示成 `toast.xxx` 这种丑样子，
 * 不会让整个页面白屏 —— 文案缺失不该是致命的。
 *
 * @param {string} key          词目名，如 'toast.batchSaved'
 * @param {object} [vars]       占位符，如 { n: 3 } 对应模板里的 {n}
 */
function T(key, vars) {
  const table = STRINGS[LANG] || STRINGS[DEFAULT_LANG];
  const fallback = STRINGS[DEFAULT_LANG] || {};
  const raw = (key in table) ? table[key]
            : (key in fallback) ? fallback[key]
            : key;
  if (!vars || typeof raw !== 'string') return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m);
}

/** 复数选择的语法糖：把「1 个 / N 个」这种二选一写得短一点 */
function Tn(keyOne, keyMany, n, vars) {
  return T(n !== 1 ? keyMany : keyOne, Object.assign({ n }, vars));
}

/** setLang(lang) — 切语言。未知语言直接忽略，不会把界面搞成空白 */
function setLang(lang) {
  if (STRINGS[lang]) LANG = lang;
}

/** 当前语言对应的 Intl 标识（日期格式化用） */
function localeOf() {
  return LANG_LOCALES[LANG] || LANG_LOCALES[DEFAULT_LANG];
}


/* ----------------------------------------------------------------
   把静态文案填进 DOM
   ---------------------------------------------------------------- */

/**
 * applyStaticStrings(root) — 填充 index.html 里带 data-i18n* 的元素
 *
 * 四种写法：
 *   data-i18n="key"               → textContent（最常用，最安全）
 *   data-i18n-html="key"          → innerHTML（模板里要内嵌 <strong> 之类才用，
 *                                    见 dupeBanner 那段注释，注意注入风险）
 *   data-i18n-placeholder="key"   → placeholder 属性（输入框）
 *   data-i18n-title="key"         → title 属性（tooltip）
 *
 * 同时把 <html lang> 改成当前语言，屏幕阅读器和浏览器的断行规则会跟着变。
 */
function applyStaticStrings(root) {
  const scope = root || document;
  if (scope === document && document.documentElement) {
    // 写完整区域标识（zh-CN / en-US）而不是光秃秃的 'zh'：
    // 浏览器的断行、标点挤压、字体回退都是按这个挑规则的，'zh' 太含糊。
    document.documentElement.lang = localeOf();
  }

  scope.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = T(el.dataset.i18n);
  });
  scope.querySelectorAll('[data-i18n-html]').forEach(el => {
    el.innerHTML = T(el.dataset.i18nHtml);
  });
  scope.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = T(el.dataset.i18nPlaceholder);
  });
  scope.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = T(el.dataset.i18nTitle);
  });
}
