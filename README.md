# 归拢

**散着的标签页，归拢一下。**

归拢接管你的新标签页：把你此刻开着的所有标签页按域名摆成一张网格仪表盘 —— 哪个站开了多少个、哪些其实开重了、哪些只是"先放着回头再看"，一眼扫完。关掉的时候有音效和彩带。

没有服务器、不用账号、不请求任何外部接口。就是一个 Chrome 扩展。

> **衍生说明**：本项目是 [Tab Out](https://github.com/zarazhangrui/tab-out)（作者 [Zara](https://x.com/zarazhangrui)）的衍生版，在其基础上做了中文化与若干增强。原项目采用 MIT 许可证，原始署名与许可证原文都完整保留在 [LICENSE](./LICENSE) 中。

---

## 安装

**1. 克隆仓库**

```bash
git clone https://github.com/qwsir32-star/tab-out.git
cd tab-out
```

**2. 加载扩展**

1. 打开 Chrome，地址栏输入 `chrome://extensions`
2. 打开右上角的**开发者模式**
3. 点左上角的**加载已解压的扩展程序**
4. 选中仓库里的 `extension/` 文件夹

**3. 打开一个新标签页**

你会看到归拢。

> **改完代码记得这样做**：新标签页有缓存，只点扩展卡片上的刷新按钮不一定生效，要**关掉旧的新标签页重新开一个**。另外扩展需要 `topSites` / `favicon` / `search` 三项权限，重载时 Chrome 可能让你再确认一次。

---

## 功能

| 功能 | 说明 |
|---|---|
| **一眼看尽** | 打开的标签页按域名分组，网格排开 |
| **主页单独成组** | Gmail 收件箱、X 首页、YouTube、LinkedIn、GitHub 主页收进一张卡片，一次关干净 |
| **关得爽** | 关闭时合成音效 + 粒子彩带 |
| **重复检测** | 同一个页面开了两遍会被标出来，可一键清理 |
| **点标题就跳** | 点任意标签页标题直接跳过去，跨窗口也行，不会多开一个 |
| **存入稍后再看** | 关之前先把想留的存进清单 |
| **本地项目分组** | `localhost` 后面显示端口号，几个项目分得清 |
| **可展开的分组** | 每组先显示前 8 个，其余折叠在「还有 N 个」后面 |
| **常用站点条** | 常去的站点钉在顶部，可按住拖动排序；点一下永远是新开一个标签页 |
| **站点图标** | 默认用 Chrome 自己缓存的那份 favicon；也可以在「图标」里填图片地址，或者填 1–2 个字当文字图标 |
| **搜索框** | 输入网址就直接打开，否则交给你自己设的默认搜索引擎（不替你做主） |
| **设置开关** | 「常用站点条」和「搜索框」可以各自关掉 —— 只控制显示，钉过的数据一条不删 |
| **归档** | 处理过的分组可以归档，之后还能搜回来 |
| **中英双语** | 默认中文，全部界面文案集中在 `strings.js` 一张表里 |
| **100% 本地** | 数据不出你的机器 |

---

## 个性化：`extension/config.local.js`

有些东西只跟你的使用习惯有关，不该混进源码。在 `extension/` 下新建 `config.local.js`（已在 `.gitignore` 里，不会被提交）：

```js
// 把「主页」判定扩到你自己常去的那些站
// 默认规则只认内置几个（Gmail / X / GitHub / YouTube / LinkedIn）
const LOCAL_LANDING_PAGE_PATTERNS = [
  { hostname: 'mail.qq.com' },                        // 只看这个域的根路径
  { hostnameEndsWith: '.example.com', pathPrefix: '/dashboard' },
];

// 自定义分组：把子域并成一张卡，或者按路径拆开
const LOCAL_CUSTOM_GROUPS = [
  { hostnameEndsWith: '.example.com', groupKey: 'example', groupLabel: '示例全家桶' },
];
```

这两组规则的**优先级都高于内置规则**，可以覆盖内置的子域合并逻辑。文件不存在也完全没关系 —— 扩展照常用内置默认值跑，只会在控制台留一条无害的 404。

**匹配字段速查**

- `LOCAL_LANDING_PAGE_PATTERNS`：`hostname` 或 `hostnameEndsWith`（二选一）+ 可选的 `pathExact`（数组）、`pathPrefix`、或自定义函数 `test(pathname, url)`。**都不给路径条件时，只匹配该域的根路径 `/`**。
- `LOCAL_CUSTOM_GROUPS`：`hostname` 或 `hostnameEndsWith` + 可选的 `pathPrefix`，另需 `groupKey`（并组用的 key）和 `groupLabel`（卡片上显示的名字）。

---

## 工作方式

```
你打开一个新标签页
  -> 归拢把你开着的标签页按域名摆出来
  -> 主页类站点（Gmail、X 等）单独一组放在最前
  -> 点任意标题跳过去
  -> 看完了的整组关掉（音效 + 彩带）
  -> 舍不得关的先存入「稍后再看」
```

所有逻辑都跑在扩展里。没有外部服务、没有 API 调用、没有数据外发。稍后再看与钉住的站点存在 `chrome.storage.local`。

---

## 技术栈

| 部分 | 实现 |
|------|------|
| 扩展 | Chrome Manifest V3 |
| 存储 | `chrome.storage.local` |
| 音效 | Web Audio API（运行时合成，不带任何音频文件） |
| 动画 | CSS transition + JS 粒子彩带 |
| 界面文案 | `strings.js` 里的单张 `STRINGS` 表 + `T()` / `Tn()` 取词 |
| 构建 | **无**。`extension/` 目录直接 load unpacked 就能跑 |

---

## 目录结构

```
tab-out/
├── extension/            <- 加载这个文件夹
│   ├── manifest.json
│   ├── index.html        新标签页结构
│   ├── style.css
│   ├── strings.js        全部界面文案（中 / 英）
│   ├── app.js            仪表盘主逻辑
│   ├── background.js     快捷键与后台
│   └── icons/
├── AGENTS.md             给编码 agent 的安装引导手册
├── LICENSE               MIT（含原始署名）
└── README.md
```

---

## 许可证

MIT。原始版权归 [Zara Zhang](https://x.com/zarazhangrui)，衍生部分的版权归本项目作者，两份声明都保留在 [LICENSE](./LICENSE) 中。

---

## 致谢

归拢是站在 [Tab Out](https://github.com/zarazhangrui/tab-out) 的肩膀上做的 —— 按域名分组的思路、关闭时的音效与彩带、「稍后再看」这份清单，这些骨架都来自原作者 Zara。
