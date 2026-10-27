/**
 * lib/layer-rows.js — 设置页分节的行数据放服务端，才能用测试守住空层不渲染。
 * 按层生成设置页补丁分节的行数据。
 *
 * 为什么放在服务端而不是片段里：`lib/client-src/**` 是被文本装配的片段，
 * `node --test` 导入不了它们，于是「空层不渲染」这类判据没法用测试守住。
 * 挪成真 ES 模块以后，分组与过滤是纯函数，四条断言直接调它 —— 不需要 DOM。
 *
 * 顺序固定：提示词 / 代码 / 工具 / 兼容。空层在这里就被过滤掉，
 * 客户端只负责画，不做分组、不做过滤（两处各判一次，早晚判不一样）。
 *
 * ## 计数按归桶而不是按色调
 *
 * 早先这一层的 `skipped` 数的是 `tone === idle` 的条目，而权威表里 `pending` 的色调
 * 也是 `idle` —— 于是「待应用」被算进了「按设计跳过」，摘要里的跳过与分节里的跳过
 * 是两个数。现在按 `displayBucketOf(status)` 归桶：`skip` 才算跳过，`pending` 另立
 * 一列。色调仍然只决定圆点颜色，不参与计数 —— 这一条让「跳过」在整页只有一个口径，
 * 与 `lib/core.js` 的 `tallyDisplayPatches` 用的是同一张权威表的同一列。
 */

// 色调与归桶的唯一权威都在 lib/patch/status.js：读写失败显示成「没事」那类偏差，
// 根因就是每个界面各自维护一份 status → 色调 / 归桶的映射。这里只消费它。
import { displayBucketOf, toneOf } from "./patch/status.js";

/** 层的中文名与顺序；`兼容` 收纳 0.1.5 / 0.2.0 两个兼容层。 */
const LAYER_ORDER = [
  ["提示词", "prompt", "提示词"],
  ["代码", "code", "代码"],
  ["工具", "tool", "工具"],
  ["兼容", "compat", "兼容"],
];

const TONE_OK = "ok";
const TONE_IDLE = "idle";
const TONE_BAD = "error";

/** 把补丁的 layer 值折成四个桶之一。 */
function bucketOf(layer) {
  const raw = String(layer || "");
  if (raw.startsWith("0.1.5") || raw.startsWith("0.2.0")) return "兼容";
  if (raw === "提示词") return "提示词";
  if (raw === "代码") return "代码";
  if (raw === "工具") return "工具";
  return "";
}

/**
 * @param {{patches?: Array<object>}} status /dsh-purge/status 的响应
 * @returns {Array<{layer:string,title:string,hit:number,total:number,skipped:number,
 *   pending:number,tone:string,items:Array<object>}>}
 */
export function buildLayerRows(status) {
  const patches = Array.isArray(status && status.patches) ? status.patches : [];
  const buckets = new Map(LAYER_ORDER.map(([key, slug, title]) => [key, { slug, title, items: [] }]));
  // 落不到四个桶里的条目直接跳过（层只有那几种）；对不上的量由
  // `test/settings-counts-parity.test.mjs` 用「条目总数 − 各行 total 之和」兜住，
  // 不在这里另存一份计数。
  for (const p of patches) {
    const bucket = bucketOf(p && p.layer);
    if (!bucket) continue;
    const status = p && p.status;
    buckets.get(bucket).items.push({
      id: p.id,
      name: p.title || p.name || String(p.id),
      desc: p.desc || "",
      tone: toneOf(status),
      bucket: displayBucketOf(status),
      ...(p.reason ? { reason: p.reason } : {}),
      ...(p.error ? { error: p.error } : {}),
    });
  }
  const rows = [];
  for (const [key, slug, title] of LAYER_ORDER) {
    const bucket = buckets.get(key);
    if (bucket.items.length === 0) continue; // 空层整块不出现
    const total = bucket.items.length;
    const hit = bucket.items.filter((i) => i.tone === TONE_OK).length;
    const skipped = bucket.items.filter((i) => i.bucket === "skip").length;
    const pending = bucket.items.filter((i) => i.bucket === "pending").length;
    const tone = bucket.items.some((i) => i.tone === TONE_BAD) ? TONE_BAD : hit === total ? TONE_OK : TONE_IDLE;
    rows.push({ layer: key, slug, title, hit, total, skipped, pending, tone, items: bucket.items });
  }
  return rows;
}
