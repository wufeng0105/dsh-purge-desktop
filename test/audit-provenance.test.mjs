/**
 * test/audit-provenance.test.mjs — 每条审计行必须自己认出来源，而且不靠另一份文件。
 *
 * 为什么单独立一份：`actor` 曾恒为 `host`、审计行顶层没有 `entry`，于是四个触发入口
 * 在审计轨上完全不可区分；而「哪个入口」只能去诊断轨找 —— 诊断轨只留一代，滚掉之后
 * 这个问题就永久答不出来了，那是时间不可逆的损失。
 *
 * 判据分两层：
 *   一、写侧：四条入口各写一轮，`entry` 两两不同、`actor` 按写入方取值；
 *   二、读侧：**把诊断轨整个删掉**，只读审计文件仍然答得出这四轮各是谁触发的。
 * 另加三条：`recordApply` 回 `runId`、成功侧有 `audit.recorded`、`partialReason` 的形状判据。
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fileDigest, readEvents, recordApplyRun, resolveAuditDir, validateEvent } from "../lib/audit/index.js";
import { diagLogPath } from "../lib/diag-log.js";

/** 四个 apply 入口。前三个在宿主进程里写，`cli` 是命令行进程自己写。 */
const ENTRIES = ["http", "command", "tool", "cli"];

function makeTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 一个真实落点 + 一条补丁，足以写出一批完整的三层事件。 */
function hostFixture(host) {
  const files = {};
  for (const key of ["ka", "kb", "kc"]) {
    const file = path.join(host, `${key}.js`);
    fs.writeFileSync(file, "MK\n");
    files[key] = file;
  }
  const patches = [
    { id: 1, name: "PROMPT_ONE", layer: "提示词", marker: "MK", file: "ka" },
    { id: 2, name: "CODE_ONE", layer: "代码", marker: "MK", file: "kb" },
    { id: 3, name: "TOOL_ONE", layer: "工具", marker: "MK", file: "kc" },
  ];
  return {
    patches,
    targets: files,
    report: patches.map((patch) => ({ patch_id: patch.id, status: "applied" })),
  };
}

function readLines(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

test("四个入口各写一轮：entry 两两不同，actor 按写入方取值", () => {
  const home = makeTemp("dsh-purge-prov-home-");
  const host = makeTemp("dsh-purge-prov-host-");
  try {
    const fixture = hostFixture(host);
    for (const [index, entry] of ENTRIES.entries()) {
      recordApplyRun({
        dshHome: home,
        report: fixture.report,
        patches: fixture.patches,
        targets: fixture.targets,
        before: {},
        runId: `apply-20260101T00000${index}Z-000${index}`,
        entry,
      });
    }
    const events = readEvents(home);
    const byRun = new Map();
    for (const event of events) {
      if (!byRun.has(event.runId)) byRun.set(event.runId, []);
      byRun.get(event.runId).push(event);
    }
    assert.equal(byRun.size, 4, "四条入口各一轮");
    const seen = [];
    for (const [, rows] of byRun) {
      const entries = [...new Set(rows.map((row) => row.entry))];
      const actors = [...new Set(rows.map((row) => row.actor))];
      assert.equal(entries.length, 1, "同一轮里每一行的 entry 必须一致");
      assert.equal(actors.length, 1, "同一轮里每一行的 actor 必须一致");
      seen.push(entries[0]);
    }
    assert.deepEqual(seen.sort(), [...ENTRIES].sort(), "四个入口必须在审计轨上两两可区分");
    // actor 不是恒为 host：CLI 那一轮是命令行进程自己写的。
    const cli = [...byRun.values()].find((rows) => rows[0].entry === "cli");
    assert.ok(cli.every((row) => row.actor === "cli"), "entry=cli 的行 actor 必须是 cli");
    const http = [...byRun.values()].find((rows) => rows[0].entry === "http");
    assert.ok(http.every((row) => row.actor === "host"), "宿主进程里的入口 actor 是 host");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(host, { recursive: true, force: true });
  }
});

test("诊断轨整个没了，只读审计文件仍答得出每一轮是谁触发的", () => {
  const home = makeTemp("dsh-purge-prov-home-");
  const host = makeTemp("dsh-purge-prov-host-");
  try {
    const fixture = hostFixture(host);
    for (const [index, entry] of ENTRIES.entries()) {
      recordApplyRun({
        dshHome: home,
        report: fixture.report,
        patches: fixture.patches,
        targets: fixture.targets,
        before: {},
        runId: `apply-20260102T00000${index}Z-000${index}`,
        entry,
      });
    }
    // 诊断轨只留一代：这里直接把它删掉，模拟「已经滚没了」的那一刻。
    const diag = diagLogPath(home);
    if (fs.existsSync(diag)) fs.rmSync(diag, { force: true });
    assert.equal(fs.existsSync(diag), false, "这一条的前提是诊断轨不存在");

    const sources = readEvents(home)
      .filter((event) => typeof event.entry === "string")
      .map((event) => event.entry);
    assert.deepEqual([...new Set(sources)].sort(), [...ENTRIES].sort(),
      "诊断轨没了之后，来源只能从审计行自己读出来 —— 这正是 entry 存在的理由");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(host, { recursive: true, force: true });
  }
});

test("recordApply 回 runId：调用方写完就知道这一轮叫什么", () => {
  const home = makeTemp("dsh-purge-prov-home-");
  const host = makeTemp("dsh-purge-prov-host-");
  try {
    const fixture = hostFixture(host);
    const given = "apply-20260103T000000Z-1234";
    const withGiven = recordApplyRun({
      dshHome: home,
      report: fixture.report,
      patches: fixture.patches,
      targets: fixture.targets,
      before: {},
      runId: given,
      entry: "http",
    });
    assert.equal(withGiven.record.runId, given, "给了 runId 就沿用它，并回给调用方");

    const selfRun = recordApplyRun({
      dshHome: home,
      report: fixture.report,
      patches: fixture.patches,
      targets: fixture.targets,
      before: {},
      entry: "http",
    });
    assert.match(selfRun.record.runId, /^apply-\d{8}T\d{6}Z-[0-9a-f]{4}$/, "没给就自己生成同形状的值");
    assert.ok(readEvents(home).every((event) => typeof event.runId === "string"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(host, { recursive: true, force: true });
  }
});

test("成功侧也留痕：audit.recorded 带着 runId 与三层结论", () => {
  const home = makeTemp("dsh-purge-prov-home-");
  const host = makeTemp("dsh-purge-prov-host-");
  try {
    const fixture = hostFixture(host);
    const runId = "apply-20260104T000000Z-5678";
    recordApplyRun({
      dshHome: home,
      report: fixture.report,
      patches: fixture.patches,
      targets: fixture.targets,
      before: {},
      runId,
      entry: "command",
    });
    const rows = readLines(diagLogPath(home));
    const recorded = rows.find((row) => row.event === "audit.recorded");
    assert.ok(recorded, `诊断轨里没有 audit.recorded：${rows.map((row) => row.event).join(", ")}`);
    assert.equal(recorded.runId, runId);
    assert.equal(recorded.entry, "command");
    assert.equal(recorded.events, "6", "三条补丁各一个落点 = 三条文件事件，加三条层结论");
    for (const layer of ["prompt", "code", "tool"]) {
      assert.ok(String(recorded.layers).includes(`${layer}:`), `三层结论都要写在成功侧那一行上（缺 ${layer}）`);
    }
    assert.equal(rows.some((row) => row.event === "apply.audit.fail"), false, "成功的一轮不该有失败事件");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(host, { recursive: true, force: true });
  }
});

test("partialReason 的形状判据：只许 layer / record，且只许跟着 result=partial", () => {
  const home = makeTemp("dsh-purge-prov-home-");
  const host = makeTemp("dsh-purge-prov-host-");
  try {
    const files = {};
    for (const key of ["ka", "kb", "kc"]) {
      const file = path.join(host, `${key}.js`);
      fs.writeFileSync(file, "MK\n");
      files[key] = file;
    }
    // 三层都要在，layers 布尔才可能为真；code 层里一条 applied + 一条 already，才落 partial。
    const patches = [
      { id: 1, name: "PROMPT_ONE", layer: "提示词", marker: "MK", file: "ka" },
      { id: 2, name: "CODE_APPLIED", layer: "代码", marker: "MK", file: "kb" },
      { id: 3, name: "CODE_ALREADY", layer: "代码", marker: "MK", file: "kb" },
      { id: 4, name: "TOOL_ONE", layer: "工具", marker: "MK", file: "kc" },
    ];
    const statusById = { 1: "applied", 2: "applied", 3: "already", 4: "applied" };
    recordApplyRun({
      dshHome: home,
      report: patches.map((patch) => ({ patch_id: patch.id, status: statusById[patch.id] })),
      patches,
      targets: files,
      // 摘要齐全，三项才可能全真；before 空表会把 files 记成假，这一条就测不到 layer 来路。
      before: Object.fromEntries(Object.values(files).map((file) => [file, fileDigest(file)])),
      runId: "apply-20260105T000000Z-9999",
      entry: "tool",
    });
    const [conclusion] = readEvents(home).filter((event) => event.event === "code.apply-result");
    assert.ok(conclusion, "这一层应当写出一条结论");
    assert.equal(conclusion.result, "partial", "一条 applied + 一条已是最新 ⇒ 层内部分成功");
    assert.deepEqual(conclusion.detail.completeness, { patches: true, files: true, layers: true });
    assert.equal(conclusion.detail.partialReason, "layer", "三项全真时 partial 的来路是层内部分成功");

    // 形状判据只管写侧：把来路安在非 partial 的结论上，落盘前就被拦下。
    assert.throws(
      () => validateEvent({
        ts: "2026-10-24T12:00:00+08:00",
        seq: 1,
        recordId: "b41f0c7e-9a52-4f13-8a6e-2d7c1e5b9f04",
        runId: "apply-20260105T000000Z-9999",
        event: "code.apply-result",
        result: "ok",
        layer: "code",
        evidence: { refSeq: 0 },
        detail: { completeness: { patches: true, files: true, layers: true }, partialReason: "layer" },
      }),
      /partialReason/,
      "result 不是 partial 时写来路会被读成「这条 partial」",
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(host, { recursive: true, force: true });
  }
});

test("接线结构：四个入口的 entry 字面量与 withApplyRun 声明的是同一批值", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const source = fs.readFileSync(path.join(root, "lib", "index.js"), "utf8");
  for (const entry of ["command", "tool", "http"]) {
    assert.ok(
      source.includes(`{ entry: "${entry}", runId:`),
      `${entry} 入口的 withApplyRun 没有声明身份`,
    );
    // 落账那一侧必须写同一个字面量：两处各写一个值也能跑，但审计轨就会说错入口。
    const block = new RegExp(`auditApplyEntry\\(\\{[\\s\\S]{0,400}?entry: "${entry}"`, "m");
    assert.match(source, block, `${entry} 入口的落账没有把 entry 传下去`);
  }
  const bin = fs.readFileSync(path.join(root, "bin", "dsh-purge.js"), "utf8");
  assert.ok(bin.includes('entry: "cli"'), "CLI 落账没有声明 entry=cli");
  // HTTP 响应体里必须有这一轮的名字，否则调用方写完只能自己去日志里找。
  assert.ok(source.includes("run_id: httpRunId"), "HTTP apply 响应里没有 run_id");
});
