/**
 * test/audit-maintenance.test.mjs — 维护动作必须留痕：清了什么、代数顶没顶到上限。
 *
 * 为什么单独立一份：`prune` 一直在删文件，但删了什么从来没有人写得下来 ——
 * 「日志为什么变短了」只能靠猜。轮转号原先也没有上界，一个整天被反复写就等于
 * 无上限地造文件，同样没有一行日志说过它顶到了哪。
 *
 * 另外两条同在这份用例里：`audit why` 必须连诊断轨的 `.1` 一起读（否则刚滚掉的
 * 那一轮会被报成「查无此轮」），以及 `--dir --diag` 在健康机器上不许假红。
 *
 * 上限那一档用稀疏文件造：`truncateSync` 只改文件长度，不真写 240 MB 字节。
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { appendEvent, readEvents, resolveAuditDir, runAuditCli, runAuditQuery } from "../lib/audit/index.js";
import { MAX_FILE_BYTES } from "../lib/audit/index.js";
import { diagLogPath } from "../lib/diag-log.js";

const DAY = "2026-10-26";
const OLD_DAY = "2026-09-01";

function makeTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readLines(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/** 一条最小合法事件：维护判据只看落点与文件，不看内容。 */
function probeEvent() {
  return {
    event: "code.probe",
    result: "ok",
    evidence: { file: "app.js", marker: "M", hits: 1, bytes: 10 },
  };
}

test("保留期清理留一条 prune.removed：删了哪些文件写在日志里", () => {
  const home = makeTemp("dsh-purge-maint-home-");
  try {
    const dir = resolveAuditDir(home);
    fs.mkdirSync(dir, { recursive: true });
    // 30 天前的文件：清理边界之外，必须被删掉。
    const stale = path.join(dir, `${OLD_DAY}.jsonl`);
    fs.writeFileSync(stale, `${JSON.stringify({
      ts: "2026-09-01T10:00:00+08:00",
      seq: 0,
      event: "code.probe",
      result: "ok",
      evidence: { file: "app.js", marker: "M", hits: 1, bytes: 10 },
    })}\n`, "utf8");

    appendEvent(home, probeEvent(), { now: new Date("2026-10-26T10:00:00+08:00") });
    assert.equal(fs.existsSync(stale), false, "超过保留期的文件应当被删掉");

    const rows = readLines(diagLogPath(home));
    const pruned = rows.find((row) => row.event === "prune.removed");
    assert.ok(pruned, `诊断轨里没有 prune.removed：${rows.map((row) => row.event).join(", ")}`);
    assert.equal(pruned.removed, "1");
    assert.ok(String(pruned.names).includes(`${OLD_DAY}.jsonl`), "删了哪个文件必须点名");
    assert.equal(pruned.retainDays, "30");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("单日代数有上限：24 代都写满之后继续写最后一代，并留一条 prune.capped", () => {
  const home = makeTemp("dsh-purge-maint-home-");
  try {
    const dir = resolveAuditDir(home);
    fs.mkdirSync(dir, { recursive: true });
    // 主文件 + 23 个轮转号全写到上限：稀疏文件，不真占磁盘。
    for (let rotation = 0; rotation <= 23; rotation += 1) {
      const name = rotation === 0 ? `${DAY}.jsonl` : `${DAY}.${rotation}.jsonl`;
      fs.writeFileSync(path.join(dir, name), "");
      fs.truncateSync(path.join(dir, name), MAX_FILE_BYTES);
    }

    const written = appendEvent(home, probeEvent(), { now: new Date("2026-10-26T10:00:00+08:00") });
    assert.equal(typeof written.seq, "number", "顶到上限之后仍然要写得进去（不丢行）");
    assert.equal(
      fs.existsSync(path.join(dir, `${DAY}.23.jsonl`)),
      true,
      "顶到上限后落在最后一代",
    );

    const names = fs.readdirSync(dir).filter((name) => name.startsWith(DAY)).sort();
    assert.equal(names.length, 24, `代数必须有上界，实测 ${names.length} 个文件`);
    const capped = readLines(diagLogPath(home)).find((row) => row.event === "prune.capped");
    assert.ok(capped, "顶到上限这件事必须留痕，否则读者只会看到「日志都在这一个文件里」");
    assert.equal(capped.file, `${DAY}.23.jsonl`, "顶到上限后继续写最后一代，不丢行");
    assert.equal(capped.generations, "24");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("audit why 连 diag 的 .1 一起读：刚被滚掉的那一轮不算查无此轮", () => {
  const home = makeTemp("dsh-purge-maint-home-");
  try {
    const dir = resolveAuditDir(home);
    fs.mkdirSync(dir, { recursive: true });
    const runId = "apply-20261026T100000Z-aaaa";
    const rows = [
      { ts: "2026-10-26T10:00:00.000+08:00", seq: 0, recordId: "b41f0c7e-9a52-4f13-8a6e-2d7c1e5b9f04", runId, observedTs: "2026-10-26T10:00:00.000+08:00", event: "code.patch-applied", result: "ok", layer: "code", actor: "host", entry: "http", target: "P", evidence: { file: "app.js", marker: "M", hits: 1, bytes: 10 }, detail: { patchId: 1, status: "applied" } },
      { ts: "2026-10-26T10:00:01.000+08:00", seq: 1, recordId: "c52f1d8e-8b63-4a24-9f7d-3e8c6b5a4d32", runId, observedTs: "2026-10-26T10:00:00.000+08:00", event: "code.apply-result", result: "ok", layer: "code", actor: "host", entry: "http", target: "code", evidence: { refSeq: 0, quote: "code.patch-applied" }, detail: { applied: 1, failed: 0, skipped: 0, unresolved: [], exempt: [], completeness: { patches: true, files: true, layers: false }, considered: [1], expectedRows: 1, runEnd: true } },
    ];
    fs.writeFileSync(path.join(dir, `${DAY}.jsonl`), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");

    // 诊断轨的那一轮已经被滚到 `.1`，主文件里只剩更新的行。
    const diagFile = diagLogPath(home);
    fs.mkdirSync(path.dirname(diagFile), { recursive: true });
    fs.writeFileSync(`${diagFile}.1`, `${JSON.stringify({ ts: "2026-10-26T02:00:00.000Z", event: "apply.start", entry: "http", runId })}\n`, "utf8");
    fs.writeFileSync(diagFile, `${JSON.stringify({ ts: "2026-10-26T03:00:00.000Z", event: "cli.invoke", mode: "status" })}\n`, "utf8");

    const out = [];
    const code = runAuditQuery(["why", runId], { out: (line) => out.push(line), err: (line) => out.push(line) }, { dshHome: home });
    assert.equal(code, 0, out.join("\n"));
    const text = out.join("\n");
    assert.ok(text.includes("event=apply.start"), `诊断轨的 .1 没有被读到：\n${text}`);
    // 报的是**文件份数**（含主文件），不是写侧那个「代数」—— 两者差 1，早先混成一个词，
    // 读的人据此以为日志没滚过。口径写在全句里，别只留一个数字。
    assert.match(text, /读到 2 份文件（含主文件）/s, "读到了几份文件必须说出来，否则读者不知道自己去哪里找");
    assert.match(text, /有滚过的旧代/, "读到旧代这件事要显式说出来");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("--dir --diag 在健康机器上 exit 0：诊断轨滚过的那一轮只记信息项", () => {
  const home = makeTemp("dsh-purge-maint-home-");
  try {
    const dir = resolveAuditDir(home);
    fs.mkdirSync(dir, { recursive: true });
    const build = (runId, ts, seqBase) => ([
      { ts, seq: seqBase, recordId: `${runId.slice(-4)}0000-0000-4000-8000-000000000001`, runId, observedTs: ts, event: "prompt.patch-applied", result: "ok", layer: "prompt", actor: "host", entry: "http", target: "P", evidence: { file: "a.js", marker: "M", hits: 1, bytes: 10, before: { sha256: "a".repeat(64), bytes: 10 }, after: { sha256: "a".repeat(64), bytes: 10 } }, detail: { patchId: 1, status: "applied" } },
      { ts, seq: seqBase + 1, recordId: `${runId.slice(-4)}0000-0000-4000-8000-000000000002`, runId, observedTs: ts, event: "prompt.apply-result", result: "ok", layer: "prompt", actor: "host", entry: "http", target: "prompt", evidence: { refSeq: seqBase, quote: "prompt.patch-applied" }, detail: { applied: 1, failed: 0, skipped: 0, unresolved: [], exempt: [], completeness: { patches: true, files: true, layers: false }, considered: [1], expectedRows: 1, runEnd: true } },
    ]);
    // 旧的一天：诊断轨里早已不存在，只能是「不可判」。
    fs.writeFileSync(path.join(dir, "2026-09-20.jsonl"), `${build("apply-20260920T100000Z-aaaa", "2026-09-20T10:00:00.000+08:00", 0).map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
    // 现役的一天：诊断轨里那一轮完整。
    const runId = "apply-20261026T100000Z-bbbb";
    fs.writeFileSync(path.join(dir, `${DAY}.jsonl`), `${build(runId, "2026-10-26T10:00:00.000+08:00", 0).map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");

    const diag = path.join(home, "diag.jsonl");
    const diagRows = [
      { ts: "2026-10-26T02:00:00.000Z", event: "apply.start", entry: "http", runId },
      { ts: "2026-10-26T02:00:01.000Z", event: "apply.patch", entry: "http", runId, id: "1", status: "applied" },
      { ts: "2026-10-26T02:00:02.000Z", event: "apply.end", entry: "http", runId, applied: "1", failed: "0" },
    ];
    fs.writeFileSync(diag, `${diagRows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");

    const out = [];
    const err = [];
    const code = runAuditCli(["check", "--dir", dir, "--diag", diag], { out: (line) => out.push(line), err: (line) => err.push(line) });
    const text = `${out.join("\n")}\n${err.join("\n")}`;
    assert.equal(code, 0, `健康机器上不该判红：\n${text}`);
    assert.match(text, /不可判/, "滚过的那一轮必须作为信息项说出来，不许静默");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
