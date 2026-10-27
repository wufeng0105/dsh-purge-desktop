/**
 * test/audit-bidirectional.test.mjs — 两轨对账必须双向：哪个方向缺都能被一条命令点出来。
 *
 * 为什么单独立一份：原先只有「审计行 → 诊断轨」一个方向，于是真机上两个完整的
 * CLI apply 在审计轨 0 行，而所有判据都是绿的 —— 单向对账只能证明「我记了的确实发生过」，
 * 证明不了「发生过的我都记了」。这里把两个方向各造一次，并要求输出点名方向。
 *
 * 另有三条边界同在这份用例里：
 *   · `check --run <runId>` 必须存在（此前 `--run foo` 是用法错误 exit 2，等于「查不了」）；
 *   · 早于诊断轨现存第一行的轮次是「不可判」信息项，不许判红（否则健康机器上也 exit 1）；
 *   · 故意少一条补丁行时必须点名是哪个 patchId。
 *
 * 全部夹具在系统临时目录里现造，跑完即删。
 */
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAuditCli } from "../lib/audit/index.js";
import * as reapply from "../lib/reapply.js";

const TS = "2026-10-25T18:00:00.000+08:00";
const RUN = "apply-20261025T180000Z-aaaa";
const RID = "b41f0c7e-9a52-4f13-8a6e-2d7c1e5b9f04";
/** 仓库里的合成夹具：反向对账的两条边界在那里各有一份固定形态。 */
const FIXTURES = join(import.meta.dirname, "fixtures", "log-criteria");

/** 一条文件层事件：一个补丁在一个文件上的一次探针，摘要齐全。 */
function fileRow(seq, layer, patchId, status = "applied", runId = RUN, ts = TS) {
  const digest = { sha256: "a".repeat(64), bytes: 10 };
  return {
    ts,
    seq,
    recordId: RID,
    runId,
    observedTs: ts,
    event: `${layer}.patch-${status === "applied" ? "applied" : "miss"}`,
    result: status === "applied" ? "ok" : "fail",
    layer,
    actor: "host",
    entry: "http",
    target: `补丁${patchId}`,
    evidence: { file: "app.js", marker: "M", hits: 1, bytes: 10, before: digest, after: digest },
    detail: { patchId, status },
  };
}

/** 一条层结论：带计数、完备性三布尔与可复算的分母。 */
function conclusionRow(seq, layer, ids, { applied = ids.length, failed = 0, skipped = 0, runId = RUN, ts = TS, runEnd = false } = {}) {
  return {
    ts,
    seq,
    recordId: RID,
    runId,
    observedTs: ts,
    event: `${layer}.apply-result`,
    result: failed > 0 ? "fail" : skipped > 0 ? "partial" : "ok",
    layer,
    actor: "host",
    entry: "http",
    target: layer,
    evidence: { refSeq: Math.max(0, seq - 1), quote: `${layer}.patch-applied` },
    detail: {
      applied,
      failed,
      skipped,
      unresolved: [],
      exempt: [],
      completeness: { patches: true, files: true, layers: true },
      considered: ids,
      expectedRows: ids.length,
      ...(runEnd ? { runEnd: true } : {}),
      ...(failed === 0 && skipped > 0 ? { partialReason: "layer" } : {}),
    },
  };
}

/** 一份三层齐全、末条结论盖了结束标记的收尾轮。 */
function closedRun(runId = RUN, ts = TS) {
  return [
    fileRow(0, "prompt", 1, "applied", runId, ts),
    conclusionRow(1, "prompt", [1], { runId, ts }),
    fileRow(2, "code", 46, "applied", runId, ts),
    conclusionRow(3, "code", [46], { runId, ts }),
    fileRow(4, "tool", 29, "applied", runId, ts),
    conclusionRow(5, "tool", [29], { runId, ts, runEnd: true }),
  ];
}

/** 诊断轨里一次完整的 apply：起点、逐补丁、收尾（结束事件上盖章），entry 由调用方给。 */
function diagRows(runId, entry, ts = TS) {
  return [
    { ts, event: "apply.start", runId, entry, patches: "3", selected: "3" },
    { ts, event: "apply.patch", runId, entry, id: "1", status: "applied" },
    { ts, event: "apply.patch", runId, entry, id: "46", status: "applied" },
    { ts, event: "apply.patch", runId, entry, id: "29", status: "applied" },
    { ts, event: "apply.end", runId, entry, applied: "3", failed: "0", runEnd: "engine" },
  ];
}

/** 上一代的同一次 apply：事件齐、结束事件上没有 runEnd。 */
function legacyDiagRows(runId, entry, ts = TS) {
  return diagRows(runId, entry, ts).map((row) => {
    const { runEnd, ...rest } = row;
    return rest;
  });
}

function writeJsonl(file, rows) {
  writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  return file;
}

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-purge-bidir-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runAudit(argv) {
  const out = [];
  const err = [];
  const code = runAuditCli(argv, { out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out, err, text: `${out.join("\n")}\n${err.join("\n")}` };
}

test("方向一（诊断缺）：审计有这一轮、诊断轨 0 行 → 红，并说明是哪个方向", () => {
  withDir((dir) => {
    const audit = writeJsonl(join(dir, "2026-10-25.jsonl"), closedRun());
    const diag = writeJsonl(join(dir, "diag.jsonl"), [{ ts: TS, event: "cli.invoke" }]);
    const result = runAudit(["check", "--jsonl", audit, "--diag", diag]);
    assert.equal(result.code, 1, result.text);
    assert.match(result.text, /诊断轨里没有这个 runId/);
  });
});

test("方向二（审计缺）：诊断有完整的一轮 apply、审计 0 行 → 红，并点名方向与入口", () => {
  withDir((dir) => {
    // 审计文件里放另一轮，让这份文件本身合法（没有断号、没有截断）。
    const other = "apply-20261025T170000Z-bbbb";
    const audit = writeJsonl(join(dir, "2026-10-25.jsonl"), [
      ...closedRun(other, "2026-10-25T17:00:00.000+08:00"),
    ]);
    const diag = writeJsonl(join(dir, "diag.jsonl"), [
      ...diagRows(other, "http", "2026-10-25T17:00:00.000+08:00"),
      ...diagRows(RUN, "cli"),
    ]);
    const result = runAudit(["check", "--jsonl", audit, "--diag", diag]);
    assert.equal(result.code, 1, result.text);
    assert.match(result.text, /诊断有、审计缺/, "必须点名方向，否则读者不知道该补哪一轨");
    assert.ok(result.text.includes(RUN), "必须点名是哪一轮");
    assert.match(result.text, /entry=cli/);
  });
});

test("反向不判红的边界：entry 属于不写审计的五个入口 → 只记信息项", () => {
  withDir((dir) => {
    const audit = writeJsonl(join(dir, "2026-10-25.jsonl"), closedRun());
    const diag = writeJsonl(join(dir, "diag.jsonl"), [
      ...diagRows(RUN, "http"),
      ...diagRows("apply-20261025T190000Z-cccc", "startup-auto", "2026-10-25T19:00:00.000+08:00"),
    ]);
    const result = runAudit(["check", "--jsonl", audit, "--diag", diag]);
    assert.equal(result.code, 0, result.text);
    assert.match(result.text, /这个入口不写审计轨/);
  });
});

test("反向不判红的边界：上一代（结束事件上没有 runEnd）→ 只记「无法判定」，不判审计缺", () => {
  // CLI 落审计比第一个结束章早了几个小时：那一代本来就没有「一轮结束要写审计」的约定，
  // 拿今天的入口表去判它，会把健康机器的历史轮全判成「审计缺」。
  withDir((dir) => {
    const old = "apply-20261025T090000Z-eeee";
    const audit = writeJsonl(join(dir, "2026-10-25.jsonl"), closedRun());
    const diag = writeJsonl(join(dir, "diag.jsonl"), [
      ...diagRows(RUN, "http"),
      ...legacyDiagRows(old, "cli", "2026-10-25T09:00:00.000+08:00"),
    ]);
    const result = runAudit(["check", "--jsonl", audit, "--diag", diag]);
    assert.equal(result.code, 0, `上一代不判红：\n${result.text}`);
    assert.match(result.text, /上一代（无 runEnd）：无法判定当时是否该写审计/);
    assert.ok(!result.text.includes("诊断有、审计缺"), "上一代不许报成「审计缺」");
  });
});

test("反向不判红的边界：没有逐补丁判定（aborted / 0 补丁）→ 只记信息项，不判审计缺", () => {
  // 真机形态（b970）：apply.start / apply.hosts / apply.end 都发了、结束事件也盖了章，
  // 却一条 apply.patch 都没有（一台宿主都没找到、门禁拒绝、过滤后 0 条）。
  // 报告为空 → 不落审计是设计边界；拿「审计 0 行」当缺记录，会把 aborted 的轮判成丢账。
  const aborted = runAudit([
    "check",
    "--dir", join(FIXTURES, "aborted-dir"),
    "--diag", join(FIXTURES, "aborted-v3.diag.jsonl"),
    "--json",
  ]);
  assert.equal(aborted.code, 0, `没有逐补丁判定的轮不该判红：\n${aborted.text}`);
  const report = JSON.parse(aborted.out.join("\n"));
  assert.equal(report.cross.missingAudit, 0, "没有逐补丁判定的轮不进 missingAudit");
  assert.ok(
    report.cross.orderNotes.some((line) => line.includes("没有逐补丁判定")),
    `没把「没有可落账的判定」记成信息项：\n${report.cross.orderNotes.join("\n")}`,
  );

  // 同一份诊断轨里带 apply.patch 的轮仍必须红：这条边界只放行「0 条」的轮。
  const withPatches = runAudit([
    "check",
    "--dir", join(FIXTURES, "v3-cli-dir"),
    "--diag", join(FIXTURES, "v3-cli.diag.jsonl"),
    "--json",
  ]);
  assert.equal(withPatches.code, 1, withPatches.text);
  assert.equal(JSON.parse(withPatches.out.join("\n")).cross.missingAudit, 1);
});

test("诊断轨滚过：早于诊断轨第一行的轮次记为「不可判」，不判红", () => {
  withDir((dir) => {
    const oldTs = "2026-10-20T10:00:00.000+08:00";
    const audit = writeJsonl(join(dir, "2026-10-25.jsonl"), closedRun(RUN, oldTs));
    // 诊断轨只留一代：现存的都是 10-25 的行，10-20 那一轮不可能还在里面。
    const diag = writeJsonl(join(dir, "diag.jsonl"), [
      { ts: "2026-10-25T10:00:00.000Z", event: "startup.ready", version: "2.0.0" },
    ]);
    const result = runAudit(["check", "--jsonl", audit, "--diag", diag]);
    assert.equal(result.code, 0, `健康机器上诊断轨滚过不该判红：\n${result.text}`);
    assert.match(result.text, /不可判/);
    assert.match(result.text, /不是日志残缺/);
  });
});

test("check --run 只评那一轮：别的轮本来就在审计轨里，不许被报成「审计缺」", () => {
  // 这条守的是反向判据的口径：拿「筛过之后的那份审计行」去判「谁缺」，
  // 会把没被筛中的轮全报成缺的 —— 那是把参数当证据。
  withDir((dir) => {
    const present = "apply-20261025T170000Z-bbbb";
    const missing = "apply-20261025T180000Z-cccc";
    const audit = writeJsonl(join(dir, "2026-10-25.jsonl"), [
      ...closedRun(present, "2026-10-25T17:00:00.000+08:00"),
    ]);
    const diag = writeJsonl(join(dir, "diag.jsonl"), [
      ...diagRows(present, "http", "2026-10-25T17:00:00.000+08:00"),
      ...diagRows(missing, "cli"),
    ]);

    const only = runAudit(["check", "--jsonl", audit, "--run", missing, "--diag", diag]);
    assert.equal(only.code, 1, only.text);
    assert.ok(only.text.includes(missing), "要点名缺的那一轮");
    assert.equal(only.text.includes(present), false, "别的轮不该出现在单轮模式的结论里");

    const healthy = runAudit(["check", "--jsonl", audit, "--run", present, "--diag", diag]);
    assert.equal(healthy.code, 0, `这一轮本来就齐全：\n${healthy.text}`);
  });
});

test("check --run：这一轮在审计轨里 → exit 0；只在诊断轨里 → exit 1 并指出方向", () => {
  withDir((dir) => {
    const audit = writeJsonl(join(dir, "2026-10-25.jsonl"), closedRun());
    const diag = writeJsonl(join(dir, "diag.jsonl"), diagRows(RUN, "cli"));

    const present = runAudit(["check", "--jsonl", audit, "--run", RUN, "--diag", diag]);
    assert.equal(present.code, 0, present.text);
    assert.match(present.text, /审计轨有这一轮/);

    const onlyDiag = runAudit(["check", "--jsonl", audit, "--run", "apply-20261025T200000Z-dddd", "--diag", diag]);
    // 这一轮在两轨都没有 → 仍然红，而且不是用法错误。
    assert.equal(onlyDiag.code, 1, onlyDiag.text);
    assert.match(onlyDiag.text, /审计轨没有这一轮/);
  });
});

test("check --run 不再是用法错误：旧实现只认五个参数，--run 会 exit 2", () => {
  withDir((dir) => {
    const audit = writeJsonl(join(dir, "2026-10-25.jsonl"), closedRun());
    const result = runAudit(["check", "--jsonl", audit, "--run", RUN]);
    assert.notEqual(result.code, 2, `--run 必须被认，实测 ecit 2：\n${result.text}`);
  });
});

test("少一条补丁行：红，并且点名缺的是哪个 patchId", () => {
  withDir((dir) => {
    // code 层的 46 号补丁文件行被删掉：结论仍然声称折过它（considered 里有 46）。
    const rows = closedRun().filter((row) => !(row.seq === 2));
    const audit = writeJsonl(join(dir, "2026-10-25.jsonl"), rows);
    const result = runAudit(["check", "--jsonl", audit]);
    assert.equal(result.code, 1, result.text);
    assert.match(result.text, /detail\.considered 列了补丁 46/);
    assert.match(result.text, /记录缺了/);
  });
});

test("声称记全但摘要其实缺了：红，并点名缺在哪个补丁的行上", () => {
  withDir((dir) => {
    const rows = closedRun();
    // code 层那一行的 after 摘要被抹掉（读不到那个文件），但结论仍声称 files 为真。
    delete rows[2].evidence.after;
    const audit = writeJsonl(join(dir, "2026-10-25.jsonl"), rows);
    const result = runAudit(["check", "--jsonl", audit]);
    assert.equal(result.code, 1, result.text);
    assert.match(result.text, /completeness\.files 声称记全了/);
    assert.match(result.text, /摘要缺在补丁 46 的行上/);
  });
});

test("声称记不全但其实全齐：同样红（另一个方向也不许放过）", () => {
  withDir((dir) => {
    const rows = closedRun();
    rows[3].detail.completeness = { patches: true, files: false, layers: true };
    const audit = writeJsonl(join(dir, "2026-10-25.jsonl"), rows);
    const result = runAudit(["check", "--jsonl", audit]);
    assert.equal(result.code, 1, result.text);
    assert.match(result.text, /completeness\.files 记成假/);
  });
});

test("partial 的来路写错：红（层内部分成功被写成记录缺口，或反过来）", () => {
  withDir((dir) => {
    const rows = closedRun();
    // prompt 层：applied=1 / skipped=1、三项全真 ⇒ 来路应是 layer。这里改成 record。
    rows[1].result = "partial";
    rows[1].detail.applied = 1;
    rows[1].detail.skipped = 0;
    rows[1].detail.completeness = { patches: true, files: true, layers: true };
    rows[1].detail.partialReason = "record";
    const audit = writeJsonl(join(dir, "2026-10-25.jsonl"), rows);
    const result = runAudit(["check", "--jsonl", audit]);
    assert.equal(result.code, 1, result.text);
    assert.match(result.text, /partialReason=record/);
    assert.match(result.text, /应是 layer/);
  });
});

test("版本账本与 apply 轮对得上：applied.json 里写着这一轮的 runId 与审计摘要", () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-purge-stamp-"));
  const previous = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = home;
    const runId = "apply-20261025T210000Z-eeee";
    // 写戳与并摘要分两步：戳在 apply 收尾时写，那时还拿不到 after 摘要。
    reapply.markPatchesApplied(undefined, { runId });
    const stampPath = join(home, "dsh-purge", "applied.json");
    const written = JSON.parse(readFileSync(stampPath, "utf8"));
    assert.equal(written.run_id, runId, "版本账本里没有这一轮的身份，「最后一次成功 apply 是哪一次」就答不出");

    const merged = reapply.noteAppliedAudit({
      runId,
      events: 6,
      layers: { prompt: { result: "ok" }, code: { result: "partial" }, tool: { result: "ok" } },
      unresolved: [],
    });
    assert.equal(merged, true, "并摘要失败：读者看不到这一轮记全了没有");
    const after = JSON.parse(readFileSync(stampPath, "utf8"));
    assert.deepEqual(after.audit.layers, { prompt: "ok", code: "partial", tool: "ok" });
    assert.equal(after.audit.events, 6);
    assert.equal(after.version, written.version, "并摘要不许改动 version / sha —— 那两个字段在对齐判据里");
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("模拟重启：启动路径刷戳只换 version / sha / at，run_id 与 audit 摘要沿用旧戳", () => {
  // 真机形态：apply 写完戳与摘要，重启时 settle / reapply 又刷一次戳（不带 runId）。
  // 刷戳若把 whole 文件重写成四字段，`startup.ready.appliedRunId` 下次启动就读成空，
  // 「戳里带审计摘要」也只在两次启动之间成立。
  const home = mkdtempSync(join(tmpdir(), "dsh-purge-stamp-"));
  const previous = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = home;
    const runId = "apply-20261025T220000Z-1a2b";
    const stampPath = join(home, "dsh-purge", "applied.json");
    reapply.markPatchesApplied(undefined, { runId });
    assert.equal(
      reapply.noteAppliedAudit({
        runId,
        events: 6,
        layers: { prompt: { result: "ok" }, code: { result: "ok" }, tool: { result: "ok" } },
        unresolved: [],
      }),
      true,
    );
    const before = JSON.parse(readFileSync(stampPath, "utf8"));

    // 模拟下一次启动：这条路径拿不到入口身份，所以不带 runId。
    reapply.markPatchesApplied();
    const after = JSON.parse(readFileSync(stampPath, "utf8"));
    assert.equal(after.run_id, runId, "重启后 run_id 丢了：appliedRunId 会读成空");
    assert.deepEqual(after.audit, before.audit, "重启后 audit 摘要被刷掉了");
    assert.equal(after.audit.events, 6);
    assert.ok(after.at >= before.at, "刷戳不再更新时间了？");
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
