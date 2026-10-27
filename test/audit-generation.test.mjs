/**
 * test/audit-generation.test.mjs — 判据锚在写入方的不变量上，不锚在「当前形态」上。
 *
 * 为什么单独立一份：上一版判据把「有 detail.considered」当成「这一代有结束标记」，
 * 于是过渡世代里一轮完整的三层账被判成「写到一半被杀」；反向对账则拿今天的入口表去判
 * 旧世代的轮，把当时根本不写审计的 CLI 轮判成「审计缺」。两处都不是日志坏了，是判据没依据。
 *
 * 这里把四个形态各造一份：预世代完整轮（判不了收尾）、v3 截断（真截断）、上一代反向 0 行
 * （不可判）、v3 反向 0 行（审计缺）。最后一组是红灯自检：把世代门删回去，上面那些断言
 * 必须翻面 —— 它锁的是「判据没有偷偷退回按形态判」。
 */
import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { auditGeneration, diagGeneration } from "../lib/audit/generation.js";
import { crossCheckRuns, summarizeRuns } from "../lib/audit/runs.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURES = path.join(ROOT, "test", "fixtures", "log-criteria");
const COVERED_DATES = new Set(["2026-10-25"]);

/** 读一份合成夹具（全部是造的，不含真机路径）。 */
function readRows(rel) {
  return readFileSync(path.join(FIXTURES, rel), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

test("预世代（v2-entry）完整轮：判不了收尾，不算截断", () => {
  const rows = readRows("audit-pre-seal.jsonl");
  const summary = summarizeRuns(rows);
  const run = summary.runs[0];
  assert.equal(auditGeneration(rows), "v2-entry");
  assert.equal(run.generation, "v2-entry");
  assert.equal(run.sealed, false);
  assert.equal(run.judgeable, false, "没有章的预世代判不了收尾");
  assert.equal(summary.truncated, 0, "判不了收尾不等于截断");
  assert.equal(summary.unjudgeable, 1);
  assert.ok(
    run.notes.some((line) => line.includes("v2-entry 世代无结束标记")),
    `没把「判不了收尾」记成信息项：\n${run.notes.join("\n")}`,
  );
});

test("v3 世代缺章：真截断（有 detail.table 就是这一代）", () => {
  const rows = readRows("audit-v3-truncated.jsonl");
  const summary = summarizeRuns(rows);
  assert.equal(auditGeneration(rows), "v3");
  assert.equal(summary.runs[0].sealed, false);
  assert.equal(summary.runs[0].judgeable, true);
  assert.equal(summary.truncated, 1);
  assert.ok(summary.problems.some((line) => line.includes("缺结束标记")));
});

test("recorded 按定义对账：自洽的绿，错值与差额都红", () => {
  assert.deepEqual(summarizeRuns(readRows("closed-v3.jsonl")).problems, []);
  const bad = summarizeRuns(readRows("recorded-bad.jsonl"));
  assert.ok(
    bad.problems.some((line) => line.includes("detail.table.recorded=2") && line.includes("不同补丁号是 3 个")),
    `recorded 错值没点名两个数：\n${bad.problems.join("\n")}`,
  );
  const gap = summarizeRuns(readRows("recorded-gap.jsonl"));
  assert.ok(
    gap.problems.some((line) => line.includes("静默丢失")),
    `recorded 与 total 的差没判红：\n${gap.problems.join("\n")}`,
  );
});

test("过滤 apply：recorded 的分母是 selected，合法过滤绿、selected 里缺条红", () => {
  // 这一条锁的是 V2 的硬错：补丁表 3 条、report 只含 2 条（合法过滤），
  // 拿全表当分母会把 recorded=2 判成「静默丢失」。
  const filtered = summarizeRuns(readRows("filtered-v3.jsonl"));
  assert.deepEqual(filtered.problems, [], `合法过滤轮被判红了：\n${filtered.problems.join("\n")}`);
  assert.equal(filtered.runs[0].closed, true);

  const missing = summarizeRuns(readRows("filtered-missing.jsonl"));
  assert.equal(missing.runs[0].closed, false);
  assert.ok(
    missing.problems.some((line) => line.includes("selected 里有") && line.includes("补丁：3")),
    `selected 里缺的补丁 3 没被点名：\n${missing.problems.join("\n")}`,
  );
});

test("没有 selected 的老日志按全表判，并留一条信息项", () => {
  // closed-v3.jsonl 的 detail.table 没有 selected：分母退回 total − exempt − unmapped，
  // 但读的人必须知道这一档不是过滤 apply 的口径。
  const legacy = summarizeRuns(readRows("closed-v3.jsonl"));
  assert.ok(
    legacy.notes.some((line) => line.includes("无 selected，按全表判")),
    `没把「按全表判」说出来：\n${legacy.notes.join("\n")}`,
  );
});

test("反向：上一代（诊断轨无 runEnd）0 行 → 不报审计缺，只记不可判", () => {
  const runs = summarizeRuns(readRows("pre-seal-dir/2026-10-25.jsonl")).runs;
  const cross = crossCheckRuns(runs, readRows("pre-seal.diag.jsonl"), { coveredDates: COVERED_DATES });
  assert.equal(cross.missingAudit, 0, "上一代不判审计缺");
  assert.ok(
    cross.staleNotes.some((line) => line.includes("上一代（无 runEnd）")),
    `没记「上一代无法判定」：\n${cross.staleNotes.join("\n")}`,
  );
});

test("反向：v3 世代（诊断轨盖了章）0 行 → 审计缺，点名入口与补丁条数", () => {
  const runs = summarizeRuns(readRows("v3-cli-dir/2026-10-25.jsonl")).runs;
  const cross = crossCheckRuns(runs, readRows("v3-cli.diag.jsonl"), { coveredDates: COVERED_DATES });
  assert.equal(cross.missingAudit, 1);
  assert.ok(
    cross.problems.some((line) => line.includes("诊断有、审计缺") && line.includes("entry=cli")),
    `没点名方向与入口：\n${cross.problems.join("\n")}`,
  );
});

test("反向：没有逐补丁判定（aborted / 0 补丁）0 行 → 不报审计缺，只记信息项", () => {
  // 这一轮发了 apply.start / apply.end（还盖了 runEnd），却一条 apply.patch 都没有：
  // 报告为空 → 不落审计是设计边界，反向对账没有可对账的判定。
  const cross = crossCheckRuns([], readRows("aborted-v3.diag.jsonl"), { coveredDates: new Set(["2026-10-26"]) });
  assert.equal(cross.missingAudit, 0, "没有可落账的判定时不许判审计缺");
  assert.deepEqual(cross.problems, []);
  assert.ok(
    cross.orderNotes.some((line) => line.includes("没有逐补丁判定")),
    `没把「没有可落账的判定」记成信息项：\n${cross.orderNotes.join("\n")}`,
  );
});

test("红灯自检：把世代门删回去，上面两条判据必须翻面", () => {
  // 这两段复刻的是被替换掉的旧判据（「有 considered 就判得了」「entry 在四个入口里就判缺」）。
  // 世代门一旦被删掉，下面的旧结论就会变成现行结论 —— 那时这两个断言会红。
  const preSeal = readRows("audit-pre-seal.jsonl");
  const pre = summarizeRuns(preSeal);
  const oldJudgeable = pre.runs[0].sealed || preSeal.some((row) => Array.isArray(row?.detail?.considered));
  assert.equal(oldJudgeable, true, "旧口径会把预世代判成 judgeable=true");
  assert.equal(pre.runs[0].judgeable, false, "现行判据必须判成 judgeable=false —— 删掉世代门这条就红");

  const runs = summarizeRuns(readRows("pre-seal-dir/2026-10-25.jsonl")).runs;
  const diag = readRows("pre-seal.diag.jsonl");
  const covered = new Set(runs.map((run) => run.runId));
  const oldMissing = [...new Set(diag
    .filter((row) => row.event === "apply.start" && row.entry === "cli")
    .map((row) => row.runId))]
    .filter((runId) => !covered.has(runId))
    .length;
  const cross = crossCheckRuns(runs, diag, { coveredDates: COVERED_DATES });
  assert.equal(oldMissing, 1, "旧口径会判 1 条「审计缺」");
  assert.equal(cross.missingAudit, 0, "现行判据必须判 0 —— 删掉反向世代门这条就红");

  // 同一条自检的第二个边界：没有逐补丁判定的轮，旧口径同样会判成「审计缺」。
  const abortedDiag = readRows("aborted-v3.diag.jsonl");
  const oldAbortedMissing = [...new Set(abortedDiag
    .filter((row) => row.event === "apply.start" && row.entry === "cli")
    .map((row) => row.runId))]
    .length;
  assert.equal(oldAbortedMissing, 1, "旧口径会把这个 aborted 轮判成 1 条「审计缺」");
  const abortedCross = crossCheckRuns([], abortedDiag, { coveredDates: new Set(["2026-10-26"]) });
  assert.equal(abortedCross.missingAudit, 0, "现行判据必须判 0 —— 删掉「没有逐补丁判定」这条边界就红");
});

test("世代判定只读日志：审计看 runEnd / table，诊断看结束事件上的 runEnd", () => {
  assert.equal(auditGeneration([]), "v1");
  assert.equal(auditGeneration([{ event: "code.probe" }]), "v1");
  assert.equal(auditGeneration([{ detail: { runEnd: true } }]), "v3");
  assert.equal(auditGeneration([{ detail: { table: { total: 1 } } }]), "v3");
  assert.equal(auditGeneration([{ detail: { considered: [] } }]), "v2-entry");
  assert.equal(auditGeneration([{ detail: { expectedRows: 0 } }]), "v2-entry");

  const legacy = readRows("pre-seal.diag.jsonl");
  assert.equal(diagGeneration(legacy), "v2-entry");
  // 两个阶段各盖各的章：任一条在，就是 v3 写入方。
  assert.equal(diagGeneration([...legacy, { event: "audit.recorded", runEnd: "audit" }]), "v3");
  assert.equal(diagGeneration([...legacy, { event: "apply.end", runEnd: "engine" }]), "v3");
  assert.equal(diagGeneration([{ event: "apply.end" }]), "v2-entry", "有事件没章不算 v3");
});

test("装机探针也判 recorded：自洽夹具 exit 0，错值 exit 1", () => {
  const runScript = (jsonl) => spawnSync(process.execPath, [
    "scripts/check-audit-completeness.mjs",
    "--jsonl", path.join("test", "fixtures", "log-criteria", jsonl),
    "--response", path.join("test", "fixtures", "log-criteria", "closed-v3-response.json"),
  ], { cwd: ROOT, encoding: "utf8", env: { ...process.env, DSH_PURGE_LOG: "0" } });

  const good = runScript("closed-v3.jsonl");
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /detail\.table\.recorded == 文件行里的不同补丁号个数（3）/);

  const bad = runScript("recorded-bad.jsonl");
  assert.equal(bad.status, 1, "recorded 错值时探针必须红");
  assert.match(bad.stderr, /detail\.table\.recorded == 文件行里的不同补丁号个数/);
});
