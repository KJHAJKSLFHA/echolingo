# EchoLingo 交接文档

> 这份文件是为了压缩一个很长的开发会话而写的。它记录**当前状态**、**这一轮做过的改动**、
> 以及**踩过的坑** —— 尤其是坑，那些是最花时间、最容易重复犯错的地方。
>
> 最后更新：版本 3.8.0 · 提交 `2640446`

---

## 一、项目是什么

**EchoLingo · 回声英语**：外语视频精读工具。导入视频 → 自动识别每一句话 → 右侧原文与中文对照、
逐词跟读高亮 → 点词查释义/发音、整句朗读与收藏。**识别与翻译全部在本机完成，视频不出本机。**

- 支持语言：**英语、西班牙语**（识别）
- 界面语言：**简体中文 / English / Español**
- 纯离线优先；在线版只有首次需要联网下模型

## 二、四个出口（都在 3.8.0 / 同一份代码）

| 出口 | 位置 | 状态 |
|---|---|---|
| 网站 | https://echolingo-reader.netlify.app | 官网 `/`，工具 `/app/` |
| macOS App | `/Applications/EchoLingo.app` | 790 MB，模型内置，双击即用 |
| GitHub | github.com/KJHAJKSLFHA/echolingo | 公开，已同步 |
| 本地源码 | 本目录 | `app/js/app.js` 的 `APP_VER` |

## 三、目录结构（重构后）

```
/
├── index.html            产品官网首页（中/英双语，自带 i18n）
├── _headers              Netlify 响应头：COOP/COEP 只给 /app/*
├── app/                  工具本体
│   ├── index.html css/ js/ dict/ vendor/ media/
│   ├── models/           6 个模型，共 477 MB
│   └── sw.js manifest.webmanifest
├── desktop/              打包脚本（零依赖）
│   ├── build.mjs         下 Electron → ditto 解压 → 手工组 bundle → ad-hoc 重签
│   └── .tools/           （gitignore）Netlify CLI、gh、一键脚本
├── shots/                官网用的 6 张实拍截图
├── bench/                测试脚本（见第七节）
└── server.js tools/serve.py  本地服务器
```

**模型（`app/models/`，共 477 MB）**

| 目录 | 体积 | 用途 |
|---|---|---|
| `whisper-base.en` / `whisper-tiny.en` | 77 / 42 MB | 英语识别（`.en` = 纯英语专用，更准更快） |
| `whisper-base` / `whisper-tiny` | 78 / 43 MB | **多语言版**，用于西班牙语识别 |
| `opus-mt-en-zh` | 117 MB | 英→中 |
| `opus-mt-es-en` | 117 MB | 西→英（西语两跳的第一跳） |

## 四、这一轮做过的改动

### 1. 修复长视频识别为空（严重 bug）
`asr-engine.js` 原本是 `return_timestamps: wordTimestamps ? 'word' : true`。
这个 vendor 版 transformers.js 里 **`true` 对「从连续语音中间切出的段」会返回空文本**，
而 `wordTs` 默认 `auto` 且「≥25 分钟就关闭逐词」→ **长视频一个字幕都出不来**。
现在只用 `'word'` 或 `false`，失败也退回 `false`；并为 `false` 补了 `textToWords()`
（按标点切句 + 按长度分摊时间）。**实测逐词只比不要时间戳贵 13%。**

### 2. 首屏出句从 18 秒降到 8 秒
右侧只渲染**连续前缀**，而派发顺序是「最长的先派」→ 时序最靠前的段排在队尾。
实测 14 分钟视频：后台 17 秒时已跑完 11 段，右侧却还写着「已得到 0 个词」。
改成「最前面 slots.length 段按时序优先，其余仍长的先派」：**18.1s → 8.0s，
第一屏 6 句 → 25 句**，总时长基本不变。

### 3. 画面字幕遮罩（新功能）
把**烧录进画面**的英文字幕就地模糊，逼自己先听。`app/js/subtitle-mask.js`。
- 用 `backdrop-filter` 让合成器糊背后的像素：不复制视频帧、不逐帧重绘
- 位置按 `object-fit: contain` 换算，窗口缩放 / 面板收起都会重算
- 四种样式：柔和模糊（默认）/ 毛玻璃 / 马赛克 / 纯色条
- 自动定位：播放中静默采样（不打断观看），或点按钮跳着抽 14 帧扫全片
- 按住 `Alt` 临时看原文

### 4. 右侧中英文独立收起 + 整个面板收起
- `E` / `C` 分别隐藏英文/中文；用**容器 class** 切换（识别时每 500ms 重排一次，切 class 零成本）
- `H` 或点面板边缘竖排把手收起整个面板（26 px），视频区 857 → 1378 px
- 两个都关时显示提示，不让用户以为坏了

### 5. 产品官网 + 网站重构
- 根目录 `index.html` 改成产品官网，工具移入 `app/`
- 官网自带中英双语（`data-i18n` + 字典，语言在 `<head>` 同步脚本里定好，不闪）
- `_headers` 只给 `/app/*` 发 COOP/COEP

### 6. 西班牙语支持（本轮最大改动）
- **识别**：新增多语言版 whisper-base/tiny；`models.js` 给每个模型加 `lang` 字段
- **翻译**：`mt.js` 从单模型改成**模型链**，`mt-worker.js` 逐级套
- **界面**：新增完整西语字典 281 条，三语 key 完全一致（零缺失）
- 顶栏语言按钮改成三语轮换：中文 → English → Español

## 五、踩过的坑（重点，别重复踩）

### 环境/网络
1. **`ELECTRON_RUN_AS_NODE=1`** 会让任何 Electron 二进制被当成 Node：
   `--version` 打印 Node 版本、任何参数都报 `bad option`。从 Finder 启动不受影响。
2. **Netlify 新账号默认 `sso_login: true`** → 部署后访问返回 **401**。
   关掉：`netlify api updateSite --data '{"site_id":"...","body":{"sso_login":false}}'`
3. **@electron/packager 在 macOS 27 上跑不通**：`@electron-internal/extract-zip` 是 napi 原生模块，
   被系统库校验拒绝（Team ID 不一致）。所以 `build.mjs` 零依赖：自己 fetch zip + `ditto` 解压。
4. **这台机器出网间歇性抽断**：同一分钟里 github 可能 0.9s 返回、下一分钟连 75 秒超时。
   所以推送/下载都要**带重试 + 断点续传**（见 `desktop/.tools/*.sh`）。
5. **`~/Library/Caches` 等系统目录写不进去**：`@electron/get` v5 不认 `ELECTRON_CACHE`，
   缓存路径由 `os.homedir()` 推出 —— 靠 `HOME` 重定向解决。

### 代码
6. **`server.js` 解析目录后没重新 stat**：把 `file` 改成 `index.html` 却把 `st` 置 null，
   于是 `isFile()` 必然失败 → 所有子目录掉进首页兜底。表现是「打开 `/app/` 却是官网首页」，
   **不报任何错**。
7. **`tools/serve.py` 默认 HTTP/1.0**：每条响应后断开连接。工具的模块图十几个并发请求，
   浏览器会**随机**掐掉几个 → `Failed to fetch dynamically imported module`，
   而且每次失败的文件都不一样，极难查。改成显式 `protocol_version = "HTTP/1.1"`。
8. **`backdrop-filter` + `mask-image` 羽化开太大**：字幕正好落在羽化区里，
   笔画上半截没糊干净，留一排黑点。羽化收到 14%，并给检测出的字幕带上下各加 30% 余量。
9. **纯色遮罩 `rgba(...,0.94)` 会漏字**：白字幕有 10% 透光；改 0.984 后实测仍有 **6.7%**。
   「纯色」就用 `alpha = 1`，数学上不可能透。
10. **`.en` 后缀的 whisper 是纯英语模型**：喂西语只会得到一串「看起来像英语、实际毫无意义」
    的句子，**而且不报错**。西语必须用多语言版，且要传 `language: 'es'`。
11. **`node --check` 对 ES module**：复制成 `.mjs` 再 check 才准。

### 判断失误（教训）
12. **我把截图放大后误判「模糊没生效」**，来回查了好几轮，最后用**像素测量**才发现是错觉
    （放大 + JPEG 压缩把 4 个灰阶的差放大了）。**结论：判断视觉效果要用像素数据，不能只看放大图。**

## 六、常用命令

```bash
# 本地跑
python3 tools/serve.py 8765 --open      # 官网首页在 /，工具在 /app/

# 重新打包 macOS App
cd desktop && node build.mjs            # → ../dist/EchoLingo.app
ditto dist/EchoLingo.app /Applications/EchoLingo.app   # 装到应用程序（记得这步！）

# 重新部署网站（几秒）
bash desktop/.tools/deploy.sh

# 推送到 GitHub（带重试，可断点续传）
bash desktop/.tools/push-loop.sh

# 下西语相关模型
python3 tools/fetch-spanish-models.py
```

## 七、测试脚本（`bench/`）

| 脚本 | 用途 |
|---|---|
| `test-spanish-full.mjs` | 三语界面漏翻扫描 + 西语识别翻译（本地） |
| `test-live-es.mjs` | 同上，指向线上地址 |
| `test-english-regression.mjs` | 英语链路回归（西语改动了 mt.js / asr-engine.js，必须验） |
| `test-collapse.mjs` / `test-lang.mjs` / `test-mask.mjs` | 面板收起 / 中英开关 / 字幕遮罩 |
| `es-test.wav` / `en-test.wav` | 用 macOS `say` 合成的测试音频（已 gitignore） |

测试音频重建：
```bash
say -v "Mónica" -r 165 -o /tmp/es.aiff "Hola, bienvenido a esta práctica de escucha. ..."
afconvert /tmp/es.aiff -f WAVE -d LEI16@16000 -c 1 bench/es-test.wav
```

## 八、验证结论（都实测过）

- **西语识别**：与合成原文**逐字吻合**
- **西→英→中**：意思正确（偶尔「欢迎欢迎」这类两跳重复）
- **英语回归**：识别与翻译正常，4.2 秒（单模型链，比西语两跳快）
- **三语界面**：281 key × 3 语言，**零缺失/零漏翻**
- **字幕遮罩**：四种样式都彻底遮住；窗口缩放跟随（三种尺寸下偏移完全一致）
- **面板收起**：857 → 1378 px；刷新后仍保持；遮罩自动重算

## 九、遗留 / 可选

1. **官网首页只有中英双语**，没有西语版（工具本体是三语）。
2. **西语翻译是两跳**（es→en→zh），因为 HF 上不存在现成的「西→中」ONNX 模型。
   若哪天想要直译，得自己把 `Helsinki-NLP/opus-tatoeba-es-zh` 转 ONNX（需要装 torch，约 2.5 GB）。
3. `electron/` + 根 `package.json` 是**另一套打包路线**（electron-builder），
   已被 `desktop/` 取代；`node_modules` 已删，要用需先 `pnpm install`。
4. `desktop/.electron-cache/` 有 124 MB 的 Electron zip，留着重建快，删了要重下。
5. 网站用 Netlify 免费额度 100 GB/月。按每访客约 200 MB（英语）/ 290 MB（西语）算，
   约 350–500 次首次访问/月。
