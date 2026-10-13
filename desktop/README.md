# EchoLingo 桌面版（macOS）

把 `english-video-reader` 站点打包成一个自包含的 `.app`：内置 Electron（Chromium），
模型、词典、页面全部塞进 bundle，**断网可用，不发任何外部请求**。

```
desktop/
├─ main.js          Electron 主进程：起本地服务 + 开窗口
├─ site-server.js   静态服务器，负责发 COOP/COEP 头（多线程 wasm 的命门）
├─ build.mjs        打包脚本（零依赖：只用 node + 系统 ditto/plutil/codesign）
├─ make-icon.py     生成 icon.icns
└─ icon.icns        应用图标
```

## 构建

```bash
cd desktop
node build.mjs                 # → ../dist/EchoLingo.app
open ../dist/EchoLingo.app
```

可选环境变量：

| 变量 | 作用 |
|---|---|
| `ARCH=x64` | 打 Intel 版（默认跟当前机器） |
| `ELECTRON_VERSION=44.7.0` | 换 Electron 版本 |

首次构建会下载 Electron 的 zip（124MB，镜像优先、自动回退 GitHub），
缓存在 `desktop/.electron-cache/`，之后重建是秒级。

## 为什么需要一个内置的本地服务器

不是为了"顺便"，而是**必须**：

1. onnxruntime 的 wasm 后端要靠 `SharedArrayBuffer` 才能开多线程，而浏览器只在
   `crossOriginIsolated === true` 时放开它 —— 条件就是文档响应带
   `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` 头。
   `file://` 给不了响应头；Chromium 里自定义协议也拿不到跨源隔离。
   `http://127.0.0.1` 是"潜在可信来源"，既能发头、又能注册 Service Worker。
2. **端口必须固定（8731）**：localStorage / IndexedDB（收藏夹）和 Service Worker
   缓存都按来源隔离，端口一变用户的收藏就没了。被占用时会顺延到 8732…，
   并在主进程日志里警告。

## 为什么不用 @electron/packager

packager 依赖 `@electron/get` → `@electron-internal/extract-zip`，后者是 napi-rs
原生模块。在 macOS 27 上加载它会被系统的库校验直接拒绝：

```
dlopen(...index.darwin-universal.node): code signature ...
not valid for use in process: mapping process and mapped file
(non-platform) have different Team IDs
```

也就是说 Node 进程与那个 `.node` 的 Team ID 不一致，系统不允许加载 ——
`electron` 的 postinstall（解压）和 packager（解压）在本机都会失败。

zip 的**下载**是好的，所以 `build.mjs` 干脆不依赖任何 npm 包：
自己 `fetch` 下 zip → 用系统 `ditto` 解压 → 手工组装 bundle → `codesign` ad-hoc 重签。

> Apple Silicon 上这一步不能省：往 bundle 里塞了东西，Electron 官方签名就失效了，
> 而签名无效的 arm64 应用会被系统拒绝启动。

## 已知环境坑

**`ELECTRON_RUN_AS_NODE=1`**：如果这个变量在环境里，任何 Electron 二进制都会被
当成 Node 来跑，表现是 `--version` 打印 Node 版本、任何命令行参数都报
`bad option: ...`、无参数时读 stdin 后退出 0。从 Finder 双击启动不会带这个变量；
只有在某些被该变量污染的终端里才会遇到。

```bash
env -u ELECTRON_RUN_AS_NODE ./dist/EchoLingo.app/Contents/MacOS/EchoLingo
```

在受限沙箱（不允许 Chromium 建自己的沙箱）里调试时，需要额外加 `--no-sandbox`：

```bash
env -u ELECTRON_RUN_AS_NODE ./dist/EchoLingo.app/Contents/MacOS/EchoLingo --no-sandbox
```

正常使用（双击）不需要任何参数。

## 打包内容

`Contents/Resources/app/site/` 里是站点本体（`index.html`、`js/`、`css/`、
`vendor/`、`models/`、`dict/`、`media/`、`sw.js`、`manifest.webmanifest`）。
`bench/`、`tools/`、`desktop/`、`dist/` 不会进包。

构建产物约 560MB（Electron 约 290MB + 站点 273MB，其中模型 240MB）。
换成 `asar: true` 能略小一点，但 240MB 的 onnx 从 asar 里流式读取更慢、也更容易出问题，
所以这里刻意保持真实文件。
