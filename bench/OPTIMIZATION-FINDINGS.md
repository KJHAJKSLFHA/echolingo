# 识别速度：实测结论与待办

> 本文只记录**测量结果**与**一个必修 bug**，不包含对 `js/` 的改动 ——
> 因为同一工作区还有另一个会话在并行改这些文件，避免互相覆盖。
>
> 测量基线（本文所有数字）：`js/asr-engine.js` md5 `afdeeebdc5ce684175bfebbe0179921`、
> `js/app.js` md5 `a869ed6d9bf8284eb99a0b25a8a84e98`、`js/asr.js` md5 `20aa2294030b092d9b55b785db06fdfc`。
> 若文件已变，请重新测。

环境：Apple Silicon 10 核 / 32GB，HeadlessChrome 155，`whisper-base.en` q8，
`crossOriginIsolated = true`（COOP/COEP 生效，多线程真的开了）。

---

## 一、结论摘要（按优先级）

| 优先级 | 问题 | 实测依据 |
|---|---|---|
| 🔴 P0 | **`return_timestamps: true` 返回空文本 → 长视频识别结果为 0** | 见第四节，可稳定复现 |
| 🟠 P1 | 切段偏短 → 段数偏多，而**总时间≈段数** | 每段固定开销 ~0.7s，与段长几乎无关 |
| 🟠 P1 | 多线程扩展差，单会话封顶 4 线程 | 4→10 线程反而变慢；并行会话收益更大（另一会话已在做） |
| 🟡 P2 | 整条音轨路径 PCM **既 transfer 又拷贝**，内存翻倍 | `js/asr.js` 传 `transfer:[buf]`，`js/asr-worker.js` 又 `new Float32Array(msg.samples)` |
| 🟡 P2 | 首句延迟 5.8s | 端到端实测，其中模型冷启动 ~1.5s |

---

## 二、端到端基线（174 秒真实语音，改前代码）

驱动真实界面（构造 `File` → 派发 `change` → 轮询右侧 DOM）：

```
右侧出现第一句      5.77 s
识别全部结束       22.08 s      （40 句 / 10 段，约 8× 实时）
翻译 40 句完成     ~29.9 s
```

逐段耗时约 **1.73 s/段**，10 段 × 1.73s ≈ 17.3s，与 22.08s 的量级吻合
（差额是音频解码与冷启动装载）。

## 三、时间都花在哪（分解测量）

### 3.1 线程扩展（28s 语音片段，逐词时间戳，预热后取 3 次中位数）

每个配置单独开一次浏览器进程，先跑一次预热再计时：

| 线程数 | 20s 片段 | 28s 片段 |
|---|---|---|
| 1 | 4091 ms | 4645 ms |
| 2 | 2597 ms | 3054 ms |
| 4 | **1942 ms** | **2327 ms** |
| 6 | **1767 ms** | **2167 ms** |
| 8 | 1770 ms | 2215 ms |
| 10 | 1999 ms | 2429 ms |

结论：
- 1→4 线程约 **2.1×**；4→6 再快约 **9%**；**8 线程以上开始倒退**（超订）。
- 现在代码是 `Math.min(4, hardwareConcurrency)`，在 10 核机器上停在 4 线程，
  改成「约 0.6×核数、上限 6~8」还能再拿将近一成。
- 但单会话扩展效率只有五成上下，**靠加线程拿不到数量级收益**，
  真正的杠杆是多会话并行（另一会话的 `asr-pool.js` 方向正确）。

### 3.2 每段有一次固定开销 → 总时间正比于段数

预热后、6 线程：20s 段 1767ms、28s 段 2167ms；
两档词数约 62 与 86 → **约 16.7 ms/词**，反推固定开销 **≈ 0.7 s/段**。

原因在 vendor 里的特征提取器，永远是 30 秒窗口：

```js
e.length > s ? (console.warn(...), n = e.slice(0, s)) : (n = new Float32Array(s), n.set(e))
```

段长不足 30s 也按 30s 编码，**固定那一份钱照付**；短段还要多切几段、多付几次。

所以：
- 段长从平均 ~17s 提到接近 29s，段数约减三成，**总时间约省 20%+**。
- 另一会话的 `js/segment.js` 已经按这个思路在改（`minSec = 17, maxSec = 29, tailBias`），方向一致。

### 3.3 解码器逐词成本才是大头

固定 0.7s + 16.7ms/词 ⇒ 对连续语音，**逐词解码约占总时间七成**，
而它无法靠加线程解决（自回归、逐 token 串行）。
这也是为什么「并行分片」是对的：它绕开的是**编码器固定开销 + 会话级并行**，不是解码器本身。

---

## 四、🔴 P0：`return_timestamps: true` 返回空 → 长视频一个字幕都没有

### 4.1 代码位置

`js/asr-engine.js` 的 `transcribeSegment()`：

```js
168:      return_timestamps: wordTimestamps ? 'word' : true,
169:      force_full_sequences: false,
...
175:      out = await asr(samples, { return_timestamps: true, force_full_sequences: false, ...genOpts });
```

（`transcribe()` 也走 `transcribeSegment()`，所以只有这一处要改。）

`js/app.js:1567`：

```js
const useWordTs = S.settings.wordTs === 'on' ||
  (S.settings.wordTs === 'auto' && (($('#player').duration || 0) < 1500));
```

`wordTs` 默认 `auto` ⇒ **时长 ≥ 25 分钟的视频 `useWordTs = false`** ⇒ 走
`return_timestamps: true`。

### 4.2 实测：`true` 直接返回空

直接调 pipeline（6 线程，预热后，同一段真实语音）：

| `return_timestamps` | 中位耗时 | 返回 |
|---|---|---|
| `'word'` | **2231 ms** | 正常，含逐词时间戳 |
| `false` | **1979 ms** | 文本正常，但 `chunks: 0`（无时间戳） |
| `true` | **768–784 ms** | **`text: ''`、`chunks: []`** |

`true` 之所以「很快」，是因为它几乎什么都没生成就 EOS 了。

更精确地说：`true` 只在**从干净起点开始的段**上侥幸可用
（0–20s 那段返回了文本），一旦段是从连续语音中间切出来的
（30–58s、60–88s、90–118s 三段），就**全部返回空**。
而 App 的段几乎全是中间切出来的。

vendor 内部流程也印证了这点：`'word'` 会把参数改成
`return_token_timestamps = true, return_timestamps = false` 走交叉注意力 DTW，
而 `true` 需要模型自己吐出时间戳 token 才能闭合分段 —— 拿不到就只剩空串。

### 4.3 后果

- **≥ 25 分钟的视频：右侧永远出不来字幕**，只弹「识别结果为空」。
- 设置里把「逐词时间戳」手动改成「始终关闭」，同样失效。

### 4.4 建议补丁（最小改动）

`js/asr-engine.js` → `transcribeSegment()`：

```js
  let out;
  try {
    // 永远用 'word'：实测只比 false 贵约 13%，
    // 而 'true' 在本 vendor 版本上对「从中间切出的段」会返回空。
    out = await asr(samples, {
      return_timestamps: 'word',
      force_full_sequences: false,
      ...genOpts,
    });
  } catch (err) {
    // 逐词失败就退到「不要时间戳」（绝不是 true）
    out = await asr(samples, { return_timestamps: false, force_full_sequences: false, ...genOpts });
  }
  const chunks = out?.chunks?.length
    ? out.chunks
    : [{ text: out?.text || '', timestamp: [0, dur] }];
```

配套（`js/app.js:1567`）：既然逐词只贵 13%，`auto` 那条
「长视频关闭逐词」已经没有意义，可以直接去掉。

> 如果确实要为超长视频保留一个「快速模式」：走 `false`，
> 然后在主线程把 `out.text` 按句末标点切成句、用 `subtitle.js` 里已有的
> `distributeTiming()` 按长度分摊时间。**不要再用 `true`。**

### 4.5 复现方法

```bash
# 本仓库自带的可复现测试（独立文件，不动 js/）
python3 tools/serve.py 8899 &
node bench/cdp2.mjs http://127.0.0.1:8899/bench/tsmode.html /tmp/tsmode.expr.js
# /tmp/tsmode.expr.js 内容：
#   return await window.run({ threads: 6, slices: [[30,28],[60,28],[90,28],[0,20]] });
```

`bench/long.wav` 是 174 秒测试音频，可这样重建：

```bash
afconvert app/media/demo.m4a -f WAVE -d LEI16@16000 -c 1 /tmp/demo16k.wav
python3 -c "
import wave
s=wave.open('/tmp/demo16k.wav','rb'); raw=s.readframes(s.getnframes()); fr=s.getframerate()
w=wave.open('bench/long.wav','wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(fr)
w.writeframes((raw+b'\x00\x00'*int(0.35*fr))*10); w.close()"
```

---

## 五、其余建议

### 5.1 已被另一会话处理（无需重复）

- **并行会话池** —— `js/asr-pool.js`：把段分给多个 Worker 同时跑。
  我实测同方向成立（对方记录 4 会话×2 线程 RTF 0.058，优于 1 会话×4 线程 0.091）。
  注意池子大小要看内存：每个会话一份权重 + wasm 堆。
- **切段拉长** —— `js/segment.js`（`maxSec = 29`、`tailBias`），与我 3.2 的结论一致。

### 5.2 仍待处理

1. **线程数按机器选，别停在上限 4**（3.1）。建议
   `Math.min(8, Math.max(2, Math.round(hc * 0.6)))`，且**池子内每会话线程数不要太高** ——
   4 会话×2 线程优于 1 会话×8 线程，因为解码器是串行的，会话级并行收益更大。
2. **整条音轨兜底路径的 PCM 双重开销**：
   `js/asr.js:474` 用 `transfer: [buf]` 把主线程缓冲**转移**掉（立即失效），
   而 `js/asr-worker.js` 又执行 `new Float32Array(msg.samples)` **完整拷贝一份**。
   结果是两边的代价都付了：多一次 N×4 字节拷贝 + 峰值内存翻倍，
   而且兜底路径仍要重新解码（因为缓冲已经没了）。
   要么真 transfer（Worker 里直接用 `msg.samples`），要么不 transfer（Worker 里拷贝）。
   一小时视频这里是 230MB 级的差别。
3. **首句延迟**：端到端 5.77s 里约 1.5s 是模型冷启动。
   开机预热（`app.js` 的 `setTimeout(preloadModels, 1200)`）与用户「打开页面立刻拖视频」
   存在竞态：识别请求排在预热后面排队。
   可以让**第一段短一些**（例如 8s）先出字，后续段再用满 29s ——
   固定开销几乎不变，首句能早 1s 左右。

---

## 六、测量脚本

| 文件 | 用途 |
|---|---|
| `bench/tsmode.html` | 独立页面：对比三种时间戳模式（不依赖被并行修改的 `bench.html`） |
| `bench/cdp2.mjs` | 独立 CDP 驱动（端口 9444，避免与另一会话的 9333 冲突） |
| `bench/long.wav` | 174 秒测试音频（10× 17s 真实语音 + 0.35s 间隔） |

> 注：另有一个静态服务器跑在 `http://127.0.0.1:8899`（`python3 tools/serve.py 8899`），
> 如不需要可直接结束该进程。
