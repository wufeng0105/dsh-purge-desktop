/**
 * lib/patch/rollup.js — 逐文件结论与逐补丁汇总的唯一实现，状态侧与 apply 侧都只走这里。
 *
 * 为什么需要它：同一份逐文件事实在两边各算一遍，两边的优先级还相反 ——
 * 状态侧 pending 优先，apply 侧 applied 优先。于是「同一个补丁的一个文件已打上、
 * 另一个还有活」在设置页是 pending、在本轮汇总里是 applied。这不是显示问题：
 * 汇总那边会据此把「没洗完」写进日志，而界面那边说「还有活」，读日志的人无法
 * 判断该信哪一个。
 *
 * 边界：纯函数层。不读文件、不 import core、不认识 marker 字面量。判据的两半分固定：
 *   `contentFileOutcome` 决定单个文件是 applied / pending / skipped；
 *   `rollupPatchStatus` 决定这些逐文件结论合成哪一条补丁状态，且 pending 永远先于 applied。
 */

/** 逐文件的三种结论。字面量与状态侧的取值一致，映射时不需要第二张表。 */
export const FILE_OUTCOME = Object.freeze({
  applied: "applied",
  pending: "pending",
  skipped: "skipped",
});

function intOf(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

/**
 * 一个文件上一条补丁的结论。
 *
 * 五份证据，marker 只是其中一份 —— 这是本次改造的要点：marker 单独成立不再算数。
 *
 *   worked        该补丁的 pattern 仍能在本文件里命中（引擎再点一次也只会改这一处）
 *   settled       marker 命中：fast path 的原料，不是结论
 *   tableTrusted  版本账本里这条补丁的指纹与当前表一致
 *   contentProven 现场字节 == 官方原文 + 这一版表在该文件上的全部替换（逐文件重放）
 *   contentKnown / contentMatched
 *                 收尾时记下的文件字节指纹，与现场字节比。它是**否证 marker 的证据**：
 *                 marker 在而字节不是这一版表打出来的，就不认 marker。
 *
 * 判定次序（改次序等于改判据，改前先想清楚）：
 *   还有活             → pending（原文还在，marker 说已生效也不认）
 *   没有 marker         → skipped（这条补丁在这个文件上没有它的痕迹）
 *   内容自证成立        → applied（这份字节就是这一版表的产物，比下面两条都强）
 *   指纹不认           → pending（marker 来自另一代补丁表，或账本里有指纹但没有这一条）
 *   字节对不上          → pending（文件被动过，marker 是上一轮的）
 *   其余                → applied（指纹与字节都对得上，或账本没有逐条指纹可查时退回 marker）
 *
 * `contentProven` 插在 `tableTrusted` 之前，是因为它与后两条不是同一个量级的事实：
 * 账本的逐条指纹与内容指纹都只是**间接锚点**，且都会在补丁表换代后过期；自证直接回答
 * 「这份字节是不是这一版表产出的」。把它排在后面，等于让两份会过期的锚点否决一份当场的证明。
 *
 * @param {{worked?:boolean, settled?:boolean, tableTrusted?:boolean, contentProven?:boolean,
 *   contentKnown?:boolean, contentMatched?:boolean}} [evidence]
 * @returns {"applied"|"pending"|"skipped"}
 */
export function contentFileOutcome(evidence = {}) {
  if (evidence.worked === true) return FILE_OUTCOME.pending;
  if (evidence.settled !== true) return FILE_OUTCOME.skipped;
  if (evidence.contentProven === true) return FILE_OUTCOME.applied;
  if (evidence.tableTrusted !== true) return FILE_OUTCOME.pending;
  if (evidence.contentKnown === true && evidence.contentMatched === false) return FILE_OUTCOME.pending;
  return FILE_OUTCOME.applied;
}

/**
 * 逐文件结论的计数。认不出的取值按 skipped 计 —— 引擎只产这三种，
 * 出现第四种说明调用方传错了，按「不知道」算比按「已生效」算安全。
 *
 * @param {Array<string>} outcomes
 * @returns {{applied:number, pending:number, skipped:number}}
 */
export function countFileOutcomes(outcomes) {
  const counts = { applied: 0, pending: 0, skipped: 0 };
  for (const outcome of Array.isArray(outcomes) ? outcomes : []) {
    if (outcome === FILE_OUTCOME.applied) counts.applied += 1;
    else if (outcome === FILE_OUTCOME.pending) counts.pending += 1;
    else counts.skipped += 1;
  }
  return counts;
}

/**
 * 逐文件结论 + 失败类计数 → 一条补丁的状态。
 *
 * 这是状态侧与 apply 侧**唯一**的汇总实现。两处输入形状的差别只在两项：
 *   `written`  apply 侧真写过的文件数；状态侧没有写入，缺省 0
 *   `already`  apply 侧「本来就在目标态」的文件数；逐文件结论里已经并进 applied，
 *              所以正常路径不必传，只有需要区分「写没写」时才用
 *
 * 次序：失败类（读写错误、strictFiles 的 miss）先出，然后 pending，然后才 applied。
 * `pending` 先于 `applied` 就是这次要合的差集；反过来写会让「一个文件有活」被
 * 「另一个文件已打上」盖住。
 *
 * @param {{outcomes?:Array<string>, written?:number, already?:number, missing?:number,
 *   keyCount?:number, lastError?:string|null, onMiss?:string, strictFiles?:boolean}} [input]
 * @returns {string} 状态字面量：applied / already / pending / skipped /
 *   pattern_not_found / missing_file / 读写错误码
 */
export function rollupPatchStatus(input = {}) {
  const counts = countFileOutcomes(input.outcomes);
  const applied = counts.applied + intOf(input.already);
  const written = intOf(input.written);
  const missing = intOf(input.missing);
  const keyCount = intOf(input.keyCount);
  const lastError = typeof input.lastError === "string" ? input.lastError : "";
  const strictFiles = input.strictFiles === true;
  const onMiss = input.onMiss === "warn" || input.onMiss === "ignore" ? input.onMiss : "fail";
  if (strictFiles && lastError) return lastError;
  if (strictFiles && counts.skipped > 0) return "pattern_not_found";
  if (counts.pending > 0) return "pending";
  if (written > 0) return "applied";
  // 静默失效的判据：一个文件在目标态、另一个文件原文对不上时，软补丁（warn）
  // 仍按「这一版不需要」放过，硬补丁不许被前一个文件的好消息盖住。
  if (applied > 0 && (counts.skipped === 0 || onMiss === "warn")) return "already";
  if (keyCount > 0 && missing === keyCount) return "missing_file";
  if (lastError) return lastError;
  if (counts.skipped === 0) return "skipped";
  return "pattern_not_found";
}

/**
 * 多宿主还原判据的合成。
 *
 * 为什么需要它：`revertAllHosts` 返回的是逐宿主数组，而「已还原没有」这个问题
 * 需要一份跨宿主的结论 —— CLI 要打印、`/dsh-purge/revert` 要回包、诊断轨要落字段。
 * 三处各写一遍合并逻辑，必然有一处把「某台判红」读成「全部通过」。
 *
 * 判据只有一条：**任一宿主判红，整体就不算 ok**；「不可判」不冒充通过，
 * 所以只要有一个未扫描文件，`complete` 就是 false。没有宿主时 `ok=true` 但
 * `complete=false` —— 「没东西可判」不是「全部核对通过」。
 *
 * `mismatched` 保留 `[路径, 原因]` 二元组：只给计数的话，读的人还要回日志里找是哪个文件。
 *
 * @param {Array<{ok?:boolean, complete?:boolean, mismatched?:Array<[string,string]>,
 *   unscanned?:string[]}>} rows 逐宿主判据（`revertAllHosts().parity`）
 * @returns {{ok:boolean, complete:boolean, mismatched:Array<[string,string]>, unscanned:string[]}}
 */
export function summarizeRevertParity(rows) {
  const list = Array.isArray(rows) ? rows.filter((row) => row && typeof row === "object") : [];
  const mismatched = [];
  const unscanned = [];
  let ok = true;
  let complete = list.length > 0;
  for (const row of list) {
    if (row.ok !== true) ok = false;
    if (row.complete !== true) complete = false;
    for (const pair of Array.isArray(row.mismatched) ? row.mismatched : []) {
      if (Array.isArray(pair) && pair.length >= 2) mismatched.push([String(pair[0]), String(pair[1])]);
    }
    for (const fp of Array.isArray(row.unscanned) ? row.unscanned : []) unscanned.push(String(fp));
  }
  return {
    ok: ok && mismatched.length === 0,
    complete: complete && unscanned.length === 0,
    mismatched,
    unscanned,
  };
}
