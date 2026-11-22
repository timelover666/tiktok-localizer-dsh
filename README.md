# TikTok 视频本地化流水线 · DeepSeek Harness 插件

把一批 TikTok 链接做成可直接发布的中文本地化成品：画面 OCR 识别外文 → 翻译 → 抹除价格/关注等引流信息 → 烧录单行无标点中文字幕 → 按垂类生成标题正文 → 输出 jpg 封面 → 逐条建「序号 已完成」文件夹 → 导出带原文对照的汇总 Excel。

左侧栏「视频本地化」面板操作，也注册了 `tiktok_localizer` 工具，可以直接在对话里驱动。

> 适用环境：**macOS + Apple Silicon（M 系列芯片）** + DeepSeek Harness 桌面版（0.2.2-rc.3 或同一条版本线）。
> 本仓库为「精简版」：不含语音识别运行库（当前流水线只用画面 OCR，ASR 已停用）。

## 安装

### 0. 前置检查

- DeepSeek Harness 桌面版已装在「应用程序」文件夹
- 终端里 `python3 -V` 有输出（没有就先 `xcode-select --install`）
- DSH 设置里已选好对话模型（翻译、文案、质检都调用它）
- 能访问 TikTok 的网络/代理（插件自动探测 `127.0.0.1:7890`）

### 1. 让终端有 `dsh` 命令

DSH 桌面版菜单栏 → **「管理 dsh 命令…」→ 安装**（需要管理员密码），然后**新开一个终端**：

```sh
dsh --version
```

### 2. 安装插件（先完全退出 DSH）

三种方式任选一种：

**A. 仓库直装（仓库公开时最省事）**

```sh
dsh plugin --profile desktop add "git+https://github.com/timelover666/tiktok-localizer-dsh.git"
```

**B. 克隆到本地再装（推荐，以后更新只 pull）**

```sh
git clone https://github.com/timelover666/tiktok-localizer-dsh.git ~/DSH-plugins/tiktok-localizer
dsh plugin --profile desktop add ~/DSH-plugins/tiktok-localizer
```

**C. 用压缩包（没有仓库也能装）**

```sh
dsh plugin --profile desktop add ~/Downloads/tiktok-localizer
```

### 3. 重开 DSH

左侧栏出现「视频本地化」即安装成功；新会话里也能看到 `tiktok_localizer` 工具。

## 更新

- 方式 B：`git -C ~/DSH-plugins/tiktok-localizer pull`，然后重开 DSH
- 方式 A：重新执行一遍第 2 步的 `add` 命令，然后重开 DSH

## 卸载

```sh
dsh plugin --profile desktop remove @local/tiktok-localizer
```

## 使用

1. 左侧栏点「视频本地化」。
2. 粘贴链接（每行一个，整段分享文本也行），输出目录可留空（默认 `~/Downloads/海外视频本地化`）。
3. 点「开始处理」：严格按输入顺序逐条处理，面板显示每条阶段与失败原因。
4. 跑完后「在访达打开」查看成品和 `本地化汇总.xlsx`。

也可以在对话里直接用：

```text
用 tiktok_localizer 处理这批链接：<链接1> <链接2> ...
```

## 已知限制

- **只支持 macOS Apple Silicon**：自带 arm64 的 ffmpeg 与 OCR 二进制，Intel Mac 跑不了。
- 需要系统自带的 macOS Vision 文字识别能力。
- 精简版不含语音识别运行库（`runtime/pylib`、`runtime/models`），当前流水线只用画面 OCR，不影响使用。
- 面板「新建对话」按钮写死了原作者工作区 `/Volumes/Data/媒老板`；没有该磁盘时该按钮会报错，不影响「粘贴链接 → 开始处理」。
- 下载链只保留 yt-dlp → tikwm（hellotik 已移除，不再需要专用 Chrome 与解析点数）。
- 第三方组件：`runtime/bin/ffmpeg`、`runtime/fonts/NotoSansSC-Bold.ttf`（SIL OFL）。仓库保持私有或仅限个人分发时无需额外处理；若公开分发，请保留各自许可证。