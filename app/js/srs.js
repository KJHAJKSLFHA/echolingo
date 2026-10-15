// 间隔重复调度（SRS）
//
// ── 为什么不是 Anki 那套 ──
// Anki 的问法是「这个词你还记得吗」，靠**自评**。但这个工具的全部设计（遮罩糊
// 掉烧录字幕、收起中文、Alt 偷看）都是在逼你**听**。复习要是做成「看单词选意思」，
// 前面所有努力就白费了。所以这里的自评问的是「刚才这句你听懂了吗」——
// 由听力决定排期，不是由「看着眼熟」决定。
//
// ── 间隔序列 ──
// 20 分钟是「同一次学习内的短巩固」：刚收藏的东西当天再碰一次就够了。
// 之后 1 / 3 / 7 / 16 / 35 天，是遗忘曲线最陡的那几段。
// 35 天往上不再列固定档，改成每次 ×2.2、封顶 180 天 —— 到那一步基本已经是
// 长期记忆，再密就是浪费用户的时间。
//
// ── 答错为什么直接打回 1 天 ──
// 「退一档」听起来温和，但会让一个 35 天档的词在答错后退到 16 天 —— 明明已经
// 忘干净了，却还要等半个月才再考一次。硬重置回到 1 天是用户的明确选择。

/** 间隔阶梯（毫秒）。单位：分钟/天。 */
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const STEPS = [
  20 * MIN,      // 第 1 档：同一次学习内的短巩固
  1 * DAY,       // 第 2 档
  3 * DAY,       // 第 3 档
  7 * DAY,       // 第 4 档
  16 * DAY,      // 第 5 档
  35 * DAY,      // 第 6 档
];

/** 超出阶梯后每次乘这个倍数。 */
export const GROWTH = 2.2;
/** 间隔上限：半年。 */
export const MAX_INTERVAL = 180 * DAY;
/** 答错后回到第几档（0 = 20 分钟，1 = 1 天）。用户选了「直接打回 1 天」。 */
export const LAPSE_BOX = 1;

/**
 * 第 box 档对应的间隔（毫秒）。
 * box 从 0 开始：0→20分钟，1→1天 … 5→35天，6+→按 GROWTH 递推。
 */
export function intervalFor(box) {
  const b = Math.max(0, Math.floor(box || 0));
  if (b < STEPS.length) return STEPS[b];
  let iv = STEPS[STEPS.length - 1];
  for (let i = STEPS.length; i <= b; i++) iv *= GROWTH;
  return Math.min(iv, MAX_INTERVAL);
}

/** 把一条收藏记录规整成带 SRS 字段的形状（老记录没有这些字段）。 */
export function ensureSrs(rec, now = Date.now()) {
  const r = { ...rec };
  if (typeof r.box !== 'number' || r.box < 0) r.box = 0;
  if (typeof r.reps !== 'number' || r.reps < 0) r.reps = 0;
  if (typeof r.lapses !== 'number' || r.lapses < 0) r.lapses = 0;
  // 没有 dueAt 的老收藏：当成「刚收藏、马上该复习」，而不是「很久以后」。
  // 否则升级之后用户会看到一个空的复习队列，以为功能坏了。
  if (typeof r.dueAt !== 'number') r.dueAt = now;
  return r;
}

/**
 * 自评之后排下一次。
 * @param {object} rec   收藏记录
 * @param {boolean} ok   true = 听懂了，false = 没听懂
 * @param {number} now
 * @returns {object} 更新后的记录
 */
export function grade(rec, ok, now = Date.now()) {
  const r = ensureSrs(rec, now);
  if (ok) {
    r.box = r.box + 1;
    r.reps = r.reps + 1;
  } else {
    // 打回 1 天档。lapses 只用来统计「错了几次」，不参与排期。
    r.box = LAPSE_BOX;
    r.lapses = r.lapses + 1;
    r.reps = 0;
  }
  r.dueAt = now + intervalFor(r.box);
  r.lastAt = now;
  return r;
}

/** 这条现在该不该复习。 */
export function isDue(rec, now = Date.now()) {
  const r = ensureSrs(rec, now);
  return r.dueAt <= now;
}

/** 从一堆记录里挑出到期的。 */
export function dueList(recs, now = Date.now()) {
  return recs.filter((r) => isDue(r, now));
}

/** 把到期时间说成人话：「马上」「今天晚些」「3 天后」。 */
export function humanDue(dueAt, now = Date.now()) {
  const d = dueAt - now;
  if (d <= 0) return 'now';
  if (d < 6 * HOUR) return 'today';
  if (d < 1 * DAY) return 'today';
  return 'days:' + Math.max(1, Math.round(d / DAY));
}

/** 复习进度：到期的排前面（早到期的先考），其余按到期时间。 */
export function buildQueue(recs, now = Date.now()) {
  return recs
    .map((r) => ensureSrs(r, now))
    .filter((r) => r.dueAt <= now)
    .sort((a, b) => a.dueAt - b.dueAt);
}

/** 下一轮复习的进度条文案用得到：还有几条没过期。 */
export function nextDueAt(recs, now = Date.now()) {
  let best = Infinity;
  for (const r of recs) {
    const rr = ensureSrs(r, now);
    if (rr.dueAt > now && rr.dueAt < best) best = rr.dueAt;
  }
  return isFinite(best) ? best : null;
}
