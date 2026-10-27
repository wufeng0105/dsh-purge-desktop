/**
 * lib/audit/generation.js — 只读日志认出世代：判据锚在写入方的不变量上，不锚在「当前形态」上。
 *
 * 为什么单独一个模块：同一份日志里并存着四代写入方。判收尾、判反向对账之前都得先问一句
 * 「这一代到底有没有结束标记」—— 拿新判据去判旧行，会把完整的一轮全判成中断，而真相是
 * 判据没有依据。把「怎么认代」收成纯函数之后，`runs.js` 只消费结论，不再各写一份。
 *
 * 认代只看写入方**一定怎么写**，不看日期、版本号、文件大小：
 *   · 审计轨 v3：盖章那条层结论上写 `detail.runEnd: true`，同一条上另写 `detail.table`。
 *   · 审计轨 v2-entry：层结论带可复算的分母（`detail.considered` / `detail.expectedRows`），
 *     但还没有结束标记。这一代客观可能完整，按判据却判不了收尾。
 *   · 更早：连分母都没有，`completeness` 也无法复算。
 *   · 诊断轨 v3：结束事件上带 `runEnd`（`apply.end` / `apply.gate.reject` 是 `"engine"`，
 *     `audit.recorded` 是 `"audit"`）。没有它就是 v2-entry 及更早。
 *
 * 只读纯函数：入参是行数组，出参是一个字符串；没有副作用，也不缓存。
 */

/** 审计轨的三档世代：盖了章的、只有分母的、两样都没有的。 */
export const GENERATION_V3 = "v3";
export const GENERATION_V2_ENTRY = "v2-entry";
export const GENERATION_EARLY = "v1";

/**
 * 诊断轨的结束事件：一次 apply 有两个收尾阶段（引擎收尾、落账收尾），
 * 两条各盖各的章 —— 任一盖章就说明这一轮出自 v3 写入方。
 */
export const DIAG_END_EVENTS = Object.freeze(["apply.end", "apply.gate.reject"]);

/**
 * 结束标记的读法：只认「有没有」，不认值域。
 *
 * 写侧给了两个值（`"engine"` / `"audit"`），读侧不按值分支 —— 值只回答「哪个阶段盖的」，
 * 而轮边界问的是「盖没盖」。将来再加一个阶段名，这里不必跟着改。
 *
 * @param {object} row 诊断轨的一行
 * @returns {boolean} 这一行带不带结束标记
 */
export function hasRunEnd(row) {
  const value = row && row.runEnd;
  return typeof value === "string" && value !== "";
}

function detailOf(row) {
  return row && row.detail && typeof row.detail === "object" ? row.detail : null;
}

/**
 * 审计轨一轮的世代。入参是同一个 `runId` 的全部行，顺序无关。
 *
 * @param {Array<object>} events 审计行
 * @returns {"v3"|"v2-entry"|"v1"} 世代
 */
export function auditGeneration(events) {
  let modern = false;
  for (const row of Array.isArray(events) ? events : []) {
    const detail = detailOf(row);
    if (detail === null) continue;
    // 章与账是同一条结论上的一次写入：见到任何一个，这一轮就出自 v3 写入方。
    if (detail.runEnd === true) return GENERATION_V3;
    if (detail.table !== undefined) return GENERATION_V3;
    if (Array.isArray(detail.considered) || Number.isInteger(detail.expectedRows)) modern = true;
  }
  return modern ? GENERATION_V2_ENTRY : GENERATION_EARLY;
}

/**
 * 诊断轨一轮的世代。入参是同一个 `runId` 的全部行，顺序无关。
 *
 * 只分两档：有结束标记的是 v3，没有的是 v2-entry 及更早 —— 反向对账只需要「当时该不该
 * 写审计」这一个答案，而它在更早的几代里都不可判，细分下去也不会变得可判。
 *
 * @param {Array<object>} events 诊断行
 * @returns {"v3"|"v2-entry"} 世代
 */
export function diagGeneration(events) {
  for (const row of Array.isArray(events) ? events : []) {
    if (!row) continue;
    const ends = DIAG_END_EVENTS.includes(row.event) || row.event === "audit.recorded";
    if (ends && hasRunEnd(row)) return GENERATION_V3;
  }
  return GENERATION_V2_ENTRY;
}
