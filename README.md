# Codex 额外重置预测

在 Codex 桌面版左下角、原生 Usage 按钮上方，查看未来 12、24、48、72 小时内发生额外额度重置的社区估算。**macOS 独立运行方式支持从原来的 Codex 图标启动，日常无需打开 Codex Tweaks。**

[macOS 独立运行](#macos-独立运行) · [Codex Tweaks 安装](#codex-tweaks-安装) · [常见问题](#常见问题)

![Codex 左下角的预测入口和详情面板](docs/forecast-preview.png)

*界面预览使用示例数据。*

## 安装

| 方式 | 适合谁 | 从哪里获取 |
| --- | --- | --- |
| **macOS 独立运行** | 想从原来的 Codex 图标启动 | 当前仓库的 `main` 分支 |
| **Codex Tweaks 功能包** | 已经在使用 Codex Tweaks，希望统一管理功能包 | [v0.1.7 Release](https://github.com/key-student/codex-tweaks-reset-forecast/releases/tag/v0.1.7) |

同一时间选一种方式使用。

### macOS 独立运行

**准备环境**

- 官方 Codex 桌面客户端位于 `/Applications/ChatGPT.app`，并已登录。独立方式已在 macOS 上用桌面版 `26.1103.60933` 验证。
- 在终端运行 `node --version`，确认是 **Node.js 22 或更新版本**。 [Node.js 官方下载](https://nodejs.org/en/download)
- 需要 Xcode Command Line Tools 编译启动助手。若尚未安装，运行 `xcode-select --install`，按系统提示完成。 [Apple 安装说明](https://developer.apple.com/documentation/xcode/installing-the-command-line-tools/)

**下载并安装**

有 Git 时，在终端运行：

```bash
git clone https://github.com/key-student/codex-tweaks-reset-forecast.git
cd codex-tweaks-reset-forecast
bash standalone/install.sh install
```

也可以 [下载 main 分支 ZIP](https://github.com/key-student/codex-tweaks-reset-forecast/archive/refs/heads/main.zip)。解压后，在终端输入 `cd `（末尾留一个空格），把解压出的项目文件夹拖进终端并回车，再运行 `bash standalone/install.sh install`。安装使用当前 macOS 用户权限，无需 `sudo`。

**从原来的图标打开 Codex**

1. 保存手头工作。如果 Codex Tweaks 正在运行，先退出它。
2. 用 `⌘Q` 完全退出 Codex，再从原来的 Dock 或「应用程序」图标打开。
3. 等几秒钟。启动助手可能会自动重开 Codex 一次。看到 Usage 上方的 `48h` 和百分比后，点击即可展开详情。

启动助手随 macOS 用户登录运行。它只会接管刚启动、处于前台且还没有新输入的 Codex。Codex 完全退出后，负责取数和绘制界面的后台会停止，启动助手继续等待下次启动。

**检查状态、更新和卸载**

在项目目录运行：

```bash
bash standalone/install.sh status       # 检查启动助手是否已注册
bash standalone/install.sh uninstall    # 卸载启动助手及其运行文件
```

更新时，Git 用户先运行 `git pull --ff-only`，ZIP 用户重新下载并解压最新源码，然后再次执行 `bash standalone/install.sh install`。更新或卸载后，可以完全退出并重新打开 Codex，让当前会话应用变更。所选显示时段保存在 `~/Library/Application Support/Codex Reset Forecast/data`。

### Codex Tweaks 安装

需要 Codex 桌面版、支持功能包 API v3 的 Codex Tweaks，以及 Node.js 20.3 或更新版本。「从 Git 安装」还需要 Git。已在 macOS 上使用 Codex Tweaks v3.5.11 验证，Windows 尚未实测。 [Codex Tweaks 安装和连接说明](https://github.com/codex-tweaks/codex-tweaks#开始使用)

1. 打开 Codex Tweaks，确认「概览」显示已连接 Codex。若提示「重启并连接」，保存工作后按提示操作。
2. 在「功能包」选择「从 Git 安装」，填入 `https://github.com/key-student/codex-tweaks-reset-forecast`，选择指定标签 `v0.1.7`。也可以选择「本地安装」，打开解压后的项目目录，其中应包含 `package.json`。
3. 编译并启用 `ct-reset-forecast`，阅读权限说明后授权当前版本的 Node 权限。
4. 回到 Codex，点击 Usage 上方的预测入口。Codex Tweaks 可关闭窗口并在后台运行。在「功能包」里停用 `ct-reset-forecast` 即可移除入口。

## 怎么用

- **看预测**。点击左下角，查看未来 12、24、48、72 小时的概率、预测更新时间和来源链接。
- **改显示时段**。在详情里点「左下角显示」。选项即时生效并保存在本机，详情仍显示四个时间窗口。
- **看公开预告**。观测站收录明确预告时，面板显示事件类型和已知时间，并在可用时附上原帖链接。
- **识别旧数据**。预测过期时，左下角显示「—」。若曾读到数据，详情会标记并保留上次预测。

## 常见问题

**独立方式装好后看不到入口？** 先用 `status` 确认启动助手已注册。保存工作并完全退出 Codex，再从原来的图标打开，等几秒再开始操作。如果刚反复启动过，等待两分钟后再试一次。Codex 更新也可能改变侧栏结构，届时需要适配。

**左下角显示「—」？** 打开面板查看状态。可能是首次加载、上游暂时不可达，或已有预测过期。独立版在窗口可见时每分钟检查一次是否需要取数，失败后约一分钟可重试。成功的网络请求至少相隔十分钟。

**用过 Tweaks 版本，怎么切换？** 使用独立方式前退出 Codex Tweaks，再从原来的图标重新打开 Codex。如果你想保留 Tweaks 的其他功能包，可以在 Tweaks 中单独停用 `ct-reset-forecast`。

## 预测来源与权限

概率由 **Codex Reset Observatory（Gussuri Works）** 提供，估算的是额外重置事件，包括直接恢复额度或发放重置卡。个人剩余额度和常规重置时间请以 Codex 原生 Usage 为准。 [观测站](https://codex.gussuriworks.com/zh) · [公开 API 文档](https://github.com/gussuri/codex-reset-observatory#public-api)

- **界面与网络**。插件通过本机回环连接定位导航栏并绘制面板。Node 后台请求观测站的公开 JSON，无需账号或 API 密钥。代码不读取对话、账户额度或登录凭据。
- **独立启动助手**。安装脚本注册一个 macOS 用户级启动任务，并编译助手。Codex 应用文件和签名保持原样。本机调试连接只监听回环地址。
- **本地数据**。所选显示时段保存在 `settings.json`，预测快照保存在内存。两种安装方式各自保存设置。

## 开发与许可

项目没有第三方运行时依赖。使用 Node.js 20.3 或更新版本执行 `npm test`，验证上游响应解析、请求缓存和设置写入。

`src/renderer.js` 和 `src/style.css` 实现共享界面，`src/node.js` 实现预测和设置。Tweaks 从 `src/index.js` 加载，macOS 独立运行代码位于 `standalone/`。

项目采用 [MIT License](LICENSE)。感谢 [Codex Tweaks](https://github.com/codex-tweaks/codex-tweaks) 提供功能包宿主、Codex Reset Observatory 提供公开预测数据，以及 [Codex Usage Card](https://github.com/Lorie7813/codex-usage-card/releases/tag/v0.9.5-beta.1) 提供独立启动方式的参考。
