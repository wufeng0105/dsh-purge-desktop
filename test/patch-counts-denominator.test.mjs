/**
 * test/patch-counts-denominator.test.mjs — 「几条没打上」的两个分母必须同时说出口。
 *
 * 为什么单独立一份：同一份状态快照曾同时说出四个数 —— 摘要 55/62、明细 66 行、
 * `--diagnose` 的 counts 55/2/5/62、启动 pending 3 条。四个数各自都对，因为它们用了两个
 * 分母（补丁号 66 / 展示行 62），而没有任何一处标注。修法不是把某一个数改掉，
 * 是让唯一出口 `lib/patch/counts.js` 同时给两种口径，消费者各自说出用的是哪一个。
 *
 * 这里锁四件事：
 *   一、66 ↔ 62 的映射由分组自己推出来，不是手抄的常数；
 *   二、`raw` 与 `display` 的差正好是「被并掉的行数」；
 *   三、摘要行两个分母都出现，且待清洗不一致时点名展示口径；
 *   四、CLI / 诊断 / 启动三处都读这一份，不再自己数。
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ALL_PATCHES, PATCH_DISPLAY_GROUPS } from "../lib/patch/table.js";
import { countsLine, displayCounts, rawCounts, summarizeCounts } from "../lib/patch/counts.js";
import { groupPatchesForDisplay, tallyDisplayPatches } from "../lib/core.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 全表都 applied，只把三组里的第一条留成 pending：用来量「并掉几行」。 */
function statusAllApplied() {
  const status = {};
  for (const patch of ALL_PATCHES) status[patch.id] = "applied";
  return status;
}

test("两个分母：66 条原始 / 展示行 = 66 − 被并掉的行数", () => {
  const status = statusAllApplied();
  const rows = groupPatchesForDisplay(ALL_PATCHES, status, "desktop");
  const merged = rows.reduce((sum, row) => sum + Math.max(0, (row.ids || []).length - 1), 0);
  const counts = summarizeCounts({ status, patches: ALL_PATCHES, displayRows: rows });
  assert.equal(counts.raw.total, ALL_PATCHES.length, "原始口径的分母必须是补丁表全量");
  assert.ok(merged > 0, "这一版表里应当有展示组（否则这条用例量不到分母差）");
  assert.equal(
    counts.display.total,
    counts.raw.total - merged,
    `展示行数必须等于原始条数减被并掉的行数（merged=${merged}）`,
  );
  // 显式钉住这一版的实测值：三组 [1,2,3] / [11,12] / [83,84] → 并掉 4 行。
  const groups = Object.values(PATCH_DISPLAY_GROUPS).filter((ids) => ids.length > 1);
  assert.equal(groups.reduce((sum, ids) => sum + ids.length - 1, 0), merged, "分组表与实测并掉的行数不一致");
});

test("同一份行数据的两个计数器必须相等：tallyDisplayPatches 只是 displayCounts 的转发", () => {
  const status = statusAllApplied();
  status[1] = "pending";
  status[50] = "failed";
  const rows = groupPatchesForDisplay(ALL_PATCHES, status, "desktop");
  assert.deepEqual(tallyDisplayPatches(rows), displayCounts(rows), "按行的计数不许有两份实现");
  // 行状态是合并结论：一条 pending 就让整行 pending，所以行口径的 pending 只会少不会多。
  const counts = summarizeCounts({ status, patches: ALL_PATCHES, displayRows: rows });
  assert.ok(counts.display.pending <= counts.raw.pending, "行口径的待清洗数不可能多于补丁号口径");
});

test("原始口径的就绪与跳过不是同一列：na 不进分母，也不冒充就绪", () => {
  const status = { 1: "applied", 2: "na", 3: "skipped" };
  const patches = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const raw = rawCounts(status, patches);
  assert.equal(raw.na, 1, "na 单独一列");
  assert.equal(raw.total, 2, "na 不进分母（宿主上不适用的补丁不是「没打上」）");
  assert.equal(raw.applied, 1);
  assert.equal(raw.skipped, 1);
  assert.equal(raw.ready, 2, "applied 与 skipped 都算就绪；na 不算");
});

test("摘要行两个分母同时出现，待清洗不一致时点名展示口径", () => {
  const raw = { applied: 58, pending: 3, skipped: 5, failed: 0, other: 0, ready: 60, na: 0, total: 66 };
  const display = { applied: 55, pending: 2, unmatched: 0, skipped: 5, failed: 0, ready: 60, total: 62 };
  const line = countsLine({ raw, display });
  assert.match(line, /58\/66/, `摘要没打原始分母：${line}`);
  assert.match(line, /62 个展示行/, `摘要没打展示分母：${line}`);
  assert.match(line, /其中 55 已清洗/, "展示口径的已清洗数要跟着写出来");
  assert.match(line, /3 待清洗/, "待清洗按原始口径");
  assert.match(line, /展示口径 2 条/, "两个口径的待清洗不一致时必须点名，否则用户无从判断该信哪个");
  // 分母相等时不许加括注：那是噪声，而且会让人以为「展示行」是新概念。
  const same = countsLine({ raw, display: { ...display, total: 66 } });
  assert.equal(same.includes("展示行"), false, "分母相同还括注，等于把平均值写在每行末尾");
});

test("未评估态不许说 0/0：没有可判的补丁时，摘要要说出分母不在", () => {
  // 现场：宿主刚被官方更新、asar 还密封 —— `patch_status` 是空的，`raw.na` 是全表。
  // 修前这一档打印「补丁 0/0 已清洗」，而同一份 JSON 里 raw.na=66、patches 里 66 条全是 na：
  // 读日志的人（或模型）会得出「没什么待办」的结论，而那正是最需要读数的起点。
  const line = countsLine({
    raw: { applied: 0, pending: 0, skipped: 0, failed: 0, other: 0, ready: 0, na: 66, total: 0, pendingIds: [] },
    display: { applied: 0, pending: 0, unmatched: 0, skipped: 0, failed: 0, ready: 0, total: 0 },
  });
  assert.match(line, /未评估/, `未评估态没说出来：${line}`);
  assert.match(line, /66 条不适用或宿主未定位/, `没说清为什么没有分母：${line}`);
  assert.equal(line.includes("0/0"), false, "0/0 会被读成「没有待办」——分母根本不在");
  // 补丁表为空是另一档成因，也要说得出话。
  const blank = countsLine({
    raw: { applied: 0, pending: 0, skipped: 0, failed: 0, other: 0, ready: 0, na: 0, total: 0, pendingIds: [] },
    display: { applied: 0, pending: 0, unmatched: 0, skipped: 0, failed: 0, ready: 0, total: 0 },
  });
  assert.match(blank, /补丁表为空或尚未评估/);
});

test("四个消费者读同一份：CLI 摘要 / 诊断 counts / 启动 pending 都指向 counts", () => {
  const cli = fs.readFileSync(path.join(ROOT, "bin", "dsh-purge.js"), "utf8");
  assert.ok(cli.includes("countsLine(patchView.counts)"), "CLI 摘要没用唯一出口");
  assert.ok(cli.includes('base: "raw"'), "--diagnose 必须写明 counts 的分母是哪一种");
  assert.ok(cli.includes("raw: patchView.counts.raw"), "--diagnose 要同时给两种口径");
  assert.ok(cli.includes("display: patchView.counts.display"), "--diagnose 要同时给两种口径");

  const reapply = fs.readFileSync(path.join(ROOT, "lib", "reapply.js"), "utf8");
  assert.ok(reapply.includes("displayPending"), "启动对齐没带上展示口径的待清洗，UI 说 2 条、启动说 3 条就还会发生");

  const startup = fs.readFileSync(path.join(ROOT, "lib", "audit", "startup.js"), "utf8");
  assert.ok(startup.includes("pendingDisplay"), "启动事件没写展示口径，两个分母在日志里仍然只有一个");
});
