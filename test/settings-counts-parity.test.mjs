/**
 * test/settings-counts-parity.test.mjs — 摘要的「跳过」与分节的「跳过」必须是同一个数。
 *
 * 为什么单独立一份：两处数的是同一件事，口径却不一样 —— 摘要走权威表的归桶
 * （`displayBucketOf(status) === "skip"`），分节走色调（`tone === "idle"`），
 * 而 `pending` 的色调**也是** idle。于是「2 条待应用」的机器上，分节把这两条算进
 * 「按设计跳过」，摘要不算 —— 同一屏两个跳过，用户无从判断该信哪个。
 *
 * 本文件把两件事钉住：
 *   一、**口径**：分节的 skipped 只数归桶为 skip 的条目，pending 另立一列；
 *   二、**一致性**：同一份现场下，「各行 skipped 之和」== 「摘要 skipped」。
 * 判据走真函数（`core.groupPatchesForDisplay` / `core.tallyDisplayPatches` /
 * `lib/layer-rows.js` 的 `buildLayerRows`），不另写一份映射。
 */
import { test } from "node:test";
import assert from "node:assert";

import * as core from "../lib/core.js";
import { buildLayerRows } from "../lib/layer-rows.js";

/**
 * 一份「什么都有」的现场：两层里各有一条 pending（它们才是判据的靶子），另有 applied /
 * already / skipped / missing_file 与一条 `na`（`na` 不进分节，也不进摘要的分母）。
 *
 * 补丁 id 用 901 起：避开真实表里的分组键，免得几条夹具被合成一个显示行。
 */
const PATCHES = [
  { id: 901, layer: "提示词", title: "P901" },
  { id: 902, layer: "代码", title: "P902" },
  { id: 903, layer: "代码", title: "P903" },
  { id: 904, layer: "工具", title: "P904" },
  { id: 905, layer: "工具", title: "P905" },
  { id: 906, layer: "0.2.0 兼容", title: "P906" },
  { id: 907, layer: "提示词", title: "P907" },
  { id: 908, layer: "代码", title: "P908" },
];

const STATUSES = {
  901: "applied",
  902: "applied",
  903: "already",
  904: "skipped",
  905: "pending",
  906: "missing_file",
  907: "pending",
  908: "na",
};

/** 端点会给的那一份 `patches`：服务端分组算好的显示行。 */
function displayRows() {
  return core.groupPatchesForDisplay(PATCHES, STATUSES, "desktop");
}

/** 摘要那一侧的数：与端点同一条实现（`tallyDisplayPatches`）。 */
function summaryOf(rows) {
  return core.tallyDisplayPatches(rows);
}

/**
 * 旧口径：按色调数跳过。
 *
 * 只在本文件里当红灯夹具用 —— 它证明「这个现场确实能分出两种口径」，否则
 * 「parity 通过」可能只是夹具里没有 pending 这种东西。
 */
function legacyRows(rows) {
  return buildLayerRows({ patches: rows }).map((row) => ({
    ...row,
    skipped: row.items.filter((item) => item.tone === "idle").length,
  }));
}

const sumOf = (rows, key) => rows.reduce((total, row) => total + Number(row[key] || 0), 0);

test("红灯夹具：按色调数跳过会与摘要对不上（同一现场，两个跳过）", () => {
  const rows = displayRows();
  const summary = summaryOf(rows);
  const legacySkipped = sumOf(legacyRows(rows), "skipped");
  assert.ok(summary.skipped > 0, "夹具里没有可跳过的补丁：这条红灯照不亮");
  assert.notEqual(
    legacySkipped,
    summary.skipped,
    "夹具里没有 pending，两种口径必然相等 —— 这条红灯夹具失去意义",
  );
});

test("口径一致：各行 skipped 之和 == 摘要 skipped，pending 另立一列", () => {
  const rows = displayRows();
  const summary = summaryOf(rows);
  const layerRows = buildLayerRows({ patches: rows });

  assert.deepEqual(
    layerRows.map((row) => row.layer),
    ["提示词", "代码", "工具", "兼容"],
    "四个桶的层名或顺序变了：分节的层与摘要的归桶会重新漂",
  );
  assert.equal(sumOf(layerRows, "skipped"), summary.skipped, "分节 skipped 之和与摘要 skipped 不一致");
  assert.equal(sumOf(layerRows, "pending"), summary.pending, "分节没有单列 pending：待应用又被算进了跳过");
  assert.equal(sumOf(layerRows, "total"), rows.length, "分节漏掉了显示行（摘要与分节的分母不同）");
  // 待应用的两条必须落在它们各自的层上，而不是被抹平成一个总数。
  assert.equal(layerRows.find((row) => row.layer === "工具").pending, 1, "工具层的待应用没被单列");
  assert.equal(layerRows.find((row) => row.layer === "提示词").pending, 1, "提示词层的待应用没被单列");
  // 跳过的两条（skipped / missing_file）仍算跳过 —— 别为了拆词把它们也赶走。
  assert.equal(sumOf(layerRows, "skipped"), 2, "按设计跳过的条数变了");
});

test("色调不参与计数：pending 的圆点仍是 idle，但它不算跳过", () => {
  const layerRows = buildLayerRows({ patches: displayRows() });
  const tool = layerRows.find((row) => row.layer === "工具");
  const pendingItem = tool.items.find((item) => item.id === 905);
  assert.equal(pendingItem.tone, "idle", "pending 的色调变了：那是状态点的语义，不该被计数口径带着改");
  assert.equal(pendingItem.bucket, "pending", "条目的归桶没透出来：计数与色调就会重新混在一起");
  assert.equal(tool.skipped, 1, "工具层只该有 1 条按设计跳过（904），pending 不算");
});
