/**
 * lib/patch/counts.js — 「几条没打上」的唯一出口：两种口径一起给，消费者不再自己数。
 *
 * 为什么需要它：同一份状态快照原先能同时说出四个数 —— 摘要 55/62、明细 66 行、
 * 诊断 counts 55/2/5/62、启动 pending 3 条。四个数各自都对，因为它们用的是两个分母：
 *
 *   · **raw**（原始条）—— 一个补丁号一条。66 条。这是判据的基准，也是启动对齐用的那一个。
 *   · **display**（展示行）—— 设置页把同一条清洗的升级链并成一行，`na` 与当前面不适用的
 *     补丁整条不出现。三组各并一次（[1,2,3]、[11,12]、[83,84]），66 − 4 = 62 行。
 *
 * 两个数都真实存在，错的是「同屏出现却不说是哪一个」。所以本模块**同时**返回两种口径，
 * 由消费者各自标注；一个消费者只许说一种，且必须说出名字。
 *
 * 边界：纯函数。只 import 权威表（lib/patch/status.js），不读盘、不 import core。
 */

import { countsAsFailure, displayBucketOf, isReady } from "./status.js";

/**
 * @typedef {{applied:number, pending:number, skipped:number, failed:number, other:number,
 *   ready:number, na:number, total:number, pendingIds:string[]}} RawCounts
 * @typedef {{applied:number, pending:number, unmatched:number, skipped:number, failed:number,
 *   ready:number, total:number}} DisplayCounts
 * @typedef {{id?:number|string, strictFiles?:boolean}} CountablePatch
 * @typedef {{status?:string, st?:string}} DisplayRow
 */

/** 空计数：宿主未定位 / 没有任何补丁时用它，别把「没判」写成 0/N。 */
function emptyRaw() {
  return {
    applied: 0, pending: 0, skipped: 0, failed: 0, other: 0, ready: 0, na: 0, total: 0, pendingIds: [],
  };
}

/**
 * 原始条口径：一个补丁号一条。
 *
 * `total` 只数「当前宿主上适用」的条数（`na` 不进分母）—— 与 `gatherState` 的
 * `patches_total` 同一条口径：宿主未定位时不是「0 条不可用」，而是「全部不可用」。
 * `ready` 与 `skipped` 不是同一个问题：`na` 是软放过但不该算就绪（见 status.js 的说明）。
 *
 * @param {Record<string|number,string>} status 补丁号 → 状态字面量
 * @param {CountablePatch[]} patches 补丁表
 * @param {((patch:object|null)=>"fail"|"warn"|"ignore")|null} [resolveOnMiss]
 * @returns {RawCounts}
 */
export function rawCounts(status, patches = [], resolveOnMiss = null) {
  const out = emptyRaw();
  const map = status && typeof status === "object" ? status : {};
  for (const patch of Array.isArray(patches) ? patches : []) {
    const id = patch && patch.id;
    if (id === undefined || id === null) continue;
    const value = map[id];
    if (typeof value !== "string" || value === "" || value === "na") {
      out.na += 1;
      continue;
    }
    out.total += 1;
    if (value === "pending") out.pendingIds.push(String(id));
    if (value === "applied") out.applied += 1;
    else if (value === "pending") out.pending += 1;
    else if (value === "skipped" || value === "missing_file" || value === "off") out.skipped += 1;
    else if (countsAsFailure(value)) out.failed += 1;
    else out.other += 1;
    if (isReady(value, patch, resolveOnMiss)) out.ready += 1;
  }
  return out;
}

/**
 * 展示行口径：设置页/端点那一屏的行数。
 *
 * 行已经由 `groupPatchesForDisplay` 合成过，这里只按权威表的归桶列数，不再按状态字符串
 * 现列一遍（那是「跳过」在整页有两个口径的来路）。行里认不出的状态仍计入 `skipped`，
 * 与 `lib/core.js` 原来的 `tallyDisplayPatches` 逐项一致。
 *
 * @param {DisplayRow[]} rows
 * @returns {DisplayCounts}
 */
export function displayCounts(rows) {
  const out = { applied: 0, pending: 0, unmatched: 0, skipped: 0, failed: 0, ready: 0, total: 0 };
  for (const row of Array.isArray(rows) ? rows : []) {
    const status = row?.status ?? row?.st;
    out.total += 1;
    const bucket = displayBucketOf(status);
    if (bucket === "applied") {
      out.applied += 1;
      out.ready += 1;
    } else if (bucket === "pending") {
      out.pending += 1;
    } else if (bucket === "unmatched") {
      out.unmatched += 1;
    } else if (bucket === "fail") {
      out.failed += 1;
    } else {
      out.skipped += 1;
      out.ready += 1;
    }
  }
  return out;
}

/**
 * 两种口径的同一次聚合。消费者的唯一入口。
 *
 * @param {{status?:Record<string|number,string>, patches?:CountablePatch[],
 *   displayRows?:DisplayRow[], resolveOnMiss?:null|((patch:object|null)=>"fail"|"warn"|"ignore")}} [input]
 * @returns {{raw:RawCounts, display:DisplayCounts}}
 */
export function summarizeCounts(input = {}) {
  const raw = rawCounts(input.status || {}, input.patches || [], input.resolveOnMiss || null);
  const display = displayCounts(input.displayRows || []);
  return { raw, display };
}

/**
 * 一行给人看的摘要：两个分母同时出现，谁也不冒充谁。
 *
 * 只在「两个分母不等」时才括注展示行 —— 相等时括注是噪声。这一句是 CLI 的
 * 摘要行与 `--diagnose` 的 `counts.summary` 共用的同一份文案，不是两处各拼一次。
 *
 * @param {{raw?:RawCounts, display?:DisplayCounts}} counts
 * @returns {string}
 */
export function countsLine(counts) {
  const raw = counts?.raw || emptyRaw();
  const display = counts?.display || displayCounts([]);
  // 一条都判不了时不许说「0/0 已清洗」：那个分母根本不在，读数会被当成「没什么待办」——
  // 而这一档恰恰是事后审计最常遇到的起点（宿主刚被官方更新、asar 还密封）。
  // 两种成因（宿主未定位 / 全部不适用）在这一档同形，就照「没有可判的补丁」说。
  if (raw.total === 0) {
    const why = raw.na > 0 ? `0 条可判，${raw.na} 条不适用或宿主未定位` : "补丁表为空或尚未评估";
    return `补丁 未评估（${why}）`;
  }
  const head = `补丁 ${raw.applied}/${raw.total} 已清洗`;
  const rows = display.total > 0 && display.total !== raw.total
    ? `（${display.total} 个展示行，其中 ${display.applied} 已清洗）`
    : "";
  const pending = raw.pending > 0
    ? `, ${raw.pending} 待清洗`
    : "";
  // 两个口径的 pending 不一致时必须说出来：这正是「UI 说 2 条、启动说 3 条」那一档。
  const differ = display.pending !== raw.pending ? `（展示口径 ${display.pending} 条）` : "";
  return `${head}${rows}${pending}${differ}`;
}
