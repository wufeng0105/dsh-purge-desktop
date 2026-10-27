/**
 * lib/audit/layers.js — 中文层名折成三档事件名的唯一映射，兼容补丁单列。
 * 审计日志的「三层」口径：把补丁表的中文分类折成 prompt / code / tool 三档。
 *
 * 为什么需要这一层：结论层事件要求事件名首段与 layer 字段一致，而补丁表里的
 * layer 是中文字面量（提示词 / 代码 / 工具）。两者直接拼会得到 `提示词.probe`
 * 这种不合规的事件名，日志就没法按层检索。
 *
 * 兼容类补丁（0.1.5 兼容 / 0.2.0 兼容）不属于三档里的任何一档。它们单独计数，
 * 既不塞进某一层充数，也不静默丢掉 —— 丢掉会让「82 条只报了 79 条」变成一个
 * 看不见的缺口，而缺口正是审计日志最不能有的东西。
 */
// 判定折算的唯一实现搬到了状态表旁边；这里 import + 转发，本文件不再有第二份。
// import 不能省：`export { x } from` 只转发、不建本地绑定，summarizeLayers 要调它。
import { isSoftOk, onMissKind, resultOfStatus } from "../patch/status.js";

/** 补丁表的中文 layer → 结论层事件的三档名。 */
export const LAYER_BY_NAME = Object.freeze({
  提示词: "prompt",
  代码: "code",
  工具: "tool",
});

/**
 * 显式声明「不参与三档结论」的层名：兼容层。
 *
 * 为什么必须是**点名声明**而不是「凡数字开头都不算」：门禁曾经按后者写，于是
 * 「已知的兼容层」与「新加了一个没人映射的层」被混成同一档 —— 而后者正是审计层缺口
 * 最该被拦下的形态，却因为层名碰巧以数字开头而静默通过。声明在这里之后，
 * 没登记过的层名一律判红（`. 兼容` 之外的数字开头一样红）。
 *
 * 权威在这里；`scripts/check-audit-completeness.mjs` 因为不许 import `lib/` 而抄了一份，
 * `test/audit-completeness.test.mjs` 逐名比对两份，漂了会红。
 */
export const NON_CONCLUSION_LAYERS = Object.freeze(["0.1.5 兼容", "0.2.0 兼容"]);

/** 三档的固定输出顺序：日志里先提示词、再代码、最后工具，读的时候不需要排序。 */
export const LAYER_ORDER = Object.freeze(["prompt", "code", "tool"]);

/**
 * 取一条补丁的结论层归属。
 *
 * 返回空串表示「这条补丁不参与三层结论」（兼容类补丁、或表里 layer 写错），
 * 由调用方计入 unmapped，而不是猜一个层塞进去。
 */
export function layerOf(patch) {
  const name = patch && patch.layer;
  return LAYER_BY_NAME[name] || "";
}

/**
 * 单条补丁的判定折算成结论层的四态（ok / fail / skip）。
 *
 * 判定本体在 lib/patch/status.js —— 这里是转发，不是第二份实现。审计轨看不到
 * 补丁对象，所以只用那张表的 `countsAsFailure` 一列：`applied` 是 ok，失败一组
 * 是 fail，其余一律 skip。
 *
 * 为什么读写失败必须归 fail：引擎真的会产出 `read_error` 与
 * `write_error:<底层错误文本>` 两档（目标文件读不动 / 写不动），它们的含义是
 * 「这条补丁到底改成没改成，没判出来」。折成 skip 不是少报一条，是把「不知道」
 * 说成「没事」—— 层结论会因此落到 partial 甚至 skip，而 `failed=0` 会被读成
 * 「没有读写失败」的证据。
 *
 * 为什么 `missing_file` 与 `off` 不算失败：前者是「候选路径全部不存在」，那一批
 * 补丁在当前宿主本来就不适用；后者是「设置里关掉的」。把这两档记成失败，会让
 * 每一次干净的 apply 都像出了事故，而真正要追的读写失败被淹在里面。
 *
 * `pattern_not_found` 的软硬由补丁声明决定（`onMiss` 与 `strictFiles`），判定函数
 * 与诊断轨、设置页共用 `isSoftOk`：一处声明、三处同一结论。
 */
export { resultOfStatus };

/**
 * 按层汇总一组补丁的判定，得到三层各自的结论。
 *
 * @param {Array<{id:number, layer?:string}>} patches 补丁表
 * @param {Record<string|number,string>} patchStatus 补丁 id → 判定
 * @returns {{prompt:object, code:object, tool:object, unmapped:number}}
 */
export function summarizeLayers(patches, patchStatus) {
  const buckets = {
    prompt: { total: 0, applied: 0, failed: 0, skipped: 0, result: "skip" },
    code: { total: 0, applied: 0, failed: 0, skipped: 0, result: "skip" },
    tool: { total: 0, applied: 0, failed: 0, skipped: 0, result: "skip" },
    unmapped: 0,
  };
  const status = patchStatus && typeof patchStatus === "object" ? patchStatus : {};
  for (const patch of Array.isArray(patches) ? patches : []) {
    const layer = layerOf(patch);
    if (!layer) {
      buckets.unmapped += 1;
      continue;
    }
    const verdict = status[patch.id];
    // 没判定（宿主还没定位到 / 补丁在当前面不适用）不计入分母：
    // 否则「找不到宿主」会被读成「三层全断」。
    if (verdict === undefined || verdict === "na") continue;
    const bucket = buckets[layer];
    bucket.total += 1;
    // 补丁对象在这里，`pattern_not_found` 的软硬就按它自己的声明判 —— 与诊断轨
    // 的 isPatchResultSoftOk、设置页的分组用同一个函数，三处不会再各判一次。
    const softOk = isSoftOk({ status: verdict }, patch, onMissKind);
    const folded = resultOfStatus(verdict, { softOk });
    if (folded === "ok") bucket.applied += 1;
    else if (folded === "fail") bucket.failed += 1;
    else bucket.skipped += 1;
  }
  for (const layer of LAYER_ORDER) {
    const bucket = buckets[layer];
    if (bucket.total === 0) bucket.result = "skip";
    else if (bucket.failed > 0) bucket.result = "fail";
    else if (bucket.applied === bucket.total) bucket.result = "ok";
    else if (bucket.applied > 0) bucket.result = "partial";
    else bucket.result = "skip";
  }
  return buckets;
}

/**
 * 三层里最差的一档，用于「一次 apply 的整体结论」这类需要单值的场合。
 * 顺序是 fail > partial > skip > ok：一处断掉就是断掉，不能被其余层的绿盖住。
 */
export function worstLayerResult(layers) {
  const results = (LAYER_ORDER || []).map((layer) => (layers && layers[layer] && layers[layer].result) || "skip");
  if (results.includes("fail")) return "fail";
  if (results.includes("partial")) return "partial";
  if (results.every((r) => r === "skip")) return "skip";
  if (results.every((r) => r === "ok" || r === "skip")) return "ok";
  return "partial";
}

/**
 * 层结论与完备性三布尔的合成：任何一项为假，结论不许是 ok / skip。
 * 「记全了没有」是结论本身的一部分 —— 绿结论不得盖住记录缺口，
 * 所以 patches / files / layers 任一为假就把 ok / skip 压成 partial；
 * fail 比 partial 更严重，保持 fail 不动。completeness 缺席（旧调用方）时原样放行。
 */
export function foldCompleteness(aggregate, completeness) {
  if (!completeness || typeof completeness !== "object") return aggregate;
  const complete = completeness.patches !== false
    && completeness.files !== false
    && completeness.layers !== false;
  if (complete) return aggregate;
  return aggregate === "fail" ? "fail" : "partial";
}
