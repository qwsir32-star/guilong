<p align="center">
  <img src="extension/icons/icon128.png" width="96" alt="归拢">
</p>

<h1 align="center">归拢</h1>

<p align="center"><strong>散着的标签页，归拢一下。</strong></p>

<p align="center">一个可视化的多标签页管理扩展 · Chrome / Edge / Firefox · 零依赖 · 不收集数据</p>

---

归拢是一个浏览器扩展，它接管你的**新标签页**，把它换成一张可视化总览面板：此刻开着的所有标签页，按域名摆成一张网格。哪个站开了多少个、哪些其实开重了、哪些只是「先放着回头再看」—— 一眼扫完。

- **找东西不用一个个点** —— 几十个标签页摊在一张图上、按站点分组，扫一眼就知道东西在哪
- **关闭不用挨个确认** —— 同一个站的标签页收在一张卡里，整组一次关干净，带音效和彩带
- **关闭不再等于丢失** —— 舍不得关的先存进「稍后再看」，处理完归档，之后还能搜回来、还原回来

一切从简，一切可定义：常用站点条、搜索框、天气都能单独关掉，主题色八套可选，界面中英双语。

<!-- 截图：等真机截图后放这儿（默认主题 + 深色主题 + 设置面板各一张） -->

## 为什么做这个

标签页开多了一定会变成负担：

- 想找的那个混在几十个标签里，**只能一个个点过去找**；
- 明知道一半用不上了，**也不敢关** —— 万一等会儿还要看；
- 资料查到一半，**浏览器就不能关了**，关掉等于丢掉。

归拢把这三件事一起解决：**摊开看清、整组关掉、关之前先存下来。**

## 安装

**从商店装**（Chrome / Edge / Firefox 三家都上了之后，链接会放在这里）

**从源码加载**：

```bash
git clone https://github.com/qwsir32-star/guilong.git
```

1. Chrome / Edge：打开 `chrome://extensions`（Edge 是 `edge://extensions`），开**开发者模式** → **加载已解压的扩展程序** → 选 `extension/` 文件夹
2. Firefox：先跑 `node tools/build-store.js`，再打开 `about:debugging#/runtime/this-firefox` → **载入临时扩展** → 选 **`dist/firefox/manifest.json`**
3. 开一个新标签页

> ⚠️ Firefox 不要选 `extension/manifest.json` —— 那份是 Chromium 的，Firefox 不认
> `background.service_worker`（它跑 `background.scripts`），塞给它后台根本不启动：
> 页面看着正常，但角标不动、快捷键无效。完整说明见 [Firefox 安装指南](docs/firefox-安装指南.md)。

> 改完代码只点扩展卡片上的刷新**不一定生效**：新标签页有缓存，要**关掉旧的新标签页重新开一个**。

## 功能

| 功能 | 说明 |
|---|---|
| **按域名分组** | 打开的标签页按站点收进卡片，网格排开，一眼看尽 |
| **主页单独成组** | Gmail 收件箱、X 首页、YouTube、GitHub 主页收成一张卡，一次关干净 |
| **重复检测** | 同一个页面开了两遍会被标出来，可一键清理 |
| **点标题就跳** | 点任意标签页标题直接跳过去，跨窗口也行，不会多开一个 |
| **本地项目分组** | `localhost` 后面显示端口号，几个项目分得清 |
| **关得爽** | 关闭时合成音效 + 粒子彩带 |
| **稍后再看** | 关之前先把想留的存进清单；处理完的归档，之后还能搜回来、还原回来 |
| **常用站点条** | 常去的站点钉在顶部，可按住拖动排序，一点就到（可关） |
| **搜索框** | 输入网址就直接打开，否则交给你自己设的默认搜索引擎（可关） |
| **当地天气** | 页头下面一行：图标 + 气温 + 城市 + 今天的最高最低（可关） |
| **主题色** | 八套可选，含跟随系统 |
| **呼出快捷键** | 默认 `⌘⇧K` / `Ctrl+Shift+K`，设置面板里能看到当前绑定 |
| **工具栏图标** | 点一下把仪表盘叫出来；角标显示标签页数，绿 / 黄 / 红三档 |
| **中英双语** | 默认中文，全部界面文案集中在 `strings.js` 一张表里 |
| **字体随包走** | DM Sans + Newsreader 打包在扩展里，离线可用，Mac / Windows 长得一样 |

设置面板里的每个开关**只控制显示，绝不删数据** —— 关掉再打开，钉住的站点和存下的清单原样还在。

## 浏览器支持

| | 版本要求 | 说明 |
|---|---|---|
| **Chrome** | 任意支持 MV3 的版本 | 同一个包 |
| **Edge** | 同上 | 与 Chrome **共用同一个包**（Edge 是 Chromium，`chrome.*` 全对齐） |
| **Firefox** | 142.0+ | 只改 manifest，代码一行不动 |

Firefox 上有两处**故意**的差异，不是 bug：

- **常用站点的自动图标在 Firefox 上是首字母色块。** `_favicon` 端点是 Chromium 专有的，Firefox 没有等价物。为了一张图标去访问站点自己的服务器，会把「唯一联网的是天气」这句话戳破，不值得。
- **默认快捷键是 `Ctrl+Shift+L` 不是 `K`。** `Ctrl+Shift+K` 在 Firefox 里是「Web 控制台」，会撞车。（Firefox 其实支持扩展自己改快捷键，但我们没走那条路。）

三家都支持的：`chrome_url_overrides.newtab`、`chrome.topSites`、`chrome.search.query`、角标、`chrome.storage`。

## 隐私

标签页数据、钉住的站点、稍后再看、设置 —— 全在 `chrome.storage.local`，**不往任何服务器发**。

唯一的对外请求是天气：发的是你选的城市坐标（默认上海），就两个数字。不带标签页数据、不带浏览历史、不带设备标识、不带 cookie。想彻底不发，把设置里的天气开关关掉。

界面字体（DM Sans / Newsreader）也是**打包在扩展里**的，不联网取。汉字用各系统自己的字体（苹方 / 微软雅黑）—— 包一个能看的中文字体 10 MB 起，不值。

> Firefox 版在 manifest 里显式声明了 `data_collection_permissions: { required: ["none"] }`。

完整版见 [PRIVACY.md](./PRIVACY.md)（含每一项权限是干什么的）。

## 开发者

```bash
node tools/build-store.js     # → dist/ 下三个 zip，各商店直接上传
node tests/smoke.js           # → 冒烟测试，无依赖、不联网、一秒内跑完
```

- **无构建**。`extension/` 目录直接 load unpacked 就能跑，没有打包器、没有 `node_modules`。
- 浏览器差异全部收在 `extension/env.js` 一个文件里，别处不许出现 UA 判断和硬编码的内部页地址。
- 冒烟测试守着文案表、版式不变量和跨浏览器行为，改完代码跑一遍。
- 界面文案只有一个来源：`extension/strings.js` 词目 × 中英两份。

架构、技术栈、目录结构、字体与打包的取舍，见 [工程笔记](docs/工程笔记.md)。

## 更多

- [Firefox 安装指南](docs/firefox-安装指南.md) —— 签名、临时加载、不公开分发，以及 Firefox 上的三处差异
- [天气：数据从哪来，以及它为什么不问你要权限](docs/天气.md)
- [快捷键：为什么只能「显示」，改要去浏览器自己的页面](docs/快捷键.md)
- [工程笔记](docs/工程笔记.md)

## 许可证

MIT。原始版权归 [Zara Zhang](https://x.com/zarazhangrui)，衍生部分的版权归本项目作者，两份声明都保留在 [LICENSE](./LICENSE) 中。

## 致谢

归拢是站在 [Tab Out](https://github.com/zarazhangrui/tab-out) 的肩膀上做的 —— 按域名分组的思路、关闭时的音效与彩带、「稍后再看」这份清单，这些骨架都来自原作者 Zara。
