/**
 * test/audit-run-seal.test.mjs — 一轮的结束是**一个显式标记**，不是「最后一条是什么」。
 *
 * 为什么单独立一份：原来的判据锚在「记录的排列」上（末行必须是层结论）。排列是会变的 ——
 * 一轮末尾可以有任意多个看起来像收尾的事件，每加一个（`audit.recorded` 就是这么加进去的），
 * 「最后一条是什么」就失效一次。这里把判据的两条性质各锁一遍：
 *
 *   一、**位置无关**：盖了结束标记之后，无论后面再挂几条「像收尾」的行，这一轮仍是收尾；
 *   二、**覆盖四个入口**：cli / http / command / tool 各一轮完整 + 各一轮截断，
 *       八份样本全部判对 —— 只修某一条的形态会在这里露出来。
 *
 * 反面（真机上本该是收尾的轮）也留着：判据只会报红不会报绿的测试等于没测。
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAuditCli } from "../lib/audit/index.js";
import { crossCheckRuns, summarizeRuns } from "../lib/audit/runs.js";

const TS = "2026-10-26T09:00:00.000+08:00";
const RUN = "apply-20261026T010000Z-seal";
const RID = "6d1b8f42-1f0a-4a55-9a1d-2f7f0c1b3a11";
const DIGEST = { sha256: "b".repeat(64), bytes: 12 };

/** 四个写审计的入口：每个都要能判对。 */
const ENTRIES = ["cli", "http", "command", "tool"];

function fileRow(seq, layer, patchId, entry, runId = RUN) {
  return {
    ts: TS,
    seq,
    recordId: RID,
    runId,
    observedTs: TS,
    event: `${layer}.patch-applied`,
    result: "ok",
    layer,
    actor: entry === "cli" ? "cli" : "host",
    entry,
    target: `补丁${patchId}`,
    evidence: { file: "app.js", marker: "M", hits: 1, bytes: 12, before: DIGEST, after: DIGEST },
    detail: { patchId, status: "applied" },
  };
}

function conclusionRow(seq, layer, ids, entry, { runEnd = false, runId = RUN } = {}) {
  return {
    ts: TS,
    seq,
    recordId: RID,
    runId,
    observedTs: TS,
    event: `${layer}.apply-result`,
    result: "ok",
    layer,
    actor: entry === "cli" ? "cli" : "host",
    entry,
    target: layer,
    evidence: { refSeq: Math.max(0, seq - 1), quote: `${layer}.patch-applied` },
    detail: {
      applied: ids.length,
      failed: 0,
      skipped: 0,
      unresolved: [],
      exempt: [],
      completeness: { patches: true, files: true, layers: true },
      considered: ids,
      expectedRows: ids.length,
      ...(runEnd ? { runEnd: true } : {}),
    },
  };
}

/** 一轮完整的 apply：三层各一条文件行 + 结论，末条结论盖章。 */
function completeRun(entry, runId = RUN) {
  return [
    fileRow(0, "prompt", 1, entry, runId),
    conclusionRow(1, "prompt", [1], entry, { runId }),
    fileRow(2, "code", 46, entry, runId),
    conclusionRow(3, "code", [46], entry, { runId }),
    fileRow(4, "tool", 29, entry, runId),
    conclusionRow(5, "tool", [29], entry, { runEnd: true, runId }),
  ];
}

function runAudit(argv) {
  const out = [];
  const err = [];
  const code = runAuditCli(argv, { out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out, err, text: out.join("\n") };
}

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-purge-audit-seal-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeJsonl(file, rows) {
  writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  return file;
}

test("四个入口 × 完整/截断：八份样本全部判对", () => {
  for (const entry of ENTRIES) {
    const runId = `apply-20261026T01000${ENTRIES.indexOf(entry)}Z-${entry}`;
    const full = completeRun(entry, runId);
    const good = summarizeRuns(full);
    assert.equal(good.total, 1, `${entry} 完整轮应当只有一轮`);
    assert.equal(good.runs[0].sealed, true, `${entry} 完整轮必须判成「盖了章」`);
    assert.equal(good.runs[0].judgeable, true, `${entry} 完整轮必须判得出来`);
    assert.equal(good.runs[0].closed, true, `${entry} 完整轮必须是收尾：\n${good.problems.join("\n")}`);
    assert.deepEqual(good.problems, [], `${entry} 完整轮不该有问题行：\n${good.problems.join("\n")}`);

    // 截断 A：写到文件层就被杀（还没轮到写结论）。
    const cutMid = full.slice(0, 3);
    const midSummary = summarizeRuns(cutMid);
    assert.equal(midSummary.runs[0].closed, false, `${entry} 截在文件层必须判红`);
    assert.equal(midSummary.runs[0].sealed, false, `${entry} 截在文件层不该有章`);

    // 截断 B：写完层结论、但在盖章之前被杀。夹具做成 v3（结论上带 detail.table）——
    // v2-entry 的同一形态判不了收尾（见 audit-generation.test.mjs），不是这一条要判的形态。
    const cutBeforeSeal = full.slice(0, 5);
    cutBeforeSeal[3].detail.table = { total: 3, exempt: [], unmapped: [], recorded: 3 };
    const sealSummary = summarizeRuns(cutBeforeSeal);
    assert.equal(sealSummary.runs[0].generation, "v3");
    assert.equal(sealSummary.runs[0].closed, false, `${entry} 截在盖章之前必须判红`);
    assert.ok(
      sealSummary.problems.some((line) => line.includes("缺结束标记")),
      `${entry} 截在盖章之前，理由要说是缺标记：\n${sealSummary.problems.join("\n")}`,
    );
  }
});

test("位置无关：盖章之后又挂了三条「像收尾」的行，这一轮仍是收尾", () => {
  const rows = completeRun("cli");
  // 三种都会让「最后一条是什么」失效的形态：一条非层的收尾类事件、一条不带层的探针、
  // 一条完全与 apply 无关的 CLI 事件。旧判据（末行必须是层结论）会因此判红。
  rows.push({ ts: TS, seq: 6, recordId: RID, runId: RUN, event: "route.reject", result: "fail", actor: "cli" });
  rows.push({ ts: TS, seq: 7, recordId: RID, runId: RUN, event: "code.probe", result: "ok", layer: "code", actor: "host" });
  rows.push({ ts: TS, seq: 8, recordId: RID, runId: RUN, event: "cli.invoke", result: "ok", actor: "cli" });
  const summary = summarizeRuns(rows);
  assert.equal(summary.runs[0].sealed, true, "标记还在，就该判成盖过章");
  assert.equal(
    summary.runs[0].closed,
    true,
    `盖章之后的追加行不该改变收尾结论：\n${summary.problems.join("\n")}`,
  );
});

test("反方向：v3 世代没有标记但层结论都在 → 截断，不许因为「末行是层结论」就放行", () => {
  const rows = completeRun("http").map((row) => {
    const detail = { ...row.detail };
    delete detail.runEnd;
    return { ...row, detail };
  });
  // 有 detail.table 就是 v3 写入方：缺章即截断。没有 table 的同一形态属于预世代，
  // 判不了收尾（那条在 audit-generation.test.mjs 上单列）。
  rows[3].detail.table = { total: 3, exempt: [], unmapped: [], recorded: 3 };
  const summary = summarizeRuns(rows);
  assert.equal(summary.runs[0].sealed, false);
  assert.equal(summary.runs[0].closed, false, "没有标记就是没收尾 —— 哪怕末行恰好是层结论");
  assert.equal(summary.truncated, 1);
});

test("旧口径（既无 runEnd 也无 considered）判成「不可判」，不判成截断", () => {
  // 上一代日志本来就没有标记。拿新判据判它会把它全判成中断，而真相是判据没依据。
  const rows = completeRun("command").map((row) => {
    const detail = { ...row.detail };
    delete detail.runEnd;
    delete detail.considered;
    delete detail.expectedRows;
    return { ...row, detail };
  });
  const summary = summarizeRuns(rows);
  assert.equal(summary.runs[0].judgeable, false, "老口径应当判成不可判");
  assert.equal(summary.runs[0].closed, false);
  assert.equal(summary.truncated, 0, "不可判不是截断，不进退出码");
  assert.equal(summary.unjudgeable, 1);
});

test("诊断轨：apply.end 之后还有 audit.recorded / cli.apply.done，这一轮仍算有收尾", () => {
  // 真机的一轮末尾真实顺序是 apply.end → install.record → audit.recorded → cli.apply.done。
  // 判据是「有没有 apply.end」，不是「最后一条是不是它」—— 后者会把唯一正常的一轮判成中断。
  const audit = summarizeRuns(completeRun("cli")).runs;
  const diag = [
    { ts: TS, event: "cli.apply.begin", sealed: "true" },
    { ts: TS, event: "apply.start", runId: RUN, entry: "cli", patches: "3", selected: "3" },
    { ts: TS, event: "apply.patch", runId: RUN, entry: "cli", id: "1", status: "applied" },
    { ts: TS, event: "apply.patch", runId: RUN, entry: "cli", id: "46", status: "applied" },
    { ts: TS, event: "apply.patch", runId: RUN, entry: "cli", id: "29", status: "applied" },
    { ts: TS, event: "apply.end", runId: RUN, entry: "cli", runEnd: "engine" },
    { ts: TS, event: "install.record", runId: RUN, entry: "cli", ok: "true" },
    { ts: TS, event: "audit.recorded", runId: RUN, entry: "cli", runEnd: "audit", events: "7" },
    // 这一条不带 runId（CLI 收尾体检写在身份之外），按 runId 分组看不到它。
    { ts: TS, event: "cli.apply.done", applied: "3", pending: "0" },
  ];
  const cross = crossCheckRuns(audit, diag);
  assert.deepEqual(cross.problems, [], `末尾多两条不该判成中断：\n${cross.problems.join("\n")}`);
  assert.equal(cross.matched, 1);
});

test("结构判据：收尾判定的源码里没有「末行 / 最后一条」这类位置依赖", () => {
  // 读源码断言，不是跑一遍：位置判据可以在测试里被夹具掩盖，源码里却还在。
  const runs = fs.readFileSync(new URL("../lib/audit/runs.js", import.meta.url), "utf8");
  assert.ok(
    runs.includes("closed: judgeable && reasons.length === 0"),
    "closed 必须是「判得了 且 没有别的问题」，不许再叠一条位置判断",
  );
  assert.equal(
    /reasons\.push\(\s*`?[^`]*末行/.test(runs),
    false,
    "理由里又出现了「末行」——位置判据回来了",
  );
  assert.equal(
    /isConclusion\(last\.event\)/.test(runs),
    false,
    "又拿末行是不是层结论当收尾判据了",
  );
  // 诊断轨那一侧同理：窗口判据必须是「存在 apply.end」，不是「最后一条是它」。
  const check = fs.readFileSync(new URL("../lib/audit/runs.js", import.meta.url), "utf8");
  assert.ok(check.includes("DIAG_END_EVENTS.includes"), "诊断轨的收尾标记集合不见了");
  assert.equal(
    /ends\.length === 0/.test(check),
    true,
    "诊断轨判收尾必须按「有没有结束标记」，而不是按位置",
  );
});

test("CLI 退出码：完整轮 0、截断轮 1（判据落到退出码上，不只停在函数返回值）", () => {
  withDir((dir) => {
    const good = writeJsonl(join(dir, "2026-10-26.jsonl"), completeRun("tool"));
    const okRun = runAudit(["check", "--jsonl", good]);
    assert.equal(okRun.code, 0, okRun.err.join("\n"));
    assert.match(okRun.text, /sealed=true/);
    assert.match(okRun.text, /judgeable=true/);

    const bad = writeJsonl(join(dir, "2026-10-26.1.jsonl"), completeRun("tool").slice(0, 4));
    const badRun = runAudit(["check", "--jsonl", bad]);
    assert.equal(badRun.code, 1, "截断必须落到退出码 1");
    assert.match(badRun.text, /sealed=false/);
  });
});
