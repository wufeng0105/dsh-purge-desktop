/**
 * test/audit-query.test.mjs — audit tail / audit why 的 CLI 面：有结果、查无此轮、用法错误三档。
 *
 * 为什么存在：tail / why 此前只有 HTTP 路由消费，而「日志残缺」正是宿主起不来的那一刻
 * 最需要查的东西。这份用例把三条出口判死：退出码 0 必须真打印了两轨，1 只用于
 * 「查无此 runId」，2 只用于用法/环境错误 —— 2 不许被当成通过。
 *
 * `--status` 那一组守的是读法：它筛的是 detail.status，只存在于文件层行；筛完为空
 * 与「一条都没有」同档退 1，值拼错也走这一档 —— 否则打字错一处就长得像「没结果」。
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { recordApplyRun, runAuditQuery } from "../lib/audit/index.js";

const ROOT = path.resolve(import.meta.dirname, "..");

function makeTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function collect(argv, home) {
  const out = [];
  const err = [];
  const code = runAuditQuery(argv, { out: (line) => out.push(line), err: (line) => err.push(line) }, { dshHome: home });
  return { code, out, err };
}

/** 只取逐行的审计行（表头那行不算），用来数「打出来几条」。 */
function rowsOf(result) {
  return result.out.filter((line) => line.trim().startsWith("seq="));
}

/** 一份三层齐全的审计轨 + 同一 runId 的诊断轨窗口。 */
function fixture() {
  const home = makeTemp("dsh-purge-query-home-");
  const host = makeTemp("dsh-purge-query-host-");
  const a = path.join(host, "a.js");
  const b = path.join(host, "b.js");
  fs.writeFileSync(a, "MK_A\n");
  fs.writeFileSync(b, "MK_B\n");
  const patches = [
    { id: 1, name: "PROMPT", layer: "提示词", marker: "MK_A", file: "ka" },
    { id: 2, name: "CODE", layer: "代码", marker: "MK_B", file: "kb" },
    { id: 3, name: "TOOL", layer: "工具", marker: "MK_B", file: "kb" },
  ];
  const runId = "apply-20260101T000000Z-77aa";
  recordApplyRun({
    dshHome: home,
    report: patches.map((patch) => ({ patch_id: patch.id, status: "applied" })),
    patches,
    targets: { ka: a, kb: b },
    before: { [a]: null, [b]: null },
    runId,
  });
  const diagFile = path.join(home, "dsh-purge", "logs", "diag.jsonl");
  fs.mkdirSync(path.dirname(diagFile), { recursive: true });
  const rows = [
    { ts: "2026-01-01T00:00:00.000Z", event: "apply.start", patches: "3", selected: "3", entry: "cli", runId },
    { ts: "2026-01-01T00:00:01.000Z", event: "apply.patch", id: "1", status: "applied", entry: "cli", runId },
    { ts: "2026-01-01T00:00:02.000Z", event: "apply.patch", id: "2", status: "applied", entry: "cli", runId },
    { ts: "2026-01-01T00:00:03.000Z", event: "apply.patch", id: "3", status: "applied", entry: "cli", runId },
    { ts: "2026-01-01T00:00:04.000Z", event: "apply.end", applied: "3", failed: "0", pendingRestart: "true", entry: "cli", runId },
  ];
  fs.writeFileSync(diagFile, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return { home, host, runId };
}

/**
 * 一轮里五种状态各一条的审计轨：`--status` 的命中面与「结论行不出现」都靠它判。
 *
 * 层结论行由 recordApplyRun 自己写，detail 里是 applied / failed / skipped 计数；
 * 它们没有 status 字段 —— 带 --status 时必然不出现，这是要写进用例的边界。
 */
function statusFixture() {
  const home = makeTemp("dsh-purge-query-status-home-");
  const host = makeTemp("dsh-purge-query-status-host-");
  const a = path.join(host, "a.js");
  const b = path.join(host, "b.js");
  fs.writeFileSync(a, "MK_A\n");
  fs.writeFileSync(b, "MK_B\n");
  const patches = [
    { id: 11, name: "PROMPT_APPLIED", layer: "提示词", marker: "MK_A", file: "ka" },
    { id: 12, name: "CODE_SKIPPED", layer: "代码", marker: "MK_B", file: "kb" },
    { id: 13, name: "CODE_MISS", layer: "代码", marker: "MK_B", file: "kb" },
    { id: 14, name: "CODE_WRITE_ERROR", layer: "代码", marker: "MK_B", file: "kb" },
    { id: 15, name: "TOOL_READ_ERROR", layer: "工具", marker: "MK_B", file: "kb" },
    { id: 16, name: "TOOL_MISSING", layer: "工具", marker: "MK_B", file: "kb" },
  ];
  const statusById = {
    11: "applied",
    12: "skipped",
    13: "pattern_not_found",
    14: "write_error:EPERM: operation not permitted, open 'kb'",
    15: "read_error",
    16: "missing_file",
  };
  const runId = "apply-20260102T000000Z-88bb";
  recordApplyRun({
    dshHome: home,
    report: patches.map((patch) => ({ patch_id: patch.id, status: statusById[patch.id] })),
    patches,
    targets: { ka: a, kb: b },
    before: { [a]: null, [b]: null },
    runId,
  });
  return { home, host, runId };
}

test("why <runId>：打印审计行与诊断轨窗口，两轨一致时退出码 0", () => {
  const { home, host, runId } = fixture();
  try {
    const { code, out } = collect(["why", runId], home);
    assert.equal(code, 0);
    const text = out.join("\n");
    assert.ok(text.includes(runId));
    assert.ok(text.includes("prompt.patch-applied"), "缺审计轨行");
    assert.ok(text.includes("event=apply.start"), "缺诊断轨起点");
    assert.ok(text.includes("event=apply.end"), "缺诊断轨收尾");
    assert.ok(text.includes("一致 true"), `两轨对账没通过：\n${text}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(host, { recursive: true, force: true });
  }
});

test("why <未知 runId>：退出码 1，且明说两轨都没有", () => {
  const { home, host } = fixture();
  try {
    const { code, out } = collect(["why", "apply-19700101T000000Z-0000"], home);
    assert.equal(code, 1);
    assert.ok(out.join("\n").includes("查无此 runId"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(host, { recursive: true, force: true });
  }
});

test("用法错误：缺 runId 或未知参数一律退出码 2", () => {
  const home = makeTemp("dsh-purge-query-home-");
  try {
    assert.equal(collect(["why"], home).code, 2);
    assert.equal(collect(["why", "--nope"], home).code, 2);
    assert.equal(collect(["tail", "--n", "abc"], home).code, 2);
    assert.equal(collect(["tail", "--status"], home).code, 2, "--status 缺值应退 2");
    assert.equal(collect(["tail", "--status", ""], home).code, 2, "--status 空值应退 2");
    assert.equal(collect(["tail", "--status", "applied,,skipped"], home).code, 2, "--status 空段是句法写坏，应退 2");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("tail：新的在前；空目录退出码 1；--n 生效", () => {
  const { home, host } = fixture();
  try {
    const all = collect(["tail"], home);
    assert.equal(all.code, 0);
    const rows = all.out.filter((line) => line.trim().startsWith("seq="));
    assert.ok(rows.length >= 6, `tail 行数不对：${rows.length}`);
    assert.match(rows[0], /seq=5/, "tail 应当是新的在前");

    const few = collect(["tail", "--n", "2"], home);
    assert.equal(few.out.filter((line) => line.trim().startsWith("seq=")).length, 2);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(host, { recursive: true, force: true });
  }

  const empty = makeTemp("dsh-purge-query-empty-");
  try {
    assert.equal(collect(["tail"], empty).code, 1, "一条都没有时应当退出码 1，不是假绿");
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test("--json：why 与 tail 都输出可解析的 JSON", () => {
  const { home, host, runId } = fixture();
  try {
    const why = collect(["why", runId, "--json"], home);
    assert.equal(why.code, 0);
    const parsed = JSON.parse(why.out.join("\n"));
    assert.equal(parsed.runId, runId);
    assert.equal(parsed.found, true);
    assert.ok(parsed.audit.length >= 6);
    assert.equal(parsed.cross.consistent, true);

    const tail = collect(["tail", "--n", "1", "--json"], home);
    assert.equal(tail.code, 0);
    const rows = JSON.parse(tail.out.join("\n"));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].seq, 5);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(host, { recursive: true, force: true });
  }
});

test("tail --status：只留 detail.status 命中的文件层行，层结论行不出现", () => {
  const { home, host } = statusFixture();
  try {
    const hit = collect(["tail", "--status", "skipped,pattern_not_found"], home);
    assert.equal(hit.code, 0);
    const rows = rowsOf(hit);
    assert.equal(rows.length, 2, `筛出 ${rows.length} 条：\n${hit.out.join("\n")}`);
    assert.ok(rows.every((line) => /status=(?:skipped|pattern_not_found)$/.test(line)), rows.join("\n"));
    assert.ok(!hit.out.join("\n").includes("apply-result"), "带 --status 时层结论行不该出现 —— 那是过滤生效，不是丢行");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(host, { recursive: true, force: true });
  }
});

test("tail --status：筛完为空与一条都没有同档，退出码 1；值拼错也走这一档", () => {
  const { home, host } = statusFixture();
  try {
    const typo = collect(["tail", "--status", "nope"], home);
    assert.equal(typo.code, 1, "文件里有行但筛完 0 条时必须退 1 —— 否则值拼错看不出来");
    assert.equal(rowsOf(typo).length, 0);
    assert.ok(typo.out.join("\n").includes("0 条"), typo.out.join("\n"));

    // 层结论行的 detail 里是计数、没有 status 字段：拿它自己的名义去筛也永远是 0 条。
    assert.equal(collect(["tail", "--status", "partial"], home).code, 1);
    // 值逐字匹配：写半截（`app`）不算命中 `applied`，与拼错同档。
    assert.equal(collect(["tail", "--status", "app"], home).code, 1);
    // 状态确实存在，只是不在这层：叠加过滤后同样退 1，不许退回全量。
    assert.equal(collect(["tail", "--layer", "tool", "--status", "applied"], home).code, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(host, { recursive: true, force: true });
  }
});

test("tail --status：逗号多值，与 --runId / --layer / --event 叠加", () => {
  const { home, host, runId } = statusFixture();
  try {
    const got = collect([
      "tail", "--runId", runId, "--layer", "code", "--event", "code.patch-",
      "--status", "applied,skipped,pattern_not_found,read_error,missing_file,write_error",
    ], home);
    assert.equal(got.code, 0);
    const rows = rowsOf(got);
    assert.equal(rows.length, 3, `代码层应有 3 条文件行：\n${got.out.join("\n")}`);
    assert.ok(rows.every((line) => line.includes("layer=code")), rows.join("\n"));
    assert.ok(rows.some((line) => line.includes("status=write_error:")), "write_error 的冒号后缀没按前缀命中");
    assert.ok(!got.out.join("\n").includes("code.apply-result"), "事件前缀 code.patch- 不含层结论行");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(host, { recursive: true, force: true });
  }
});

test("tail --status：--n 数的是筛后的条数（过滤先于截断）", () => {
  const { home, host } = statusFixture();
  try {
    // applied 那条是最旧的（提示词层先写）：先截 1 条再筛会把它截掉，正是要防的读法。
    const one = collect(["tail", "--n", "1", "--status", "applied"], home);
    assert.equal(one.code, 0, `筛后应有 1 条：\n${one.out.join("\n")}`);
    const rows = rowsOf(one);
    assert.equal(rows.length, 1);
    assert.match(rows[0], /status=applied$/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(host, { recursive: true, force: true });
  }
});

test("HTTP 查询面：五个模式各有参数，且没有第二个叫 why 的参数", () => {
  // 为什么锁源码：这条路由是唯一没有行为夹具的出口（要真宿主才跑得起来），
  // 而它最容易出的错就是「同一个词两种含义」—— `why` 曾经在 CLI 收 runId、在 HTTP 收 seq。
  const source = fs.readFileSync(path.join(ROOT, "lib", "index.js"), "utf8");
  const start = source.indexOf('path: "/dsh-purge/audit"');
  assert.ok(start > 0, "找不到审计查询路由");
  const block = source.slice(start, source.indexOf('}, "dsh-purge: audit");', start));
  for (const mode of ["seq", "run", "check", "remedy", "tail"]) {
    assert.ok(block.includes(`params.has("${mode}")`), `HTTP 查询面缺 ${mode} 模式`);
  }
  // `why` 只允许作为 CLI 子命令名出现（`runAuditQuery(["why", …])`），不许再当 HTTP 参数。
  assert.equal(block.includes('has("why")'), false, "HTTP 侧不许再出现 why 参数：why 只属于 CLI 且只收 runId");
  // 自证与按轮两条必须复用 CLI 的同一实现，不许在路由里另写一套判据。
  assert.ok(block.includes("runAuditCli("), "HTTP 的 check 没有复用 audit check 的实现");
  assert.ok(block.includes("runAuditQuery("), "HTTP 的 run 没有复用 CLI why 的实现");
});

test("--json 与 --status 一起用：同一批行，空结果也是可解析的空数组", () => {
  const { home, host } = statusFixture();
  try {
    const json = collect(["tail", "--status", "skipped", "--json"], home);
    assert.equal(json.code, 0);
    const rows = JSON.parse(json.out.join("\n"));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event, "code.patch-skipped");
    assert.equal(rows[0].detail.status, "skipped");
    assert.equal(rowsOf(collect(["tail", "--status", "skipped"], home)).length, 1, "文本与 JSON 条数不一致");

    const empty = collect(["tail", "--status", "nope", "--json"], home);
    assert.equal(empty.code, 1);
    assert.deepEqual(JSON.parse(empty.out.join("\n")), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(host, { recursive: true, force: true });
  }
});
