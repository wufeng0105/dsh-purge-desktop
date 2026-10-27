/**
 * test/patch-status.test.mjs — 状态表的唯一权威，以及六个决策点从同一张表推出结论。
 *
 * 为什么存在：同一个 status 原先由六处各自解释 —— 合并优先级、诊断轨的软硬白名单、
 * 诊断轨的逐补丁判定、审计轨的层结论、设置页的分组、设置页的色调。于是 `missing_file`
 * 四家说「跳过」、审计轨说「失败」，`read_error` 在设置页显示成「没事」。这类偏差没有
 * 症状：日志照样写、测试照样绿，只有读日志的人被误导。
 *
 * 所以这里锁两样东西：每个 status 的五行判定（快照，改口径要点名改），以及「各决策点
 * 都从同一张表推结论」这条结构性质 —— 谁把某一处改回自己的小表，下面必有一条断言红。
 */
import { test } from "node:test";
import assert from "node:assert";

import {
  STATUS,
  countsAsFailure,
  displayBucketOf,
  isAlwaysSoft,
  isReady,
  isSoftOk,
  rankOf,
  resultOfStatus,
  toneOf,
} from "../lib/patch/status.js";
import {
  ALL_PATCHES,
  applyEndCounts,
  groupPatchesForDisplay,
  isPatchResultSoftOk,
  patchStatusReady,
  rollupDisplayStatus,
  summarizeApplyReport,
  tallyDisplayPatches,
} from "../lib/core.js";
import { buildLayerRows } from "../lib/layer-rows.js";

/** 表里应当出现的全部 status：日志与报告里真会出现的那些字面量。 */
const KNOWN = [
  "applied",
  "already",
  "missing_file",
  "skipped",
  "na",
  "off",
  "pattern_not_found",
  "unmatched",
  "read_error",
  "write_error:<msg>",
  "failed",
  "pending",
  "deferred",
];

/** 五行快照。它不是权威 —— 权威只有 lib/patch/status.js 一处；改口径两处一起改。 */
const SNAPSHOT = {
  applied: { rank: 50, alwaysSoft: true, countsAsFailure: false, tone: "ok", displayBucket: "applied" },
  already: { rank: 60, alwaysSoft: true, countsAsFailure: false, tone: "ok", displayBucket: "applied" },
  missing_file: { rank: 40, alwaysSoft: true, countsAsFailure: false, tone: "idle", displayBucket: "skip" },
  skipped: { rank: 90, alwaysSoft: true, countsAsFailure: false, tone: "idle", displayBucket: "skip" },
  na: { rank: 70, alwaysSoft: true, countsAsFailure: false, tone: "idle", displayBucket: "skip" },
  off: { rank: 80, alwaysSoft: true, countsAsFailure: false, tone: "idle", displayBucket: "skip" },
  pattern_not_found: { rank: 20, alwaysSoft: false, countsAsFailure: true, tone: "error", displayBucket: "fail" },
  unmatched: { rank: 25, alwaysSoft: false, countsAsFailure: true, tone: "error", displayBucket: "unmatched" },
  read_error: { rank: 30, alwaysSoft: false, countsAsFailure: true, tone: "error", displayBucket: "fail" },
  "write_error:<msg>": { rank: 10, alwaysSoft: false, countsAsFailure: true, tone: "error", displayBucket: "fail" },
  failed: { rank: 0, alwaysSoft: false, countsAsFailure: true, tone: "error", displayBucket: "fail" },
  pending: { rank: 45, alwaysSoft: false, countsAsFailure: false, tone: "idle", displayBucket: "pending" },
  deferred: { rank: 95, alwaysSoft: false, countsAsFailure: false, tone: "idle", displayBucket: "skip" },
};

test("STATUS：每个已知 status 一行，五行判定与快照逐字相同", () => {
  assert.deepEqual(Object.keys(STATUS).sort(), [...KNOWN].sort(), "状态表多了或少了已知 status");
  for (const status of KNOWN) {
    assert.deepEqual(STATUS[status], SNAPSHOT[status], `${status} 的五行判定变了`);
  }
});

test("六个决策点一致性：软 ⇒ 审计轨不判 fail，失败 ⇒ 色调是 error", () => {
  // 这两条是同一条规则的两种说法：同一张表同时喂给审计轨（resultOfStatus）与
  // 设置页（toneOf），所以「放过的」不该在审计轨里变成 fail，「判失败的」不该在
  // 界面上是 idle。反方向也锁：色调用 error 就等于判失败，免得有人为了醒目乱涂。
  for (const status of Object.keys(STATUS)) {
    if (isAlwaysSoft(status)) {
      assert.notEqual(resultOfStatus(status), "fail", `${status} 是软放过，审计轨却判了 fail`);
    }
    if (countsAsFailure(status)) {
      assert.equal(toneOf(status), "error", `${status} 算失败，界面色调却是 ${toneOf(status)}`);
    }
    assert.equal(resultOfStatus(status) === "fail", countsAsFailure(status), `${status} 的审计折算与失败口径不一致`);
    assert.equal(toneOf(status) === "error", countsAsFailure(status), `${status} 的色调与失败口径不一致`);
  }
  // 前缀档走的是同一条路：表里只有一条 write_error，但真实取值带底层错误文本。
  for (const status of ["write_error:EACCES", "write_error:Error: EPERM: operation not permitted, open 'x'"]) {
    assert.equal(resultOfStatus(status), "fail", `${status} 应折成 fail`);
    assert.equal(toneOf(status), "error", `${status} 的色调应是 error`);
    assert.equal(rankOf(status), STATUS["write_error:<msg>"].rank, `${status} 与前缀表项同秩`);
  }
});

test("rankOf：补上 off 与 write_error 两个缺项，旧次序一个不动", () => {
  // 次序的语义是「同一条补丁在多个根上取最差」，与「算不算失败」正交：
  // 某个根上缺文件必须显示出来，所以 missing_file 排在 applied 之前，但它不算失败。
  const order = [
    "failed",
    "write_error:EACCES",
    "pattern_not_found",
    "read_error",
    "missing_file",
    "pending",
    "applied",
    "already",
    "na",
    "off",
    "skipped",
    "deferred",
  ];
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(
      rankOf(order[i - 1]) < rankOf(order[i]),
      `${order[i - 1]} 应排得比 ${order[i]} 更差（数更小）`,
    );
  }
  assert.equal(rankOf("done_moving"), 0, "认不出的 status 落到最差档 —— 与改前的兜底一致");
  // off 比 skipped 更轻：一个是「设置里关掉的」，一个是「原文里没有这个 pattern」。
  assert.ok(rankOf("off") < rankOf("skipped"), "off 应排在 skipped 之前（更轻）");
});

test("read_error 与 write_error 在设置页是 error，不是 idle", () => {
  assert.equal(toneOf("read_error"), "error");
  assert.equal(toneOf("write_error:EACCES"), "error");
  // 缺件仍是 idle：那一批补丁在当前宿主本来就不适用，涂红只会制造噪声。
  assert.equal(toneOf("missing_file"), "idle");
  assert.equal(toneOf("off"), "idle");
});

test("buildLayerRows：含读写失败的层，状态点是 error（界面不再说「没事」）", () => {
  const rows = buildLayerRows({
    patches: [
      { id: 1, layer: "代码", status: "read_error", title: "R" },
      { id: 2, layer: "工具", status: "write_error:EACCES", title: "W" },
    ],
  });
  const code = rows.find((r) => r.layer === "代码");
  const tool = rows.find((r) => r.layer === "工具");
  assert.equal(code.items[0].tone, "error");
  assert.equal(code.tone, "error");
  assert.equal(tool.items[0].tone, "error");
  assert.equal(tool.tone, "error");
});

test("isSoftOk：逐支等价于搬出前 —— strictFiles 优先，其余看 onMiss", () => {
  const onMissOf = (p) => (p && (p.onMiss === "warn" || p.onMiss === "ignore") ? p.onMiss : "fail");
  const patch = (extra) => ({ id: 1, ...extra });
  const row = { status: "pattern_not_found", patch_id: 1 };
  assert.equal(isSoftOk(row, patch({ onMiss: "fail" }), onMissOf), false);
  assert.equal(isSoftOk(row, patch({ onMiss: "warn" }), onMissOf), true);
  assert.equal(isSoftOk(row, patch({ onMiss: "ignore" }), onMissOf), true);
  assert.equal(isSoftOk(row, patch({ onMiss: "warn", strictFiles: true }), onMissOf), false);
  assert.equal(isSoftOk(row, patch({ onMiss: "ignore", strictFiles: true }), onMissOf), false);
  assert.equal(isSoftOk({ status: "read_error", patch_id: 1 }, patch({ onMiss: "warn" }), onMissOf), false);
  assert.equal(isSoftOk({ status: "missing_file", patch_id: 1 }, patch({ onMiss: "fail" }), onMissOf), true);
  assert.equal(isSoftOk(null), false);
  assert.equal(isSoftOk(row, null, null), false, "没有 onMiss 判定就按 fail，与补丁表缺省一致");
});

test("引擎的 isPatchResultSoftOk 与权威实现逐例一致（含按 id 查补丁表那条路）", () => {
  const patch = { id: 7, onMiss: "warn" };
  for (const status of Object.keys(STATUS)) {
    assert.equal(
      isPatchResultSoftOk({ status, patch_id: 7 }, patch),
      isSoftOk({ status, patch_id: 7 }, patch, (p) => (p?.onMiss === "warn" ? "warn" : "fail")),
      `${status} 在引擎入口与权威实现上判得不一样`,
    );
  }
  // 不给 patch 时引擎自己去补丁表里查：strictFiles 的那几条碰 pattern_not_found 必须判死。
  const strict = ALL_PATCHES.find((p) => p.strictFiles);
  const soft = ALL_PATCHES.find((p) => p.onMiss === "warn" || p.onMiss === "ignore");
  assert.ok(strict && soft, "补丁表里应当同时存在 strictFiles 与 onMiss 非 fail 的补丁");
  assert.equal(isPatchResultSoftOk({ status: "pattern_not_found", patch_id: strict.id }), false);
  assert.equal(isPatchResultSoftOk({ status: "pattern_not_found", patch_id: soft.id }), true);
});

test("apply.end 与 apply.host 用同一个 failed 判据：读写错误不再一为 3 一为 0", () => {
  const patches = [1, 2, 3, 4, 5].map((id) => ({ id, onMiss: "fail" }));
  const byId = new Map(patches.map((p) => [p.id, p]));
  const merged = [
    { patch_id: 1, status: "read_error" },
    { patch_id: 2, status: "read_error" },
    { patch_id: 3, status: "read_error" },
    { patch_id: 4, status: "applied" },
    { patch_id: 5, status: "missing_file" },
  ];
  const counts = applyEndCounts(merged, byId);
  assert.deepEqual(counts, { failed: 3, readError: 3, writeError: 0 }, "三条读错误必须进 failed");
  // 互证：apply.host 那一行的 failed 就是 summarizeApplyReport(...).failed.length。
  assert.equal(
    counts.failed,
    summarizeApplyReport(merged, patches).failed.length,
    "apply.end 与 apply.host 对 failed 的定义不同 —— 那正是这次要消灭的偏差",
  );
  // 两个新计数各自对得上，且缺件不算失败。
  assert.deepEqual(
    applyEndCounts([
      { patch_id: 1, status: "write_error:EACCES" },
      { patch_id: 2, status: "read_error" },
      { patch_id: 5, status: "missing_file" },
    ], byId),
    { failed: 2, readError: 1, writeError: 1 },
  );
});

test("分组归桶：判失败的不进 skip 桶，认不出的既不算跳过也不算已做", () => {
  const skip = Object.keys(STATUS).filter((s) => displayBucketOf(s) === "skip").sort();
  assert.deepEqual(skip, ["deferred", "missing_file", "na", "off", "skipped"], "skip 桶的成员变了");
  assert.notEqual(displayBucketOf("read_error"), "skip", "读写失败不许被归进跳过桶");
  assert.notEqual(displayBucketOf("pattern_not_found"), "skip");
  assert.equal(displayBucketOf("no_such_status"), "unknown");
  // 分组结论仍只输出四个值（界面按这四个值取文案），这里锁的是它确实从同一张表取桶。
  // 分组结论现在有第五档 `failed`：失败一组原先落到最后的 else，分组结论变成
  // skipped，设置页于是把它画成「没事」、计数也记进跳过。四档输入的行为不变。
  assert.equal(rollupDisplayStatus(["skipped", "missing_file", "off"]), "skipped");
  assert.equal(rollupDisplayStatus(["applied", "already"]), "applied");
  assert.equal(rollupDisplayStatus(["pending"]), "pending");
  assert.equal(rollupDisplayStatus(["unmatched"]), "unmatched");
  assert.equal(rollupDisplayStatus([]), "skipped");
  assert.equal(rollupDisplayStatus(["read_error"]), "failed");
  assert.equal(rollupDisplayStatus(["applied", "write_error:EACCES"]), "failed", "一组里有一条失败，这一组就是失败");
});

test("resultOfStatus：softOk 只放过 pattern_not_found，失败档不受影响", () => {
  assert.equal(resultOfStatus("pattern_not_found"), "fail");
  assert.equal(resultOfStatus("pattern_not_found", { softOk: true }), "skip");
  assert.equal(resultOfStatus("pattern_not_found", { softOk: false }), "fail");
  for (const status of ["read_error", "write_error:EACCES", "failed"]) {
    assert.equal(resultOfStatus(status, { softOk: true }), "fail", `${status} 不许被 softOk 放过`);
  }
  assert.equal(resultOfStatus("applied", { softOk: true }), "ok");
});

test("isReady 与引擎的 patchStatusReady 表驱动一致：同一输入同一结论", () => {
  const patches = [
    { id: 1, onMiss: "fail" },
    { id: 2, onMiss: "warn" },
    { id: 3, onMiss: "ignore" },
    { id: 4, onMiss: "warn", strictFiles: true },
    null,
  ];
  for (const status of [...Object.keys(STATUS), "write_error:EACCES", "no_such_status"]) {
    for (const patch of patches) {
      assert.equal(
        patchStatusReady(status, patch),
        isReady(status, patch, (p) => (p?.onMiss === "warn" || p?.onMiss === "ignore" ? p.onMiss : "fail")),
        `${status} + ${patch ? JSON.stringify(patch) : "无补丁"} 两个入口判得不一样`,
      );
    }
  }
  // 三档关键结论各点名一次，避免表驱动本身写错时整片同错。
  assert.equal(patchStatusReady("pattern_not_found", { onMiss: "ignore" }), true);
  assert.equal(patchStatusReady("pattern_not_found", { onMiss: "fail" }), false);
  assert.equal(patchStatusReady("na", null), false);
  assert.equal(patchStatusReady("missing_file", null), true);
  assert.equal(patchStatusReady("read_error", null), false);
});

test("tallyDisplayPatches：失败组不进「跳过」，也不算「就绪」", () => {
  const tally = tallyDisplayPatches([
    { status: "applied" },
    { status: "skipped" },
    { status: "pending" },
    { status: "unmatched" },
    { status: "failed" },
    { status: "read_error" },
  ]);
  assert.deepEqual(tally, {
    applied: 1, pending: 1, unmatched: 1, skipped: 1, failed: 2, total: 6, ready: 2,
  });
  assert.equal(tally.skipped, 1, "读写失败与硬失败都不许计进跳过");
  assert.equal(tally.ready, 2, "失败组不算就绪");
});

test("groupPatchesForDisplay：软 miss 折成 skipped，硬 miss 折成 failed，色调跟着走", () => {
  // 用分组表之外的编号：真实补丁号会被合并成一组，一条组的结论盖住两条补丁。
  const patches = [
    { id: 9901, name: "HARD", layer: "代码", marker: "M1", file: "k1", onMiss: "fail" },
    { id: 9902, name: "SOFT", layer: "代码", marker: "M2", file: "k2", onMiss: "ignore" },
  ];
  const rows = groupPatchesForDisplay(patches, {
    9901: "pattern_not_found",
    9902: "pattern_not_found",
  }, "desktop");
  const hard = rows.find((row) => row.id === 9901);
  const soft = rows.find((row) => row.id === 9902);
  assert.equal(hard.status, "failed");
  assert.equal(toneOf(hard.status), "error");
  assert.equal(soft.status, "skipped");
  assert.equal(toneOf(soft.status), "idle");
  assert.equal(tallyDisplayPatches(rows).skipped, 1, "只有软 miss 进跳过");
  assert.equal(tallyDisplayPatches(rows).failed, 1);
});
