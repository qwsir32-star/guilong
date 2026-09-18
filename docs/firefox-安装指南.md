# Firefox 安装指南

归拢在 Firefox 上的安装，绕不开一件事：**Firefox 强制签名**。

从 Firefox 43/44 起，所有扩展必须经 Mozilla 签名才能装；到 Firefox 49 之后，
Release 和 Beta 版连 `xpinstall.signatures.required` 这个开关都不认了 —— 改了也没用，
签名校验照样挡。所以：

> **"把 zip 发给朋友，让他双击装上" 这条路，在正式版 Firefox 上是不存在的。**

下面三条路，看你是谁。

| 你是谁 | 走哪条 | 能撑多久 |
|---|---|---|
| 最终用户（等 AMO 上架之后） | **A：从 AMO 装** | 永久，自动更新 |
| 你自己开发 / 试功能 | **B：`about:debugging` 临时加载** | **关掉 Firefox 就没了** |
| 想长期给别人用，但还不想公开上架 | **C：AMO「不公开列出」签名** | 永久，但不会出现在商店里 |

---

## 前置条件

- **Firefox 142.0 或更高。** 三横线 → 帮助 → 关于 Firefox。
- 系统不限：Windows / macOS / Linux 用的是同一个包，没有平台差异。
- 不需要 Firefox Developer Edition。测试用 Release 版就行（见路线 B）。

**为什么地板是 142** —— 这是个算术结果，不是随手写的：
`data_collection_permissions` 桌面版要 ≥140、安卓版要 ≥142，后台双键要 ≥121，
根证书过期要 ≥115 ESR / 128。取 142 三个都过，`web-ext lint` 一条警告都没有。

---

## 路线 A：从 AMO 安装（上架之后）

1. 打开 <https://addons.mozilla.org>，搜「归拢」
2. 点**添加到 Firefox**
3. 弹窗里点**添加**（权限清单就是 `tabs / activeTab / storage / topSites / search` 这五项）
4. 开一个新标签页 —— 就是仪表盘了

> 现在还没上架，这条暂时走不通。上架要填的字段见 [store/上架文案.md](../store/上架文案.md)。

---

## 路线 B：临时加载（自己测，最常用）

### ⚠️ 先记住这一句

**选 `dist/firefox/manifest.json`，不要选 `extension/manifest.json`。**

`extension/` 里那份是 **Chromium 的** manifest。Firefox 不认
`background.service_worker`（它跑的是 event page，用 `background.scripts`），
那份 manifest 塞给它，background 根本不会启动 —— 表现为：

- 页面能开，看着像装上了
- **但工具栏角标永远不更新**
- **快捷键呼不出来**（后台没跑，没人接这个命令）

这种"看起来好了但其实坏了一半"最坑人。所以务必先打包，再加载打包产物。

### 步骤

```bash
node tools/build-store.js
```

产出两个东西：`dist/firefox/`（展开的目录）和
`dist/guilong-<版本>-firefox.zip`（上传 AMO 用的包）。临时加载用前者。

1. 地址栏输入 `about:debugging#/runtime/this-firefox` 回车
2. 点 **载入临时扩展**（Load Temporary Add-on）
3. 文件选择框里选 **`dist/firefox/manifest.json`**
4. 开一个新标签页

### 怎么确认装对了

`about:debugging` 里那条应该显示：

- 名称：**归拢 · 新标签页**
- 扩展 ID：**`guilong@qwsir32-star.github.io`**

不放心的话直接看文件 —— `dist/firefox/manifest.json` 里应该有
`browser_specific_settings.gecko`，且**没有** `key`、没有 `service_worker`。

### 改完代码怎么生效

不用重新选文件。回 `about:debugging`，找到那条，点 **Reload**。
然后**关掉旧的新标签页重新开一个** —— 新标签页有缓存，只点刷新不一定看得到改动。

### 这条路的两个限制

1. **重启 Firefox 就没了。** 这是设计如此（Mozilla 给开发者的调试通道，不是安装方式），
   不是你装错了。重新加载一次就好。
2. **它不等于用户真实的安装路径。** 更新机制、签名状态都跟 AMO 装的不一样。
   上架前至少要用一次签名后的包验一遍。

---

## 路线 C：不公开的签名包（想给别人长期用）

这是"还没公开上架，但想让几个朋友装上用"的正解，不违反 Release 的签名要求。

1. 在 AMO 开发者后台提交时，选 **「不公开列出 / unlisted」**（不是公开上架）
2. 审核通过后拿到**已签名**的 `.xpi`
3. 把它发给对方：`about:addons` → 右上角齿轮 → **从文件安装附加组件** → 选 `.xpi`

对方用的是普通 Release 版 Firefox 也能装，因为包是签过名的。
不公开列出的包不会出现在商店搜索里，只有拿到直链的人能装。

> 还有一条路：Firefox **Developer Edition / Nightly / 部分 ESR** 允许把
> `xpinstall.signatures.required` 设成 `false` 后从文件装未签名包。
> 那是测试环境用的，**别让普通用户这么干** —— 等于关掉了一层安全兜底。

---

## Firefox 上和 Chrome 的三处不同（装完别以为坏了）

1. **常用站点条里，自动项没有 favicon，露首字母色块。**
   `_favicon` 端点是 Chromium 专有的，Firefox 没有等价物。为了一张图标去访问站点
   自己的服务器，会把「唯一联网的是天气」这句话戳破，不值。
   *手动钉住的那几项不受影响 —— 照样可以自己填图片地址，或填 1–2 个字。*

2. **默认快捷键是 `Ctrl+Shift+L`（Mac `⌘⇧L`），不是 K。**
   `Ctrl+Shift+K` 在 Firefox 里是「Web 控制台」，会撞车。
   改：`about:addons` → 齿轮 → **管理扩展快捷键**。
   （设置面板里也能看到当前绑定，但改要进浏览器自己的页面。）

3. **版本地板 142.0。**

---

## 排错

| 现象 | 原因 / 怎么办 |
|---|---|
| 页面开了，但角标不动、快捷键无效 | 加载的是 `extension/manifest.json`。删掉这条，改选 `dist/firefox/manifest.json` |
| 「此附加组件因不兼容或已损坏而被禁用」 | ① Firefox 低于 142；② 选了 Chrome 那个包 |
| 关掉 Firefox 后扩展没了 | **正常**。临时加载的生命周期就是一次会话 |
| 开新标签页没变 | ① 可能有别的扩展也在抢新标签页（只能有一个）；② 去 `about:debugging` 看那条有没有报错 |
| 站点条一片字母块 | 见上面第 1 条，Firefox 上的预期行为 |
| 天气不显示 | 设置里关着，或没选城市。天气是唯一的对外请求 |
| 字体看着不对 | 字体已随包（DM Sans + Newsreader），不联网取，跟网络无关 |

想自己验包：

```bash
npx web-ext lint dist/firefox
```

目标：**0 errors / 0 warnings / 0 notices**。这是 AMO 上架时跑的同一个校验器。

---

## 装完逐条过一遍

- [ ] 开新标签页 → 仪表盘，标签页按域名分组摆成网格
- [ ] 工具栏图标上有角标数字（说明后台在跑 —— 这条最关键）
- [ ] `Ctrl+Shift+L` / `⌘⇧L` 能呼出并聚焦
- [ ] 关掉一批标签页 → 合成音效 + 粒子彩带
- [ ] 稍后再看：能存、能归档、能还原
- [ ] 站点条：自动项是字母色块，手动项能按住拖动排序
- [ ] 设置面板：八套主题、天气开关、三个显示开关
- [ ] 把天气关掉 → DevTools 网络面板**零外部请求**

---

## 相关

- [store/上架文案.md](../store/上架文案.md) —— AMO 上架要填什么、三条硬要求
- [工程笔记](工程笔记.md) —— 目录结构、打包脚本、扩展 ID
- [README](../README.md) —— 功能一览
