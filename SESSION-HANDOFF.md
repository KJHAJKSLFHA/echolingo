# 会话转移文档（新会话请先读这份）

> **用途**：把一个很长的开发会话压缩成可恢复的记忆。新会话读完这份 + `HANDOFF.md`，
> 应该能无缝接着干，不需要翻聊天记录。
>
> **最后更新**：2026-10-14 · 版本 **3.12.1** · 提交 **b052b80** · 工作区干净
> （官网首页已换成海水背景 + 液态玻璃，见 §5.5）

---

## 0. 一句话现状

EchoLingo（外语视频精读工具）现在有**两个学习语言模式**：左上角（「视频精读」后面）切换
**英语模式 / 西班牙模式**。模式决定**识别语言 + 翻译链**（界面语言仍归右上角的 EN 按钮管，
两者互不影响）。西语模式下字幕出**三行**：西语原文 / 英文 / 中文，三种语言各自能关。
收藏也按模式分开（英语模式只看英语收藏，西语模式只看西语收藏）。
**画面字幕遮罩**的自动定位这一轮换成了稳健算法（旧算法在那条真西语 Vlog 上直接失败、
遮罩停在默认位置盖不住字幕），并且可以在画面上**直接拖动**调整位置。
**拖拽区标题跟着学习模式走**：英文模式「把英语视频拖进来」、西语模式「把西班牙语视频拖进来」。
**Windows 版首次发布**（electron-builder 打的 NSIS 安装包 + 便携版，挂在 GitHub Releases）。
**关掉了 Netlify 注入的「Powered by Netlify」浮层**（网站首页 + 工具页，见 §13）。
**官网首页**换成了海水照片背景（含 Ken Burns 缓慢缩放）+ 液态玻璃材质（按钮/卡片/顶栏），
并支持**浅色 / 深色 / 跟随系统**三态（见 §5.5、§5.6）。
网站出口是 **3.12.1 且已部署验证**；macOS App / Windows 仍是 3.12.0。
**目前没有进行中的任务。**

---

## 1. 用户是谁，想要什么

中文用户（GitHub: `KJHAJKSLFHA`，Netlify: `orion510ike@gmail.com`）。
他在用 AI 帮自己做一个自用的英语学习工具，**技术判断力不强但需求很明确**，
需要我用实测数据说话、不要糊弄。

### 诉求演进时间线（这是恢复记忆最关键的一条线）

| # | 用户原话（节选） | 我做的事 |
|---|---|---|
| 1 | "识别速度有点慢…你帮我优化一下" + "主打纯离线" | 实测定位瓶颈，发现长视频识别为空等 bug |
| 2 | "你直接将这个网站给我打包做成 mac 软件" | 做出 `desktop/build.mjs`，产出 `.app` |
| 3 | "把这个视频放进那个网站看识别要多久" | 测真实 14 分钟视频：首句 8s，总 68s |
| 4 | "加自动模糊视频中的字幕…**先做出来图片寻求我的意见**" | 先做预览图（真注入运行中的 App 截图），不直接改代码 |
| 5 | "要柔和模糊的" | 落地字幕遮罩功能 |
| 6 | "**直接做成可关闭右侧的中英文**不就好了" | 改成中英独立开关（比模糊更干脆） |
| 7 | "再加上这个 不用的时候直接收起来" | 加面板收起把手（`H`） |
| 8 | "上传到我的账号上"（GitHub） | 走设备码授权 + 分批推送 |
| 9 | "加上中英文吧" | 官网做中英双语 |
| 10 | "**不是github了 是我想要你将这个软件的完全复刻到网站上去 帮我做一个网站**" | 建官网 + 工具移到 `/app/`，部署到 Netlify |
| 11 | "目前这个软件只支持英语 我希望你能再添加西班牙语" + "两个都要" | 加西语识别 + 西语界面 |
| 12 | "本会话上下文溢出了…你压缩一下" | 写 `HANDOFF.md` |
| 13 | "整理成结构性的转移文档" | 就是这份 |
| 14 | "读 SESSION-HANDOFF.md 然后继续" | 补官网首页西语版（→ 3.9.0） |
| 15 | "左上角加英文模式/西班牙模式"+"单词翻译处也要出现西语翻译"+"收藏分开"+"第三个图标改成齿轮"（共 7 条，附 3 张截图） | 双模式 + 三行字幕 + 西语词卡与发音 + 收藏分区 + 齿轮图标（→ 3.10.0） |
| 16 | "这条西语视频他没有找到字幕在哪里所以在默认位置 我希望你能改善一下 希望能更精准的确定字幕在哪 并且帮我做一个可自由控制遮罩的位置" | 检测算法换稳健标准化 + 画面直接拖动 + 真素材回归用例（→ 3.11.0） |
| 17 | "在英文模式下显示把英语视频拖进来 相反在西班牙模式 只显示把西班牙视频拖进来" + "你现在能不能帮我做一个window版本的软件 并且上传到github" | 拖拽区标题按模式切换 + Windows 安装包/便携版发布到 GitHub Releases（→ 3.12.0） |
| 18 | "这里的 powered by netlify 挡住了把它改成可移动的" → "你真是的 你就不能一起隐藏了嘛？宣传网站的没弄" → "可以隐藏好了 再把echoling的网站也隐藏掉" | 关掉 Netlify 注入的浮层（改不动，只能藏）；BiliLyu 两页 + EchoLingo 两页都加上 `<head>` 同步标记（→ 3.12.1） |

### 关键偏好

- **交流用中文**，回复要直接、有结论、有实测数据
- 他会追问"怎么失败了？"——**输出里任何看起来像失败的地方都要主动解释清楚**
  （上一轮就是：命令本身没失败，但我漏了"把新包装进 /Applications"这一步，他立刻发现两份版本不一致）
- 他会在长命令中途**打断**（我几次长任务被 abort）——尽量把长任务放后台、及时汇报
- 他说"全部加进 app 里"指的是**装到 `/Applications`**，别只更新 `dist/`

---

## 2. 重要：这个工作区曾有第二个 AI 会话并行操作

**10 月 12 日晚**，另一个会话在同一个目录里做了**另一套 Electron 打包方案**：

- `electron/` 目录（`main.js` + `icon.icns` + `smoke.js`）
- 根 `package.json` 里的 electron-builder 配置（`npm run dist`，输出到 `release/`）
- 产出过 `release/EchoLingo-3.3.0-arm64.dmg`（**已删**）

**现在的情况**：另一个会话自 10/12 21:39 之后**没有再动过文件**。
`electron/` 和根 `package.json` 里那套配置**保留着**（是源码，没删），但它依赖的
`node_modules` 已被删掉，要用得先 `pnpm install`。

**实际发布走的是 `desktop/build.mjs`**（我的零依赖方案）。

⚠️ 如果发现文件在无预警变化，先查是不是那个会话又活了（看文件 mtime）。

---

## 3. 决策记录（含被否决的方案）

新会话最容易搞错的就是"为什么不用另一种做法"。这些都有实测依据：

| 决策 | 为什么不用另一种 |
|---|---|
| **桌面版手写打包，不用 @electron/packager** | packager 依赖的原生模块在 macOS 27 上被系统库校验拒绝（Team ID 不一致），解压直接失败。改自己下 zip + `ditto` + 手工组 bundle |
| **部署到 Netlify，不用 GitHub Pages** | Pages **发不了 COOP/COEP 响应头** → 没有 `crossOriginIsolated` → wasm 单线程，识别慢一截。Netlify 支持 `_headers` |
| **不用 Cloudflare Pages / Vercel** | Cloudflare 单文件硬上限 **25 MiB**（模型最大 57 MB）；Vercel Hobby 静态上传限 **100 MB**（站点 500 MB） |
| **西语翻译走两跳 es→en→zh** | HF 上**不存在**现成的「西→中」ONNX 量化模型（搜过，没有）；NLLB-600M 直译量化后要 **1.7 GB**，不现实；`opus-tatoeba-es-zh` 只有 PyTorch，自己转要装 torch（2.5 GB） |
| **字幕遮罩用 `backdrop-filter` 而不是 canvas** | 盖一个空 div 让合成器糊背后的像素，不复制视频帧、不逐帧重绘。只有马赛克样式才需要 canvas |
| **中英开关用「容器加 class」而不是重建 DOM** | 识别时每 500 ms 就要整块重排一次字幕，重建 DOM 已经够贵；切 class 零成本 |
| **首屏出句靠「连续前缀优先派发」而不是缩短首段** | 缩短首段要多付一次固定开销（约 1.6 s/段），总时长变差；改派发顺序是纯赚：**18.1s → 8.0s** |
| **模型语言跟着识别模型走，不做「手动选语言」** | 少一层 UI；`.en` 是纯英语、多语言版用于西语，选模型即选语言 |

---

## 4. 已完成任务清单

- [x] 修复**长视频识别为空**（`return_timestamps: true` 对中间切出的段返回空文本）
- [x] 首屏出句 **18.1s → 8.0s**（派发顺序）
- [x] 线程数策略、PCM 双重拷贝、切段拉长等性能修复
- [x] **画面字幕遮罩**（4 种样式 + 自动定位 + `Alt` 临时揭开）
- [x] **右侧中英文独立收起**（`E` / `C`）+ **整个面板收起**（`H`）
- [x] **打包成 macOS App**（零依赖脚本，ad-hoc 重签）
- [x] **上传 GitHub**（设备码授权，分批推送，可断点续传）
- [x] **产品官网首页** + 工具移到 `/app/` + **部署到 Netlify**
- [x] 官网中英双语
- [x] **西班牙语支持**（识别 + 界面 + 两跳翻译）
- [x] **官网首页西语版**（三语首页 + 窄屏适配 + 两个校验脚本，→ 3.9.0）
- [x] **双模式（英语 / 西班牙语）**：左上角模式开关 + 模式驱动识别模型 + 切模式确认弹窗（→ 3.10.0）
- [x] **西语模式三行字幕**：西语原文 / 英文 / 中文，三语独立开关（→ 3.10.0）
- [x] **西语词卡与发音**：西语词元不再被切碎、词卡走中文释义、西语语音、音色按模式各记一个（→ 3.10.0）
- [x] **收藏按模式分区**：两档收藏互不串，角标随模式变化（→ 3.10.0）
- [x] **设置入口换齿轮**（原来和主题太阳的图标几乎一模一样，根本分不出）（→ 3.10.0）
- [x] **品牌文案中性化**（支持西语后「回声英语 / 英语视频精读」已经不准）（→ 3.10.0）
- [x] **真西语 Vlog 端到端验收**（914MB 4K 视频，39.7 秒跑完，32 句三行齐全）（→ 3.10.0）
- [x] **遮罩自动定位换成稳健算法**：中位数/MAD 标准化 + 以 edge 为主，真素材从「返回 null」变成 86.1%~97.2%（→ 3.11.0）
- [x] **在画面上直接拖动遮罩**：拖上下边缘改高度、拖中间整体移动、画面右上角「完成」出口、Esc 退出（→ 3.11.0）
- [x] **拖拽区标题按模式切换**：英文模式「把英语视频拖进来」/ 西语模式「把西班牙语视频拖进来」，三语界面都跟着翻译；
      顺带修了「切回英语模式标题不复原」的隐藏 bug（→ 3.12.0）
- [x] **Windows 版首次发布**：electron-builder 打 NSIS 安装包 + 便携版，414 MB ×2，
      挂到 GitHub Releases v3.12.0（→ 3.12.0）
- [x] 交接文档 `HANDOFF.md` + 本文件

---

## 5. 当前状态快照

**五个出口（全部 3.12.0 / 同一份代码）**

| 出口 | 位置 | 备注 |
|---|---|---|
| 网站 | https://echoling.netlify.app | 官网 `/`，工具 `/app/`；账号 `orion510ike@gmail.com` |
| macOS App | `/Applications/EchoLingo.app` | **804 MB**，模型内置，双击即用 |
| Windows | [GitHub Releases v3.12.0](https://github.com/KJHAJKSLFHA/echolingo/releases/tag/v3.12.0) | 安装包 413942279 B + 便携版 413716392 B，x64 |
| GitHub | github.com/KJHAJKSLFHA/echolingo | 公开，`main` 分支 |
| 本地源码 | 本目录 | `app/js/app.js` 的 `APP_VER` |

**模型 6 个（`app/models/`，共 477 MB）**：whisper-base.en / tiny.en（英语，77+42）、
whisper-base / tiny（多语言，西语用，78+43）、opus-mt-en-zh（117）、opus-mt-es-en（117）

**验证结论（都实测过）**
- **真西语 Vlog 端到端**（`bench/test-es-vlog.mjs`，914MB / 370s / 4K）：认出了 369.85s、3840×2160；
  **32 句**；切成 14 个识别段（每段都 < 29s 上限）；解码 3s + 识别 12s + 翻译 22s = **总 39.7s**，异常 `[]`。
  质量：原文像西语 100%、英文行像英语 93.8%、中文行像中文 100%
- 英语回归正常（3.10.0 又跑过一遍，`异常: []`，4.2s；三语界面漏翻样本都是 `[]`）
- 西语识别与合成原文**逐字吻合**；词元 56 个全部完整（`práctica` / `hábitos` / `días` / `así` 没被切碎）
- 工具界面 **281 key × 3，零缺失**；官网首页 **81 key × 3，markup 绑定 79 个全命中**
- 官网三语在真实 Chrome 里各渲染一遍：80 个元素全对，**非中文页残留中文 = 0**
- 浏览器语言探测：`zh-CN→zh`、`es-ES`/`es-MX`→`es`、`fr`/`ja`/`de`→`en`
- 字幕遮罩四种样式都彻底遮住；窗口缩放跟随
- **遮罩自动定位（3.11.0）**：真西语 Vlog 上点「重新检测」→ **5.2 秒**得出 `82.9% ~ 99.8%`，
  覆盖画面底部那两行字幕（地面真相 87.5%~97.5%，来自 `bench/probe-mask-detect.mjs` 的 ASCII 亮度图）。
  **改动前同一条素材返回 `null`**（App 提示「没找到烧录字幕」，遮罩停在默认 90.5%~98.7%）
- **遮罩拖动（3.11.0）**：`bench/test-mask-adjust.mjs` **33 项全过** —— 拖上边缘 +24px → 上边界 +4.98%
  （屏幕 24px ÷ 画面内容高 482px 正好是 4.98%）、拖下边缘 +18px → 下边界 +3.73%、拖中间 -30px →
  整条带移动 6.22% 而**带高一字不变**、拖出画面会被钳在 5%~13.75% 且带高仍是 8.75%、
  两条滑杆与存档一致、点「完成」后位置保留、刷新后原样恢复
- 面板收起 857 → 1378 px；刷新后保持
- 顶栏在 1440px 三语都不溢出；380px 时加了 ES 按钮的代价从 40px 降到 5px

**3.12.0 的验证（都实测过）**
- `bench/test-dropzone-title.mjs` **5 个状态全过**：英语模式+中文界面 →「把英语视频拖进来」／
  西语模式+中文 →「把西班牙语视频拖进来」／西语模式+英文界面 →「Drop a Spanish video here」／
  西语模式+西语界面 →「Arrastra aquí tu vídeo en español」／切回英语模式 → key 与文案都复原。
  脚本会**先把 `localStorage['echolingo.lang']` 钉成 `zh` 再跑**，否则复用 profile 时断言会随机偏移
- 英语回归 `bench/test-english-regression.mjs`：三语界面漏翻样本都是 `[]`，识别 + 翻译 **4.2 秒**出正确结果，`异常: []`
- `bench/test-mode.mjs`：模式开关全过，无水平溢出（按钮 64x23 / 68x23）
- `tools/check-app-i18n.mjs`：三语各 **307** 条、markup/代码引用 **279** 个 key 全命中
- `tools/check-site-i18n.mjs`：三语各 **81** 条、markup 绑定 **79** 个 key 全命中
- 线上西语版实测 `bench/test-live-es.mjs`：三语界面全对、漏翻 `[]`，西语识别 + 翻译 **46.3 秒**（首次要下载缓存模型）
- Windows 包内容核对：解包后 `resources/site` **517 MB**，6 个模型齐全，包内 `APP_VER` 与
  `__ECHOLINGO_VER__` 都是 3.12.0
- macOS App 重打后实测可启动：`pgrep` 有进程、`curl 127.0.0.1:8731/index.html` 返回 200、
  COOP/COEP 三个头都在、截图里拖拽区标题在西语模式变长（标题带浅像素 137 → 191）

**双模式的关键实现落点（改之前先看这里）**

| 要做的事 | 落点 |
|---|---|
| 当前模式 | `app.js` `getMode()` / `S.mode` / `settings.mode`；开关 `app/index.html` `#modeSeg` |
| 识别语言 | `models.js` `modelLang(id)` → `asr-engine.js` 的 `language:` 参数（`.en` 模型不能传） |
| 翻译链 | `mt.js` `MT_CHAINS = { en:['opus-mt-en-zh'], es:['opus-mt-es-en','opus-mt-en-zh'] }` |
| 三行字幕 | `cue.text`（源语言）/ `cue.mid`（英文）/ `cue.zh`（中文）。⚠️ 源语言也存在名为 `en` 的键、译文存在 `zh`，是历史命名，别被名字骗了 |
| 三语开关 | `#langSeg` 三个按钮 `data-lang="en"/"mid"/"zh"`；`applyLangView()` 上 `hide-en`/`hide-mid`/`hide-zh` |
| 分词器 | `subtitle.js` 词元正则 + `dict.js` `normalizeWord`，都已 Unicode 化（`\p{L}`） |
| 朗读 | `tts.js` `setTTSLang()` / `speakIn(text,lang)`；音色 `settings.voiceEn` / `voiceEs`（旧字段 `voice` 自动迁移） |
| 收藏分区 | 条目带 `favLang`，列表与角标都按 `getMode()` 筛 |
| 遮罩自动定位 | `subtitle-mask.js` `scoreRows()` / `bandFromScore()`（纯函数，可离线重放）；采样入口 `app.js` `runMaskSeekScan()`（抽 14 帧）/ `startMaskLiveDetect()`（播放中采样） |
| 遮罩手动拖动 | `subtitle-mask.js` `createMask({ onBand })`：编辑层 `setEditing()` / 抓手 `onEditDown|Move|Up`；`app.js` `setMaskAdjust()` / `onMaskBand()` |
| 拖拽区标题 | `app.js` `applyDropzoneTitle()`（挂在 `applyModeView()`）；key 是 `dz.title` / `dz.titleEs`。⚠️ 选择器**必须写成 `[data-i18n="dz.title"], [data-i18n="dz.titleEs"]`** —— 这个函数自己会改 `dataset.i18n`，写死一个 key 就会在改完之后再也选不中自己（见 5.2） |

---

## 5.1 首页西语版这一轮踩到的三个坑（重要）

**① 裸表达式会被丢掉值。** `bench/cdp.mjs` / `cdp2.mjs` 把表达式文件包进
`(async () => { ... })()`。如果文件最后一行写成裸表达式（`JSON.stringify(x)`），
返回值是 **`undefined`**，不报错、不抛异常 —— 我因此白查了几轮，
还一度误以为是"页面脚本没跑起来"。**最后一行必须写 `return`。**

**② 这两个现成的驱动在官网首页上用不了。** 它们等的是
`window.__ready === true || document.readyState === "complete"`，而官网首页
既没有 `__ready`，语言没定下来之前 `body` 还是 `visibility: hidden` —— 会直接
抛"页面未就绪"。所以这一轮**新写了 `bench/test-site-i18n.mjs`**（等
`SITE_I18N` 与 `#langSeg` 出现，更贴合要测的东西）。测首页用它，别用 cdp.mjs。

**③ 窄屏溢出要跟"改动前"对照，别看见溢出就认账。** 我第一次在 520px 测到溢出，
差点当成自己加的按钮导致的。做了个"删掉 ES 按钮"的对照页一比才发现：
那次溢出是**测试导航状态残留**的假象；真实情况是 380px 才溢出。
再往下测才看清根因 —— **380/360 及以上是按钮的锅（现已修好），
340 以下则是这个页面的固有最小宽度问题，加不加按钮都一样溢**。
只测一个版本、没有对照，很容易得出"是我改坏的"或"跟我没关系"的错误结论。

---

## 5.1.b 3.12.0 这一轮踩到的坑（Windows 打包 + 拖拽区标题）

**① 「改自己的 key」的选择器会把自己弄丢。** `applyDropzoneTitle()` 一开始写成
`$('[data-i18n="dz.title"]')`，而函数体里又会把 `el.dataset.i18n` 改成 `dz.titleEs`。
于是**第一次切换（en → es）正常，切回来（es → en）静默失效** —— 选择器再也选不中那个
元素了，标题就永远停在「把西班牙语视频拖进来」。不报错、不抛异常。
**教训：一个元素如果会改自己的 `dataset.i18n`，所有找它的选择器都要把所有可能的 key 列进去。**
这个 bug 是让 `bench/test-dropzone-title.mjs` 卡在第 5 步才暴露的；人工点两下非常容易漏，
因为**第一次点是好的，错在切回来**。

**② electron-builder 会 spawn `npm`，没有 npm 就整个构建失败。**
报错是 `⨯ Node module collector spawn (npm ["list","-a","--include","prod",...]) failed: spawn npm ENOENT`。
哪怕这个应用**一个运行时依赖都没有**（随后它会自己退回遍历 `node_modules` 并打印
`no node modules returned while searching directories`），这一步照样要过。
本机的 `node` 是从 DSH runtime 借的、**不自带 npm**，所以在 `/tmp/npmbin` 放了个 shim：
`node` 软链 + `npm` 这个 shell 包装指向真实的 `npm-cli.js`，构建时 `export PATH="/tmp/npmbin:$PATH"`。
⚠️ 复制 `npm-cli.js` 时它的 `require('../lib/cli.js')` 是**相对它自己所在目录**解析的，
只拷 bin 不拷 lib 会报 `Cannot find module '../lib/cli.js'`。

**③ macOS 上打 Windows 包不需要 wine。** electron-builder 26 的 NSIS 用的是跨平台
`makensis`；日志里那几行 `signing with signtool.exe` 在没有证书时只是占位，没有真的签。
产物直接可用。

**④ `ELECTRON_RUN_AS_NODE=1` 这个坑又踩了一次。** 我的工具 shell 里导出着这个变量，
于是 `open -a EchoLingo.app` 和直接跑二进制**都会让 Electron 以纯 Node 模式启动**：
不报错、不打印、秒退。我一度以为是我改 `Info.plist` / `--deep` 重签把 App 弄坏了，
还重新打包了一遍 —— 其实 App 一直是好的。**在启动任何 Electron 之前先 `env -u ELECTRON_RUN_AS_NODE`。**
验证 App 真的起来的办法：`pgrep -f "EchoLingo.app/Contents/MacOS"` + `curl 127.0.0.1:8731/index.html`。

**⑤ macOS App 更新别手工拷文件进 bundle。** 直接 `cp` 进 `/Applications/EchoLingo.app` 再
`codesign --deep` 重签，看起来能过 `codesign --verify`，但 `CFBundleShortVersionString` 还是旧的。
**正确做法：`node desktop/build.mjs` 重新打一份，再 `ditto dist/EchoLingo.app /Applications/EchoLingo.app`。**

**⑥ Netlify 是 CLI 手动部署，不是 Git 自动部署。** 推 GitHub **不会**更新网站。
要跑 `bash desktop/.tools/deploy.sh`（它先 `cp -c` 拼一个 `.deploy/` 暂存目录再
`netlify deploy --dir=.deploy --prod`）。我一开始以为 push 完等一会儿就好，实测线上还是 3.11.0。

---

## 5.2 双模式（英语/西语）这一轮踩到的坑（重要）

**① 分词器原来是纯 ASCII 的 —— 这是西语第一步就卡死的地方。**
`subtitle.js` 的词元正则写的是 `[A-Za-z]`，西语被切得稀碎：
`¡Hola! ¿Cómo estás?` → `["Hola","C","mo","est","s"]`。
后果不只是"看起来怪"，而是**单词点不出来、词卡查不到、逐词时间戳错位、标记生词全坏**。
`dict.js` 的 `normalizeWord` 同样只认 a-z，把 `caminé` 削成 `camin`。
两处都已改成 Unicode 的 `\p{L}`，并用 `bench/test-tokenize.mjs` 保证
**英语行为逐 token 不变**。→ 教训：加一门语言之前，先确认"分词"这层认不认它的字母。

**② 三行字幕的中间行曾经串成中文。** 原因是 `MT.translateMany` 从 `from:'es'`
出发时**整条链跑到底**，直接返回了中文；而我要的是"西→英"这一跳的中间产物。
修法是让 `mt-worker.js` 把中间结果也报出来（回包 `{out, mid}`），
`translateAll` 改成**单趟链、逐跳取中间值**。→ 教训：多跳翻译里
"某一跳的结果"必须显式取，不能指望链尾；顺手还把翻译耗时砍了一半。

**③ 用像素测量图标前，必须先把主题钉成浅色。** 主题按钮的图标在浅色下是**太阳**、
深色下是**月亮**。我要量"新齿轮和太阳像不像"，结果 headless Chrome 落在深色，
**参照物其实是月亮**（月牙又长又连续），差点把我引到"像齿轮"的错误结论上。
现在脚本先写 `localStorage['echolingo.theme']='light'`，并断言参照物 markup 里
含太阳射线那条 path。→ 教训：**headless 下的默认主题是深色，别默认它是浅色。**

**④ 断言要基于实测几何，别凭想象。** 我以为齿轮外圈是"一整圈连续"（最长连通段 > 300°），
实测是**8 段宽齿身**（每段约 32°），于是判据改成"每段宽度 ≥ 2 倍"。
最终可判读的数字：环带角度覆盖率 旧图标 30.0% → 新齿轮 69.7%，
最长连通段 14° → 32°，与太阳的 IoU **0.518 → 0.095**（越低越不像）。
→ 教训：视觉判断**先量再断言**；判据写错了要改判据，不是改结论。

---

## 5.3 遮罩（自动定位 + 拖动）这一轮踩到的坑（重要）

**① 自动定位失败的真正原因不是"峰值找错了"，而是"按全局最大值归一化"。**
用户报的那条西语 Vlog 上，峰值行明明精准落在字幕上（161/180 = 89.4%），
但旧代码把 edge / change / variance 三路特征**各自除以自己的全局最大值**再调分。
画面是船头水面，**每一行**的 change 都有 2050~2930、variance 都有 5.5 万~8.8 万，
于是背景行也拿到 0.7~0.8 的相对分；增长阈值 `0.42 × 峰值 = 0.4043` 之下，
87 行搜索区里挤了 **80 行**，带宽算出来 46% > 22% 上限 → `return null`。
→ 教训：**背景行占绝大多数时不要用全局最大值归一化**，用中位数/MAD；
现在 `bandFromScore()` 还会要求 `峰值 - 背景中位数 ≥ 6`（这道门把噪声挡在外面）。

**② 真正有区分度的是 edge，不是 change/variance。**
字幕行 edge 是 1657 / 800 / 1029 / 866，背景行稳定在 319~359（差 2.4~4.6 倍）；
change 和 variance 则几乎没有区分度。权重重排后把 edge 当主特征。

**③ 合成帧**造不出**这个 bug。** 合成的"字幕带"用例里旧算法照样通过
（峰值 0.9992、15 行超阈值、结果还正好对），所以**必须拿真实素材的逐行剖面当回归用例**：
`bench/probe-mask-detect.mjs` 会把真视频的剖面落盘成 `bench/fixtures/mask-profile-vlog.json`，
`bench/test-band-detect.mjs` 的用例⑥读它重放，并**同时把旧算法原样重算一遍断言它必须返回 null**
—— 这样"这条素材曾经失败"就被钉住了，将来谁改坏了会立刻红。

**④ 静默失败：`scoreRows()` 忘了返回 `H`**，`bandFromScore()` 于是算出 NaN 比例。
**NaN 的所有比较都是 false，宽度检查反而"通过"了** —— 又是一个不报错的坏结果。
凡是纯函数返回一组数，先确认每个字段都不是 `undefined`。

**⑤ 拖动时监听器必须挂 `window`，不能只挂编辑层。** 指针一拖出画布就收不到
`pointermove` 了。`setPointerCapture` 只用来维持"抓取"光标，不能当作事件来源。

**⑥ 拖动范围必须和滑杆的 `min`/`max` 完全一致。** 第一版滑杆是 40/99 与 41/100，
拖到画面上方时滑杆会把值夹回去、显示和实际不一致。现在两边都是
**5%~97% / 8%~100%**（`subtitle-mask.js` 里的 `BAND_MIN_TOP` 等常量 + `app/index.html` 的滑杆属性）。

**⑦ 设置抽屉的 `.scrim` 是全屏 `position:fixed; z-index:40`，会挡住画面。**
所以进"在画面上调整位置"必须先 `closeDrawers()`，而出口也就**只能做成浮在画面上的
「完成」按钮**（只放抽屉里等于没有出口）。这条是实测才发现的设计约束。

**⑧ 测拖动别依赖 900MB 的真素材。** 机器上没有任何小视频文件，但**页面里可以现场录一个**：
`canvas.captureStream(25)` + `MediaRecorder('video/webm')` 录 1.5 秒 640×360（加一条 `gain=0`
的静音轨免得音频解码那步失败），再用 `DataTransfer` 塞进 `#fileVideo` 派发 `change` ——
走的是**真实的导入链路**（`S.file` / `videoWidth` / localStorage 全是真的），几秒钟跑完。
注意：`Page.reload` 会清空 file input，没有 `src` 时 `#player:not([src])` 的
`display:none` 会生效、遮罩量不到位置，**所以刷新后必须重新导一次视频**。

---

## 5.4 关掉 Netlify「Powered by Netlify」浮层（3.12.1，重要）

**它是什么**：Netlify 给免费站自动注入的 HUD，**不是我们页面的元素**。
注入形式是页面末尾（在 `</html>` **之后**）的
`<script async src="/.netlify/scripts/hud?variant=public" data-nf-variant="public" ...>`。
它挂一个 `position:fixed; bottom:0; right:0; z-index:2147483645`（21 亿）、
**202×64** 的跨域 iframe，钉死在右下角，会盖住页面右下角的内容。

**为什么只能关、不能挪**：翻遍它 34 KB 的源码，**没有任何拖动实现**
（无 `pointerdown`/`mousedown`/`touchstart`，也没有动态改 `left`/`top` 的代码），
位置是写死在注入 iframe 的 inline style 上的；而且是**跨域 iframe**，
我们页面的 JS 碰不到它内部，没法给它加拖拽。它自带的按钮只有隐藏/最小化/关闭/看站点工具。

**关掉的机制**：HUD 启动时**第一件事**是读 `localStorage` 的
`nl-hud:<variant>:v1`，读到 `"hidden"` 就 `return` —— **连 iframe 都不创建**
（源码里 `const saved = readState(); if (saved === "hidden") return;`）。
它自带那个「隐藏」按钮走 `postMessage` 写的也是同一个 key。
我们改不了跨域 iframe，但**能写自己站的 `localStorage`**，所以在两个页面的
`<head>` 里同步写好标记，早于 `async` 的 HUD 脚本执行：

```js
try {
  localStorage.setItem('nl-hud:public:v1', 'hidden');        // 公开访客看到的徽章
  localStorage.setItem('nl-hud:owner-private:v1', 'hidden'); // 站点所有者自己访问时的工具条
} catch (e) {}
```

两页都改了：`index.html`（官网首页，行 40-41）与 `app/index.html`（工具页，行 42-43）。

**① 必须放在 `<head>` 里、且在任何 `async`/`defer` 脚本之前。**
HUD 脚本是 `async` 的，谁先跑不确定；写晚了徽章可能已经挂上。
`<link rel="stylesheet">` 在它前面**没关系**（CSS 不执行 JS，只阻塞渲染）。

**② 必须用 `try/catch`。** 隐私模式下 `localStorage.setItem` 会抛异常，
不能因为一个徽章把整页弄坏。

**③ 这是治标不是治本。** 标记存在**访客自己的浏览器**里，靠我们页面的 JS 每次写入。
Netlify 哪天改 key 名或机制，就得跟着改。真要治本得去掉那个浮层，那不在我们手里。

**④ 排查时最容易踩的坑：标记字符串在注释里也出现过。**
`nl-hud:public:v1` 这几个字在代码上方的**注释**里也写着，
所以门禁如果只 `indexOf('nl-hud:public:v1')`，把真正的 `setItem` 调用删掉、
注释还在，检查会**误判为通过**。两个门禁都必须匹配
`setItem('nl-hud:public:v1'` 这个**调用**（已用负向测试验证）。

**⑤ 验证时注意 `</body>` / `</head>` 会先出现在注释里。**
`index.html` 第 13 行的注释里就写着「下面的 fill() 在 `</body>` 之前同步跑完」，
用 `indexOf('</body>')` 会命中这句注释（位置 763）而不是真正的标签（行 645）。
写负向测试要用 `lastIndexOf` 或按行号定位。

**⑥ 线上徽章没消失先怀疑缓存/旧标签页，别急着改代码。**
本次用户反馈「宣传页徽章没弄」，实测线上文件字节与本地**完全一致**、
标记位置正确、连拉 10 次 ETag 不变、全新档案与旧档案都复现不出来、
用 CDP 把 HUD 脚本**故意拖慢 2.5 秒**也复现不出来 ——
最后是用户浏览器里**部署前就开着的旧标签页**，刷新即可。

**⑦ 两页的 variant 都是 `public`**（curl 匿名访问拿到的），
但**站长自己登录时 Netlify 会给 `owner-private`**（工具条而非徽章）。
这个场景 headless 模拟不了，所以两个 key **都要写**。

**入口**：`tools/check-site-i18n.mjs` 与 `tools/check-app-i18n.mjs` 各加了一条
HUD 标记门禁（存在性 / 在 `</head>` 内 / 其前无 `async`·`defer` 脚本 / 有 `try/catch`）。

---

## 5.5 官网首页换海水背景 + 液态玻璃（3.12.1 之后，只动根目录 index.html）

**用户诉求**（原话拆成两条）：
①「给第一个网站的背景改成第二张」+「你能不能让第二张图片动起来？」
②「其他的按键什么的改成液态玻璃高透」。

**背景三层结构**（都在 `<body>` 最前面，`z-index` 为负、纯装饰、`aria-hidden`）：

| 层 | 作用 | 关键值 |
|---|---|---|
| `.sea-bg` | 兜底底色 + 承载 `::before` 的照片 | `position:fixed; z-index:-2; background:#061420` |
| `.sea-bg::before` | 照片 + Ken Burns 动画 | `inset:-6%`（给位移留余量）、`animation: kenburns 48s ease-in-out infinite alternate` |
| `.sea-veil` | 深蓝渐变压暗 | `z-index:-1`，`.74 → .66 → .64 → .84` |
| `.scrim::before` | 垫在裸文字下面的**局部**补压 | `radial-gradient` + `rgba(4,12,22,.42→0)` |

照片三档 `shots/sea-bg-{800,1280,1920}.jpg`（16:9 裁切，quality 82），
靠媒体查询切换：`≥1500px` 用 1920、`≤820px` 用 800、其余 1280。

**① 压暗和配色的数值是「扫」出来的，不能估。**
这是个反直觉的地方：第一版把整页压到 `.86`，六种文字色确实全过 4.5:1，
但脚本一量 —— 照片只剩 **15.9%** 的层次感，海水**几乎看不见了**，等于白换背景。
最终取 `.64~.84`（保留 **30.3%** 层次）+ 局部 scrim `.36`，把「压暗整页」和
「保证文字可读」拆成两件事分别管。验证脚本扫的是
`1280×720 照片 × 每个像素的压暗 alpha` 取**最坏像素**的对比度，不是取平均值。

**② 压在照片上，文字分级只能靠「调亮」，不能靠「调暗」。**
旧的三级文字 `--text-3: #737e92` 在压暗后最亮的海水上只有 **3.03:1**，
怎么压都不达标（继续压暗会把海水压没）。所以三级文字被**提亮**成 `#aab5c6`
（实测 6.00:1）。最终三档文字 `#f2f6fd` / `#c3ccdb` / `#aab5c6`，
链接 `#6fb1ff`（5.57:1）。

**③ Ken Burns 幅度必须小。** 48 秒一个来回、缩放只到 `scale(1.06)`。
再大就不是「背景在呼吸」而是「能看出在动」，反而分心。
`prefers-reduced-motion: reduce` 下**必须** `animation: none` —— 这是无障碍硬要求，
门禁会拦。

**④ `.scrim::before` 的负 `inset` 会撑出横向滚动条（本次踩到）。**
`position:absolute` 的元素用负 `inset` 往外扩，**真的会撑宽可滚动区域**。
hero 的 `.wrap` 本身已经贴满视口（左右各 24px padding），它的 scrim 只要
横向扩 **14px**，390/360px 下 `scrollWidth` 就比 `clientWidth` 大 14px。
修法是给 `.hero.scrim::before` 单独写 `inset: -18px 18px`（横向**内缩**到 padding 里），
羽化交给径向渐变自己完成。门禁专门加了一条「hero scrim 横向 inset 不许为负」。

**⑤ `<pre>` 里的超长行会把整页撑宽。** 首页代码块里那行 160 字符的构建说明
（`node build.mjs  # → ../dist/EchoLingo.app`）会让 `<pre>` 按内容宽度撑开自己。
`<pre>` 虽然已经有 `overflow-x:auto`，但**还需要 `max-width:100%` + `min-width:0`**
才会把滚动限制在 `pre` 内部。缺这两个属性时，360px 视口下 `scrollWidth` 会多 14px。

**⑥ 液态玻璃的令牌是一组，不是一个 `backdrop-filter`。**
`--glass-bg`（半透明底）、`--glass-bg-strong`（顶栏用，更实）、`--glass-bg-soft`、
`--glass-blur` / `--glass-sat`、`--glass-edge`（**关键**：`inset` 白边做上沿反光 +
底部暗边做厚度，去掉就退化成普通半透明色块）、`--glass-line`、`--glass-shadow`。
统一用在顶栏 / 按钮 / 徽章 / 语言切换 / 卡片 / 截图框。
两个刻意**不用**玻璃的地方：`.card` 里不嵌套玻璃（玻璃叠玻璃会互相采样，
部分浏览器发灰发脏）、`pre` 背景 alpha 给到 **.72**（代码要长时间盯着看，
背景透出海水波纹伤眼）。另需 `@supports not (backdrop-filter: blur(1px))` 的退化分支。

**⑦ 验证截图不要放 `shots/`。** `desktop/.tools/deploy.sh` 是
`cp -Rc shots .deploy/shots` —— **整个目录上传**。`shots/` 是页面素材目录，
我这次的验证截图 11 MB 会被一起传上线。已改用 `.verify-shots/`（已进 `.gitignore`）。

**实测（headless Edge + CDP，真渲染后逐元素算合成底色对比度）**：
- 本地 **39/39**、线上 **39/39**、线上专项 **13/13** 通过
- 12 个文字元素对比度最低 **8.98:1**（页脚/CTA 小字），最高 17.17:1，全部 ≥4.5:1
- 7 类玻璃面 `backdrop-filter` 全部生效；徽章 iframe 仍为 **0**
- 线上首屏可感知纹理块占比 **49.6%**、蓝色主导、纵向亮度 41→80→34→44→59 —— 海水确实看得见
- 六档宽度（1440/1024/820/520/390/360）**全部无横向溢出**
- 三语 zh/en/es 切换正常无漏翻；英语回归 `bench/test-english-regression.mjs` 无异常

**门禁**：`tools/check-site-i18n.mjs` 新增第 7 项（**28 条检查**）：三层结构与
`z-index`、三档图片存在**且被 CSS 引用**、兜底底色、`@keyframes kenburns`、
`reduced-motion` 开关、`will-change`、hero scrim 横向 inset 非负、玻璃令牌齐全、
6 个玻璃选择器生效、`pre` 背景 alpha ≥.6、`@supports` 退化分支、
四个文字色在最亮海面上的对比度。**6 个负向测试全部能拦下**
（删 reduced-motion / 改坏图片引用 / 调暗三级文字 / hero scrim 转负 /
去兜底色 / 删图片文件）。

**提交**：`b052b80`。**本次只动根目录 `index.html` + 门禁 + 3 张背景图 +
`.gitignore`，`app/` 未改，版本号仍是 3.12.1**（按 §5 的约定，
只改官网首页时打包那几步可以跳过）。

---

## 5.6 官网首页浅色模式与「黑影子」的教训（3.12.1，重要）

这一轮用户提了两件事（原话：「你不觉得这个黑色的影子特别奇怪吗？ 并且再给我做一个浅色模式」）。
两件都做完了，但**第一条是我上一轮自己造的 bug**，值得完整记下来。

**① 那个「黑影子」是 .scrim，是我加的一块补压面板。**
上一轮为了保证文字对比度，我在有裸文字的地方垫了一层 `.hero.scrim::before`。
它的问题不在颜色，而在**边界是硬的**：实测那处亮度一步跳 16 级
（`elementFromPoint` 与逐像素扫描都能看到），而且从 hero 上沿一直盖到页面底部，
于是看起来不是「阴影」，而是一块**糊在照片上的脏斑**。

**② 拆掉它以后，对比度是真的会掉。**
裸文字直接压在海水上时，三级文字 / 链接 / 成功色只有 3.8 / 3.5 / 3.4:1，全部不合格。
这是「面板」和「压暗」两种做法的根本区别：面板能局部加深，压暗只能整体加深。

**③ 正确的解法是加深压暗层本身，而不是盖板子。**
压暗档位从 `.74/.66/.64/.84` 提到 `.84/.78/.76/.90`，
同时把压暗层的**横向**变化做强（`×0.38` 基线 + `.32` 横向起伏）——
让「哪里该亮、哪里该暗」由照片本身承担。结果全局最低 5.04:1，
而且不再是一块均匀的暗，而是一张**逐渐压暗的照片**。
验收标准我定成了可量化的：**整页 0 条贯穿页面的竖直硬边**（两个主题都是），
这条已经写进 `bench/test-theme-contrast.mjs`。

**④ 浅色模式的思路和深色完全相反，不能把颜色反过来就完事。**
- 深色：照片 **压暗**（×0.40）+ 文字**提亮**。要防的是**最暗的底**。
- 浅色：照片**降饱和**（`ImageEnhance.Color(...).enhance(0.34)`）+ 与近白混合
  （`.66`）+ 白纱，文字**加深**。要防的是**最亮的底**。
两者的「最坏情况」在相反方向，所以两套对比度必须分开算。
背景图出两套（深浅各三档共 6 个文件，合计 0.5 MB），
靠 `:root[data-theme="light"] .sea-bg::before` 切换 —— 只换图，不重排版。

**⑤ 令牌两套必须逐 key 对齐，否则会「静默继承」。**
`:root, :root[data-theme="dark"]` 与 `:root[data-theme="light"]` 各 45 个 key。
浅色块少写一个 key 不会报错，会**默默用深色的值** —— 深色文字压在浅色底上就是不可读。
门禁第 7 项现在会比对两套 key，并分别算两套 6 个文字色的对比度。

**⑥ 硬编码颜色是切主题的隐形杀手。**
改完主题后门禁报「规则体里有 17 处硬编码颜色」：按钮渐变、玻璃高光边、
卡片成功/警告边框色全是写死的。它们**不跟着主题变**，浅色下会露出深色残留。
已全部令牌化（`--brand-grad` / `--btn-grad` / `--glass-solid` / `--header-shine` 等）。

**⑦ 窄屏 CTA 要把文字收成图标，并用 aria-label 保住可读性。**
390/360px 横向溢出 19px：logo + 中文/EN/ES + 外观键 + 「打开工具 →」一行放不下。
窄屏用 `.nav-links > .btn .txt { display: none }` 只留箭头，
同时新增 `data-i18n-aria="nav.open"` 让 aria-label 跟着语言切
（`fill()` 里补了对应的处理，门禁也认这个属性）。

**⑧ `.wrap` 光有 `max-width` 挡不住子元素撑破父容器。**
`.wrap` / `section` / `.nav` / `.logo` 都补了 `min-width: 0`。
表现是：`pre` 自己有 `overflow-x:auto` 也确实在内部滚了（`scrollWidth` 453 > `clientWidth` 356），
但页面的 `document.scrollWidth` 依然被撑到 409 —— 因为**同一行的 header 也在撑**。
排查时不要只盯着那个「看起来超宽」的 pre，要把每个 `overflow-x: visible` 且越界的元素都列出来。

**⑨ 门禁自己也会被字符串骗到（第二次）。**
`for (const ic of ['i-auto','i-sun','i-moon']) if (!html.includes(ic))` ——
CSS 规则 `:root[data-theme-pref="dark"] #btnTheme .i-moon` 里也有这几个字，
所以把 SVG 上的 class 删掉、CSS 规则还在，检查照样通过。
必须匹配 `<svg[^>]*class="i-moon"`。
**同类坑上一轮也踩过**（`nl-hud:public:v1` 在注释里也出现，见 §5.4 ④）。
教训固定成一句：**门禁要匹配「结构」，不要匹配「出现过这个字符串」。**

**⑩ 注释里写出标签字面量会骗到「找第一个 <style>」这类检查。**
我在脚本注释里写了「必须在 `<style>` 之前跑完」，结果 `html.indexOf('<style>')`
返回的是**注释里那处**（位置 1368），而不是真正的样式表（2757 之前）。
门禁改用 `html.search(/^<style>/m)` 按行首匹配，注释里也不再写这个字面量。

**⑪ 清理 headless 实例千万别 `pkill -f "Microsoft Edge"`。**
它会把**用户正在使用的 Edge 窗口一起杀掉**，还会留下残留的 `SingletonLock`，
导致用户再点图标时「打不开」。`bench/test-theme-contrast.mjs` 用独立的
`--user-data-dir`（前缀 `echolingo-theme-`）并只清理属于本脚本的进程，
这条约定写在脚本头部的注释里了。

**⑫ 验收脚本要防「还没导航就操作」。**
`Page.navigate` 还没生效时执行 `localStorage.setItem` 会抛
`SecurityError: Access is denied for this document`（那时还在 `about:blank`）。
加了 `waitForOrigin` 守卫：没导航成功就明确报
「检查 URL_BASE 与服务是否在跑」，而不是抛一个看不懂的 SecurityError。

**入口**：`node tools/check-site-i18n.mjs`（静态门禁，第 7 项 40 条检查）、
`node bench/test-theme-contrast.mjs`（真实浏览器，38 条断言，两主题）。
两个都要跑。

---

## 6. 下一步（没有进行中的任务，这些是可选）

1. ~~官网首页缺西语版~~ —— 已完成（3.9.0）。
2. ~~双模式 / 三行字幕 / 西语词卡与发音 / 收藏分区 / 齿轮图标~~ —— 已完成（3.10.0）。
2b. ~~遮罩自动定位不准 + 不能在画面上拖动~~ —— 已完成（3.11.0）。
   剩下的可选打磨：遮罩位置目前是**全局一份**（`settings.mask`），不是每个视频各记一份；
   如果用户换视频频繁地手动调，可以考虑按视频文件名存。
2c. ~~拖拽区标题按模式切换 + Windows 版发布~~ —— 已完成（3.12.0）。
   Windows 包没有代码签名证书，SmartScreen 会提示「未识别的应用」，用户需点「更多信息 → 仍要运行」；
   想消掉这个提示只能买证书。另外 Windows 版目前**只在 macOS 上交叉编译、没有在真 Windows 机器上跑过**，
   如果用户反馈起不来，第一件事是让他在 Windows 上跑一次并回报错误。
3. **西语识别质量的天花板是多语言 `whisper-base`。** 真 Vlog 上有几句确实听错
   （`lago Argentino` → `lago alantino`、`compartir` → `compartible`）。
   这是 base 模型 + 有背景音乐的口播的**固有限制，不是链路 bug**。
   想更好只能上更大的模型（`models.js` 里目前只挂了 base / tiny）。
4. 西语直译（想摆脱"西→英→中"两跳）需要自己转 `opus-tatoeba-es-zh` 到 ONNX，成本见决策表。
5. 用户可能会提新的语言（日语/法语…）。**做法已经成熟**：
   ① **先看分词层认不认这门语言的字母**（见 5.2 ①，就是那条 `\p{L}`）
   ② 找多语言 whisper（已有）
   ③ 找 `Xenova/opus-mt-<lang>-en` + 复用 en→zh（先确认 HF 上有没有）
   ④ `models.js` 加 `lang` 字段 + 模型条目
   ⑤ `mt.js` 的 `MT_CHAINS` 加一条链
   ⑥ 左上角模式开关加一档（`#modeSeg`）+ `i18n.js` 补一份界面字典（用脚本校验 key 一致性）
   ⑦ **官网首页也要补一份**（`index.html` 的 `SITE_I18N`）——
      两处语言列表都要改：`<head>` 里的语言探测脚本（那个 `LANGS` 数组）
      和切换按钮。**别只改一处**，否则又是"静默落到英文"。
   ⑧ 重新下模型、打包、部署、推送

---

## 7. 工作方式约定（给新会话）

- **不要相信"应该没问题"**：改完必须实测。特别是碰了 `asr-engine.js` / `mt.js`
  这类英语链路也在用的文件，**一定要跑英语回归**（`bench/test-english-regression.mjs`）
- **改完代码要同步五处**：本地 → `desktop/build.mjs` 重新打包 → 装到 `/Applications`
  → `deploy.sh` 部署网站 → `push-loop.sh` 推送 → **（有 Windows 版之后）`npx electron-builder --win --x64`
  重打 Windows 包**。**最容易漏的是"装到 /Applications"**，其次是 Netlify 那步
  —— **推送不会自动更新网站，必须手动跑 `deploy.sh`**（实测教训，见 5.1.b ⑥）。
- **版本号五处要一起改**：`app/js/app.js` 的 `APP_VER`、`app/index.html` 的
  `__ECHOLINGO_VER__`、`app/sw.js` 的 `VERSION`（sw 再 +1）、`package.json` 的 `version`
  （electron-builder 用它命名产物）。**官网首页 `index.html` 不带版本号**，不用改（改了也没人读）。
- **改 `app/` 里的东西会同时进 macOS App、Windows 包和网站 `/app/`**，
  只改根目录官网首页时打包那几步可以跳过。
- **启动 Electron 前先 `env -u ELECTRON_RUN_AS_NODE`** —— 本机工具 shell 里导出着这个变量，
  不清掉的话 Electron 会以纯 Node 模式秒退，看起来像"App 坏了"（见 5.1.b ④）。
- 长任务放后台跑（下载/打包/推送/部署），不要让它阻塞对话
- 用户要求"先看效果"时，**做真实预览**（注入运行中的 App 再截图），不要用 PS 假图
- 判断视觉效果**要用像素测量**，别只看放大截图（我曾因此误判"模糊没生效"，白查好几轮）
- **本机会话读不了图片**（模型不声明图像输入），所以"看图"只能靠 PIL 量像素分布来判断

---

## 8. 快速上手

```bash
# 跑起来看
python3 tools/serve.py 8765 --open       # 官网 / ，工具 /app/

# 改完代码 → 五处同步
cd desktop && node build.mjs             # 打包 macOS
ditto dist/EchoLingo.app /Applications/EchoLingo.app   # ← 别漏这步
export PATH="/tmp/npmbin:$PATH"          # npm shim，见 5.1.b ②
npx electron-builder --win --x64         # 打包 Windows → release/*.exe
bash desktop/.tools/deploy.sh            # 部署网站（几秒；push 不会自动部署！）
bash desktop/.tools/push-loop.sh         # 推 GitHub（带重试）

# 看 App 是否真的起来了（ELECTRON_RUN_AS_NODE 必须先清掉）
env -u ELECTRON_RUN_AS_NODE open -a /Applications/EchoLingo.app
pgrep -f "EchoLingo.app/Contents/MacOS" && curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8731/index.html

# 测试（各脚本自带 CDP 端口，互不相撞；端口对不上时以脚本里的默认值为准）
node bench/test-english-regression.mjs 8910   # 英语回归（改过共享代码必跑）
node bench/test-tokenize.mjs                  # 分词器：西语不被切碎 + 英语逐 token 不变
node bench/test-mode.mjs 8910 9338            # 左上角模式开关 + 模式驱动识别模型
node bench/test-mode-redo.mjs 8910 9339       # 切模式确认弹窗（取消 / 确认后重识别）
node bench/test-three-line.mjs 8910 9340      # 西语三行字幕 + 三语开关
node bench/test-es-wordcard.mjs 8910 9342     # 西语词卡中文释义 + 西语语音 + 音色按模式
node bench/test-fav-partition.mjs 8910 9344   # 收藏按模式分区
node bench/test-dropzone-title.mjs 8910 9365  # 拖拽区标题按模式切换 + 三语界面（5 个状态，5 项）
node bench/test-settings-gear.mjs 8910 9346   # 齿轮图标（像素测量：环带覆盖 / 齿段宽度 / 与太阳 IoU）
node bench/test-band-detect.mjs               # 遮罩检测算法（纯 Node：合成帧 + 真实剖面重放，16 项）
node bench/test-mask-adjust.mjs 8910 9352     # 画面上拖动遮罩（现场录小视频走真实导入，33 项）
node bench/test-mask-detect-vlog.mjs 8910 9354 # ★ 真西语 Vlog 自动定位（要 914MB 素材，几秒出结果）
node bench/probe-mask-detect.mjs 8910 9350    # 探针：打印检测器结论 + 逐行剖面 + ASCII 亮度图，并落盘 fixture
node bench/test-es-vlog.mjs 8910 9348 3600    # ★ 端到端：914MB 真西语 Vlog 走完整链路（几分钟）
node bench/test-spanish-full.mjs              # 西语 + 三语界面

# 工具界面字典（改过 app/js/i18n.js 或 app/index.html 就跑这个）
node tools/check-app-i18n.mjs                 # 三份字典 key 一致性 + markup / 代码引用全部命中

# 官网首页（改过 index.html 就跑这两个）
node tools/check-site-i18n.mjs           # 三份字典 key 一致性 + markup 绑定
node bench/test-site-i18n.mjs            # 真实 Chrome 三语渲染（需先起 8765）
node bench/shot-site.mjs                 # 三语全页截图 → shots/site-i18n/
```

## 9. 文档索引

| 文件 | 内容 |
|---|---|
| **`SESSION-HANDOFF.md`**（本文件） | 会话转移：用户诉求、决策、进度、下一步 |
| `HANDOFF.md` | 项目技术交接：架构、**踩过的坑清单**、命令、测试脚本 |
| `README.md` | 面向使用者的说明（功能、精度、六条硬约束、目录结构） |
| `desktop/README.md` | 打包细节（为什么不用 packager、ELECTRON_RUN_AS_NODE 坑） |
| `bench/OPTIMIZATION-FINDINGS.md` | 最初的性能实测报告 |
