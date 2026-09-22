# Firefox 安装指南

归拢从 GitHub 仓库下载使用，不通过插件商店分发。你可以让本地 agent 准备文件，再按提示在 Firefox 中加载。

**Firefox 当前使用临时加载：重启浏览器后，需要重新加载扩展。** 这是 Firefox 对未签名扩展的限制，agent 下载和打包后也一样。

## 让 agent 帮你安装

把下面这段话发给你的本地 agent：

> 帮我从 https://github.com/qwsir32-star/guilong 安装归拢，我使用桌面版 Firefox。请阅读仓库的 AGENTS.md 和 Firefox 安装指南，准备好 Firefox 扩展文件，给我 manifest.json 的完整路径，并引导我完成临时加载。

agent 会下载仓库、检查打包环境并生成 Firefox 文件。准备好后，你需要在浏览器里完成以下操作：

1. 地址栏输入 `about:debugging#/runtime/this-firefox`，按回车。
2. 点击 **载入临时扩展**（Load Temporary Add-on）。
3. 选择 agent 提供的 **`dist/firefox/manifest.json`** 文件。
4. 打开一个新标签页，看到归拢面板就可以开始使用。

保留下载的仓库目录，重启后还要从这里加载。

## 前置条件

- 桌面版 Firefox **142.0 或更高**；普通正式版即可。
- 生成扩展文件需要 **Node.js** 和打包脚本使用的 **zip 命令**，agent 可以先检查是否可用。日常使用不需要运行 Node.js。
- 不需要插件商店账号、API key 或服务器。

## 自己下载并安装

如果让 agent 操作，下面这些命令可以交给它执行。

```bash
git clone https://github.com/qwsir32-star/guilong.git
cd guilong
```

也可以在仓库页面点 **Code → Download ZIP**，解压后在仓库目录打开终端。

生成 Firefox 扩展文件：

```bash
node tools/build-store.js
```

脚本成功后会生成 `dist/firefox/` 目录。然后按上面的浏览器步骤加载。

**选 `dist/firefox/manifest.json`，不要选 `extension/manifest.json`。**

源目录的配置使用 Chromium 的 `background.service_worker`，打包脚本会将它转换成 Firefox 使用的后台配置。直接选源目录可能导致角标、工具栏点击和快捷键无法正常工作。

## 重启 Firefox 后

再次打开 `about:debugging#/runtime/this-firefox`，点 **载入临时扩展**，选择原来的 `dist/firefox/manifest.json`。

只要文件还在，就不必重新下载或打包。也可以让 agent 帮你找到原来的文件路径。

## 更新归拢

让 agent 更新现有仓库并重新生成 Firefox 文件即可。用 Git 下载的，在仓库目录执行：

```bash
git pull
node tools/build-store.js
```

用 ZIP 下载的，把新版解压到原来的仓库目录，再运行打包脚本。

回到 `about:debugging`，点击归拢旁边的 **Reload**；如果已经重启过 Firefox，就重新临时加载。最后关闭旧的归拢标签页，再打开一个新标签页。

## 常见问题

**为什么重启后不见了？**

Firefox 的临时扩展只在当前浏览器会话中有效。按上面的步骤重新加载即可。这种方式不会变成永久安装，也不会自动更新。

**页面能打开，但角标或快捷键不工作？**

先确认加载的是 `dist/firefox/manifest.json`。如果选错了，让 agent 重新生成 Firefox 文件并协助改用正确的路径。

**快捷键是什么？**

Windows / Linux 默认是 `Ctrl+Shift+L`，Mac 默认是 `⌘⇧L`。需要修改时，打开 `about:addons`，在齿轮菜单中选择「管理扩展快捷键」。

**为什么一些站点显示字母而不是图标？**

Firefox 没有归拢在 Chrome / Edge 上使用的本地图标接口，因此部分站点会显示首字母色块，不影响使用。

**加载失败怎么办？**

把 Firefox 版本、选择的文件路径和错误提示发给 agent；也可以到仓库[反馈问题](https://github.com/qwsir32-star/guilong/issues/new/choose)。

[返回 README](../README.md) · [Firefox 官方临时加载说明](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/)
