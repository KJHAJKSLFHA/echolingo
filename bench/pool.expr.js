const R = {};
await window.decodeReal('/bench/real.wav');
const plan = window.planSegs(120);
R.plan = plan.map((s) => s.sec);

// 目标：总线程数 ≈ 10 物理核，同时用多 worker 分摊「每段 ~950ms 固定开销」
const configs = [[2, 4], [4, 2], [5, 2], [3, 3]];
for (const [n, t] of configs) {
  R[`w${n}_t${t}`] = await window.poolBench({ n, modelId: 'whisper-base.en', threads: t, plan });
}
return JSON.stringify(R, null, 1);
