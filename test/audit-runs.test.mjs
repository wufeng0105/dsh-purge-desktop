/**
 * test/audit-runs.test.mjs — 审计轨的轮边界：收尾与截断必须分得开，两轨必须对得上。
 *
 * 为什么单独立一份：审计轨按层落账，没有任何一行说「这一轮到此结束」。于是「三层都有
 * 结论」与「写完第二层就被杀掉」在只看层结论时长得一样 —— 而读日志的人（尤其照着日志
 * 下结论的 AI）会把截断读成正常收尾。这里把四类截断各造一次，逐条确认判据变红；
 * 另造一份与诊断轨对得上的夹具，确认「互证」不是一句空话。
 *
 * 反面情形（真机上三份完好的日志）也留着：判据只会报红不会报绿的测试等于没测。
 */
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAuditCli } from "../lib/audit/index.js";
import { crossCheckRuns, summarizeRuns } from "../lib/audit/runs.js";

const TS = "2026-10-25T18:00:00.000+08:00";
const RUN = "apply-20261025T180000Z-aaaa";
const RID = "b41f0c7e-9a52-4f13-8a6e-2d7c1e5b9f04";

/** 一条文件层事件：一个补丁在一个文件上的一次探针。 */
function fileRow(seq, layer, patchId, status, runId = RUN) {
  // before / after 摘要两个都在：新口径的层结论带 considered，`completeness.files`
  // 会被按「行数 + 摘要齐全」复算 —— 夹具缺摘要就不是一份完整轮的样本。
  const digest = { sha256: "a".repeat(64), bytes: 10 };
  return {
    ts: TS,
    seq,
    recordId: RID,
    runId,
    observedTs: TS,
    event: `${layer}.patch-${status === "applied" ? "applied" : status === "skipped" ? "skipped" : "miss"}`,
    result: status === "applied" ? "ok" : status === "skipped" ? "skip" : "fail",
    layer,
    actor: "host",
    target: `补丁${patchId}`,
    evidence: { file: "app.js", marker: "M", hits: 1, bytes: 10, before: digest, after: digest },
    detail: { patchId, status },
  };
}

/**
 * 一条层结论：引用本层最后一条探针，带计数与完备性三布尔。
 *
 * `runEnd` 是这一轮的**结束标记**（判据是「有没有」，不是「排第几」）：一份完整收尾的
 * 夹具必须把它盖在最后一条结论上；会被截断的夹具不盖 —— 那正是「被判成中断」的形态。
 */
function conclusionRow(seq, layer, { applied = 1, failed = 0, skipped = 0, layers = true, runId = RUN, runEnd = false, ids = [] } = {}) {
  return {
    ts: TS,
    seq,
    recordId: RID,
    runId,
    observedTs: TS,
    event: `${layer}.apply-result`,
    result: failed > 0 ? "fail" : skipped > 0 ? "partial" : "ok",
    layer,
    actor: "host",
    target: layer,
    evidence: { refSeq: Math.max(0, seq - 1), quote: `${layer}.patch-applied` },
    detail: {
      applied,
      failed,
      skipped,
      unresolved: [],
      exempt: [],
      completeness: { patches: true, files: true, layers },
      considered: ids,
      expectedRows: ids.length,
      ...(runEnd ? { runEnd: true } : {}),
    },
  };
}

/** 一份完整收尾的三层：文件行与结论交替，末条结论盖了结束标记。 */
function closedRun(runId = RUN) {
  return [
    fileRow(0, "prompt", 1, "applied", runId),
    conclusionRow(1, "prompt", { applied: 1, runId, ids: [1] }),
    fileRow(2, "code", 46, "applied", runId),
    conclusionRow(3, "code", { applied: 1, runId, ids: [46] }),
    fileRow(4, "tool", 29, "applied", runId),
    conclusionRow(5, "tool", { applied: 1, runId, ids: [29], runEnd: true }),
  ];
}

/** 三例 CLI：只断言退出码与输出里的关键行，不锁整段排版。 */
function runAudit(argv) {
  const out = [];
  const err = [];
  const code = runAuditCli(argv, { out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out, err, text: out.join("\n") };
}

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-purge-audit-runs-"));
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

test("完整收尾的一轮：末行是结论、三层齐全、层顺序合法 → closed 且 CLI 退出码 0", () => {
  withDir((dir) => {
    const file = writeJsonl(join(dir, "2026-10-25.jsonl"), closedRun());
    const summary = summarizeRuns(closedRun());
    assert.equal(summary.total, 1);
    assert.equal(summary.runless, 0);
    assert.equal(summary.truncated, 0);
    assert.deepEqual(summary.problems, []);
    assert.equal(summary.runs[0].closed, true);
    assert.deepEqual(summary.runs[0].layers, ["prompt", "code", "tool"]);

    const cli = runAudit(["check", "--jsonl", file]);
    assert.equal(cli.code, 0, cli.err.join("\n"));
    assert.match(cli.text, /runs: 1（收尾 1 \/ 截断 0）/);
    assert.match(cli.text, new RegExp(`${RUN}  rows=6 seq=0\\.\\.5 layers=prompt→code→tool closed=true`));
    assert.match(cli.text, /ok: true/);
  });
});

test("截断①（v3 世代）：写到文件层就被杀（没有结束标记）→ 判据红，点明「缺结束标记」", () => {
  // 这条用例原来锁的是「末行是 tool.patch-applied」这句位置判据。判据换成结束标记之后，
  // 那个字符串该消失：位置会随事件数量变化，标记不会。夹具做成 v3（结论上带 detail.table），
  // 于是「没章」就是真截断 —— v2-entry 的同一形态见下一条（判不了收尾，不是截断）。
  const rows = closedRun().slice(0, 4);
  rows[3].detail.table = { total: 2, exempt: [], unmapped: [], recorded: 2 };
  rows.push(fileRow(4, "tool", 29, "applied"));
  const summary = summarizeRuns(rows);
  assert.equal(summary.runs[0].generation, "v3");
  assert.equal(summary.truncated, 1);
  assert.equal(summary.runs[0].closed, false);
  assert.equal(summary.runs[0].sealed, false);
  assert.ok(
    summary.problems.some((line) => line.includes("缺结束标记")),
    `理由里没有点名缺结束标记：\n${summary.problems.join("\n")}`,
  );
  assert.ok(
    summary.problems.some((line) => line.includes("tool 有文件层事件，却没有这一层的结论")),
    `理由里没有点名缺结论的层：\n${summary.problems.join("\n")}`,
  );
});

test("预世代（v2-entry）没有结束标记：判不了收尾、不算截断；集合矛盾照样红", () => {
  // 同一个形状去掉 detail.table ⇒ 认成 v2-entry：那一代的写侧还没有盖章这一步，
  // 拿新判据判它会把完整轮也判成中断。但「缺结论」是集合矛盾，照样判得了、照样红。
  const rows = closedRun().slice(0, 4);
  rows.push(fileRow(4, "tool", 29, "applied"));
  const summary = summarizeRuns(rows);
  assert.equal(summary.runs[0].generation, "v2-entry");
  assert.equal(summary.runs[0].sealed, false);
  assert.equal(summary.runs[0].judgeable, true, "有集合矛盾时仍判得了");
  assert.equal(summary.truncated, 1, "集合矛盾要红");
  assert.ok(
    summary.runs[0].notes.some((line) => line.includes("v2-entry 世代无结束标记")),
    "没把「判不了收尾」记成信息项",
  );
  assert.ok(
    !summary.problems.some((line) => line.includes("缺结束标记")),
    "v2-entry 不该判「缺结束标记」—— 那一代本来就没有这个标记",
  );
});

test("截断②：层层之间被切断，靠结论自带的 layers 布尔识别 —— 这是「看起来最完整」的那一形态", () => {
  // 前两层的结论都声明 completeness.layers 为真：落账方在动手前按整批补丁算出「三层都记全了」，
  // 所以后一层一条文件行都没有，只可能是被截断，不是那一层本来没活干。
  const rows = [
    fileRow(0, "prompt", 1, "applied"),
    conclusionRow(1, "prompt", { applied: 1, layers: true }),
    fileRow(2, "code", 46, "applied"),
    conclusionRow(3, "code", { applied: 1, layers: true }),
  ];
  const summary = summarizeRuns(rows);
  assert.equal(summary.runs[0].closed, false);
  // 末行确实是一条结论 —— 单看第一条规则会判成收尾，所以这条用例正是判据的必要性所在。
  assert.equal(summary.runs[0].lastEvent, "code.apply-result");
  assert.ok(
    summary.problems.some((line) => line.includes("completeness.layers 为真") && line.includes("tool")),
    `理由里没有指出「声称记全了却缺 tool」：\n${summary.problems.join("\n")}`,
  );
});

test("截断③：层顺序被打乱（code 在 prompt 之前）→ 判据红", () => {
  const rows = [
    fileRow(0, "code", 46, "applied"),
    conclusionRow(1, "code", { applied: 1, layers: false }),
    fileRow(2, "prompt", 1, "applied"),
    conclusionRow(3, "prompt", { applied: 1, layers: false }),
  ];
  const summary = summarizeRuns(rows);
  assert.equal(summary.runs[0].closed, false);
  assert.ok(
    summary.problems.some((line) => line.includes("层第一次出现的顺序是 code → prompt")),
    `理由里没有点名层顺序：\n${summary.problems.join("\n")}`,
  );
});

test("截断④：结论的计数与文件行对不上 → 判据红（层结论不许盖住自己那些行）", () => {
  const rows = [
    fileRow(0, "prompt", 1, "applied"),
    conclusionRow(1, "prompt", { applied: 3, layers: false }),
  ];
  const summary = summarizeRuns(rows);
  assert.equal(summary.runs[0].closed, false);
  assert.ok(
    summary.problems.some((line) => line.includes("applied+failed+skipped") && line.includes("对不上")),
    `理由里没有点名计数对不上：\n${summary.problems.join("\n")}`,
  );
});

test("没有 runId 的旧行不进轮判定：runless 单独计数，不许当成一轮", () => {
  const rows = [{ ts: TS, seq: 0, event: "code.probe", result: "ok" }];
  const summary = summarizeRuns(rows);
  assert.equal(summary.total, 0);
  assert.equal(summary.runless, 1);
  assert.deepEqual(summary.problems, []);
});

test("跨轨对账：补丁号与状态都对得上才算互证（次序不参与判定）", () => {
  // 这条用例原先叫「补丁号、状态、顺序都对得上才算互证」，锁的是「审计次序必须是
  // 诊断次序的子序列」。那个断言没有依据：审计轨按「层分组 + 层内补丁号升序」写，
  // 诊断轨按补丁表序写，两套排序规则本来就不同 —— 真机上三个 CLI apply 因此全被判
  // 「一致 false」。次序降级为信息项之后，这条用例只锁集合与状态。
  const runs = summarizeRuns(closedRun()).runs;
  const diag = [
    { ts: TS, event: "apply.start", runId: RUN, patches: "3", selected: "3" },
    { ts: TS, event: "apply.patch", runId: RUN, id: "1", name: "A", status: "applied" },
    { ts: TS, event: "apply.patch", runId: RUN, id: "46", name: "B", status: "applied" },
    { ts: TS, event: "apply.patch", runId: RUN, id: "29", name: "C", status: "applied" },
    { ts: TS, event: "apply.end", runId: RUN, pendingRestart: "true" },
  ];
  const cross = crossCheckRuns(runs, diag);
  assert.deepEqual(cross.problems, []);
  assert.deepEqual(cross.orderNotes, [], "两轨次序相同时不该有信息项");
  assert.equal(cross.matched, 1);
  assert.equal(cross.unmatched, 0);
});

test("跨轨对账：两轨次序不同只记信息项，不判红", () => {
  // 真机形态：审计侧 prompt 组末尾才是 70、73，诊断侧它们紧跟 1、2、3。
  // 这不是分歧 —— 判红会让每一轮 apply 都「对不上」，而日志是好的。
  const runs = summarizeRuns(closedRun()).runs;
  const diag = [
    { ts: TS, event: "apply.start", runId: RUN },
    { ts: TS, event: "apply.patch", runId: RUN, id: "46", status: "applied" },
    { ts: TS, event: "apply.patch", runId: RUN, id: "29", status: "applied" },
    { ts: TS, event: "apply.patch", runId: RUN, id: "1", status: "applied" },
    { ts: TS, event: "apply.end", runId: RUN },
  ];
  const cross = crossCheckRuns(runs, diag);
  assert.deepEqual(cross.problems, [], "次序不同不是分歧，不该进 problems");
  assert.equal(cross.matched, 1);
  assert.equal(cross.unmatched, 0);
  assert.equal(cross.orderNotes.length, 1, "次序差异必须单独记一条信息项，而不是静默丢掉");
  assert.match(cross.orderNotes[0], /排序规则差异不是分歧/);
});

test("跨轨对账：状态两轨不一致 → 判据红并点名是哪一条补丁", () => {
  const runs = summarizeRuns(closedRun()).runs;
  const diag = [
    { ts: TS, event: "apply.start", runId: RUN },
    { ts: TS, event: "apply.patch", runId: RUN, id: "1", status: "applied" },
    { ts: TS, event: "apply.patch", runId: RUN, id: "46", status: "skipped" },
    { ts: TS, event: "apply.patch", runId: RUN, id: "29", status: "applied" },
    { ts: TS, event: "apply.end", runId: RUN },
  ];
  const cross = crossCheckRuns(runs, diag);
  assert.equal(cross.matched, 0);
  assert.ok(
    cross.problems.some((line) => line.includes("补丁 46 的状态两轨不一致")),
    `没有点名状态不一致的那条补丁：\n${cross.problems.join("\n")}`,
  );
});

test("跨轨对账：诊断轨缺轮结束标记 → 判据红（这一轮在诊断轨里也没收尾）", () => {
  const runs = summarizeRuns(closedRun()).runs;
  const diag = [
    { ts: TS, event: "apply.start", runId: RUN },
    { ts: TS, event: "apply.patch", runId: RUN, id: "1", status: "applied" },
  ];
  const cross = crossCheckRuns(runs, diag);
  assert.equal(cross.matched, 0);
  assert.ok(
    cross.problems.some((line) => line.includes("没有 apply.end / apply.gate.reject")),
    `没有指出缺结束标记：\n${cross.problems.join("\n")}`,
  );
});

test("跨轨对账：诊断轨里根本没有这个 runId → 判据红（滚过 / 搬过 / 入口不写诊断轨）", () => {
  const runs = summarizeRuns(closedRun()).runs;
  const cross = crossCheckRuns(runs, [{ ts: TS, event: "cli.invoke" }]);
  assert.equal(cross.matched, 0);
  assert.ok(cross.problems.some((line) => line.includes("诊断轨里没有这个 runId")));
});

test("CLI --diag：对得上退出 0，对不上退出 1，--diag 指错文件退出 2", () => {
  withDir((dir) => {
    const audit = writeJsonl(join(dir, "2026-10-25.jsonl"), closedRun());
    const diag = writeJsonl(join(dir, "diag.jsonl"), [
      { ts: TS, event: "apply.start", runId: RUN },
      { ts: TS, event: "apply.patch", runId: RUN, id: "1", status: "applied" },
      { ts: TS, event: "apply.patch", runId: RUN, id: "46", status: "applied" },
      { ts: TS, event: "apply.patch", runId: RUN, id: "29", status: "applied" },
      { ts: TS, event: "apply.end", runId: RUN },
    ]);
    const ok = runAudit(["check", "--jsonl", audit, "--diag", diag]);
    assert.equal(ok.code, 0, ok.err.join("\n"));
    assert.match(ok.text, /cross: 对上 1 \/ 共 1 轮/);

    const other = writeJsonl(join(dir, "diag2.jsonl"), [{ ts: TS, event: "cli.invoke" }]);
    const bad = runAudit(["check", "--jsonl", audit, "--diag", other]);
    assert.equal(bad.code, 1, "诊断轨对不上时退出码必须是 1");
    assert.match(bad.text, /ok: false/);

    const missing = runAudit(["check", "--jsonl", audit, "--diag", join(dir, "nope.jsonl")]);
    assert.equal(missing.code, 2, "指错文件是环境错误，不是判据不过");
    assert.match(missing.err.join("\n"), /--diag/);
  });
});

test("CLI：截断的一轮退出码 1，--json 里带上逐轮结论", () => {
  withDir((dir) => {
    const rows = closedRun().slice(0, 4);
    const file = writeJsonl(join(dir, "2026-10-25.jsonl"), rows);
    const cli = runAudit(["check", "--jsonl", file]);
    assert.equal(cli.code, 1, "截断必须判红");
    const structured = runAudit(["check", "--jsonl", file, "--json"]);
    const report = JSON.parse(structured.out.join("\n"));
    assert.equal(report.ok, false);
    assert.equal(report.gaps, 0, "断号不是这次要判的东西，别让它跟着一起红");
    assert.equal(report.runs.truncated, 1);
    assert.equal(report.runs.detail[0].closed, false);
    assert.ok(report.runs.problems.length >= 1);
  });
});
