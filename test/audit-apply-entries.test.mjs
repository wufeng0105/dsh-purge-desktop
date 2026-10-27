/**
 * test/audit-apply-entries.test.mjs — 四个 apply 入口共用同一段落账，且与诊断轨同 runId。
 *
 * 为什么存在：审计原先只有面板 HTTP 一条写路径，CLI / 命令 / 工具三条路只写诊断轨，
 * 于是「同一轮按 runId 在两条轨上 join」只在四分之一入口成立。这份用例守两件事：
 *
 *   一、落账本体：折行、before 摘要、按入口给的 runId 写盘，写出来的日志要能过
 *      `audit check`（否则「有审计行」与「审计完整」是两件事）。
 *   二、接线结构：三个宿主内入口与 CLI 各自只调用一次统一落账，且审计用的 runId
 *      与 `withApplyRun` 声明的是同一个变量 —— 分别造一个 runId 也能写出行来，
 *      但两轨就 join 不上了。
 *
 * 全部用例在系统临时目录里跑，真实 DSH_HOME 一个字节都不写。
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  collectApplyBefore,
  readEvents,
  recordApplyRun,
  runAuditCli,
  resolveAuditDir,
} from "../lib/audit/index.js";
import { summarizeApplyReport } from "../lib/core.js";
import { diagLogPath } from "../lib/diag-log.js";
import * as reapply from "../lib/reapply.js";

const ROOT = path.resolve(import.meta.dirname, "..");

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

function quietIo() {
  const out = [];
  const err = [];
  return { out: (line) => out.push(line), err: (line) => err.push(line), lines: out, errors: err };
}

/** 三个层各一个真实落点；before 表齐全，层结论才可能落到 ok。 */
function threeLayerFixture(host, home) {
  const files = {};
  const patches = [
    { id: 1, name: "PROMPT_ONE", layer: "提示词", marker: "MK_A", file: "ka" },
    { id: 2, name: "CODE_ONE", layer: "代码", marker: "MK_B", file: "kb" },
    { id: 3, name: "TOOL_ONE", layer: "工具", marker: "MK_B", file: "kb" },
  ];
  for (const [key, name, marker] of [["ka", "a.js", "MK_A"], ["kb", "b.js", "MK_B"]]) {
    const file = path.join(host, name);
    fs.writeFileSync(file, `${marker}\n`);
    files[key] = file;
  }
  return {
    patches,
    targets: files,
    report: patches.map((patch) => ({ patch_id: patch.id, status: "applied" })),
    dshHome: home,
  };
}

test("落账本体：给定 runId 写三层，行内 runId 逐字一致，且能过 audit check", () => {
  const host = makeTemp("dsh-purge-entry-host-");
  const home = makeTemp("dsh-purge-entry-home-");
  const runId = "apply-20260101T000000Z-00a1";
  try {
    const fixture = threeLayerFixture(host, home);
    const before = collectApplyBefore(fixture.patches, fixture.targets);
    assert.deepEqual(Object.keys(before).sort(), Object.values(fixture.targets).sort(), "before 表要覆盖全部落点");

    const artifact = recordApplyRun({ ...fixture, before, runId });
    assert.ok(artifact, "三行报告必须落出一批审计事件");
    assert.equal(artifact.record.events, 6, "三条文件行 + 三条层结论");

    const events = readEvents(home);
    assert.equal(events.length, 6);
    assert.deepEqual([...new Set(events.map((event) => event.runId))], [runId], "全批共用入口给的 runId");
    for (const layer of ["prompt", "code", "tool"]) {
      assert.equal(artifact.record.layers[layer].result, "ok", `${layer} 层记全了应当 ok`);
    }

    // 判据不是「写进去了」，而是「写出来的东西过完整性判据」。
    const io = quietIo();
    const code = runAuditCli(["check", "--dir", resolveAuditDir(home)], io);
    assert.equal(code, 0, `audit check 判这份新日志没过：\n${io.lines.join("\n")}\n${io.errors.join("\n")}`);
  } finally {
    fs.rmSync(host, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("落账本体：报告为空返回 null，不写空壳审计", () => {
  const home = makeTemp("dsh-purge-entry-home-");
  try {
    const artifact = recordApplyRun({ dshHome: home, report: [], patches: [], targets: {}, before: {}, runId: "apply-x" });
    assert.equal(artifact, null);
    assert.equal(readEvents(home).length, 0, "没有逐补丁判定的轮次不许写审计行");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("审计写盘失败要落一条 apply.audit.fail，别只剩 console.warn", () => {
  const home = makeTemp("dsh-purge-entry-home-");
  const host = makeTemp("dsh-purge-entry-host-");
  const runId = "apply-20260101T000000Z-fa11";
  try {
    const file = path.join(host, "a.js");
    fs.writeFileSync(file, "MK\n");
    // target 上限 512 字符：超长名字会让落盘前的 schema 校验抛错，正是这条用例要的失败。
    const patches = [{ id: 1, name: "N".repeat(600), layer: "代码", marker: "MK", file: "k" }];
    assert.throws(
      () => recordApplyRun({
        dshHome: home,
        report: [{ patch_id: 1, status: "applied" }],
        patches,
        targets: { k: file },
        before: { [file]: null },
        runId,
      }),
      /target/,
    );
    const diagRows = readLines(diagLogPath(home));
    const failure = diagRows.find((row) => row.event === "apply.audit.fail");
    assert.ok(failure, `诊断轨里没有 apply.audit.fail：${diagRows.map((row) => row.event).join(", ")}`);
    assert.equal(failure.runId, runId, "失败事件必须带入口 runId，否则回不到那一轮");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(host, { recursive: true, force: true });
  }
});

test("接线结构：宿主内三个入口各调用一次统一落账，审计 runId 与 withApplyRun 同一个变量", () => {
  const source = fs.readFileSync(path.join(ROOT, "lib", "index.js"), "utf8");
  // 唯一出口：入口不许按文件去取审计的任一层；绕过它的人下次就会漏传 before / runId。
  const direct = [...source.matchAll(/from "\.\/audit\/(report|store|events|layers)\.js"/g)].map((match) => match[1]);
  assert.deepEqual(direct, [], `lib/index.js 绕过审计唯一出口直接 import 了：${direct.join(", ")}`);
  assert.ok(source.includes('from "./audit/index.js"'), "lib/index.js 没有从 ./audit/index.js 取审计能力");
  for (const [entry, variable] of [["command", "commandRunId"], ["tool", "toolRunId"], ["http", "httpRunId"]]) {
    assert.ok(
      source.includes(`{ entry: "${entry}", runId: ${variable} }`),
      `${entry} 入口的 withApplyRun 没有用 ${variable} 声明身份`,
    );
  }
  const blocks = [...source.matchAll(/^\s*(?:const \w+ = )?auditApplyEntry\(\{[\s\S]*?\n\s*\}\);/gm)].map((match) => match[0]);
  assert.equal(blocks.length, 3, "命令 / 工具 / HTTP 三个入口应各调用一次统一落账");
  const ids = blocks.map((block) => {
    const found = /runId: ([A-Za-z0-9_]+)/.exec(block);
    assert.ok(found, `落账调用没有传 runId：${block.slice(0, 80)}`);
    return found[1];
  });
  assert.deepEqual(ids.sort(), ["commandRunId", "httpRunId", "toolRunId"], "审计用的 runId 不是入口那一个");
  // 入口也要落到审计行上：只传 runId 的话，审计轨永远答不出「谁触发的」，
  // 而那个答案只留在会滚掉的诊断轨里。三个入口的 entry 必须与 withApplyRun 声明的是同一个字面量。
  for (const [entry, variable] of [["command", "commandRunId"], ["tool", "toolRunId"], ["http", "httpRunId"]]) {
    const block = blocks.find((text) => text.includes(`runId: ${variable}`));
    assert.ok(block, `找不到 ${entry} 入口的落账调用`);
    assert.ok(
      block.includes(`entry: "${entry}"`),
      `${entry} 入口的落账没有传 entry —— 审计行上就不会有这个入口的痕迹`,
    );
  }
});

test("接线结构：CLI 两条分支共用 applyRunId，落账走 recordCliApplyAudit", () => {
  const source = fs.readFileSync(path.join(ROOT, "bin", "dsh-purge.js"), "utf8");
  assert.ok(source.includes('{ entry: "cli", runId: applyRunId, sealed: true }'), "密封分支的身份不是 applyRunId");
  assert.ok(source.includes('{ entry: "cli", runId: applyRunId, sealed: false }'), "非密封分支的身份不是 applyRunId");
  const calls = source.match(/recordCliApplyAudit\(\{/g) || [];
  assert.ok(calls.length >= 2, "密封失败路径与成功路径都要落账（改了一半的证据最值钱）");
  const helper = source.slice(source.indexOf("function recordCliApplyAudit"));
  assert.ok(helper.includes("runId,"), "CLI 落账函数没有把 runId 传下去");
});

test("版本账本：事实每轮都写、身份只给干净轮，且失败分支在退出前就写了事实", () => {
  // 三件事一起钉住：
  //   1. 四个入口共用同一处记账实现（`reapply.recordApplyRound`），不各写一遍；
  //   2. **失败分支必须在 `process.exit(1)` 之前记事实** —— 这是自锁的缺口所在：
  //      密封分支原先在写账本那一整段之前就退出了，这一轮真写过的字节整批丢掉；
  //   3. 身份（`run_id` / `audit`）只给干净轮 —— 否则 `startup.ready.appliedRunId`
  //      会指向一次没洗完的尝试。
  const source = fs.readFileSync(path.join(ROOT, "bin", "dsh-purge.js"), "utf8");
  assert.ok(
    source.includes('import * as reapply from "../lib/reapply.js";'),
    "bin 没有接上 reapply —— 版本账本的函数调不到",
  );
  const applyBlock = source.indexOf('if (mode === "--apply")');
  const facts = source.indexOf("const recordRoundFacts =", applyBlock);
  assert.ok(facts > applyBlock, "CLI 没有把「记这一轮事实」提成一处可复用的实现");
  assert.ok(
    source.indexOf("reapply.recordApplyRound({", facts) > facts,
    "CLI 记事实没有走四个入口共用的实现",
  );
  // 密封失败分支：记事实必须在退出之前。
  const notOk = source.indexOf("if (!cleaned.ok) {", applyBlock);
  assert.ok(notOk > 0, "找不到密封失败分支");
  const factsCall = source.indexOf("recordRoundFacts({", notOk);
  const failedExit = source.indexOf("process.exit(1)", notOk);
  assert.ok(
    factsCall > notOk && failedExit > factsCall,
    "密封失败分支在写账本之前就退出了 —— 这一轮真写过的字节会整批丢掉",
  );

  // 两半的分工在 `recordApplyRound` 一处：事实无条件是写，身份由 clean 决定。
  const stamp = fs.readFileSync(path.join(ROOT, "lib", "stamp.js"), "utf8");
  const fnAt = stamp.indexOf("export function recordApplyRound(");
  assert.ok(fnAt > 0, "找不到 recordApplyRound —— 四个入口的记账实现没了");
  const fn = stamp.slice(fnAt, fnAt + 2400);
  assert.match(
    fn,
    /runId: clean \? String\(input\.runId \|\| ""\) : ""/,
    "事实写了、身份也写了：失败轮会占住「最后一次成功 apply」",
  );
  assert.ok(fn.includes("isCleanApplyRound({"), "干净轮判据没有与另外三个入口同源");
  assert.ok(fn.includes("markPatchesApplied("), "记账实现没有走到真正的写入口");

  const host = fs.readFileSync(path.join(ROOT, "lib", "index.js"), "utf8");
  assert.ok(
    host.includes("reapply.recordApplyRound({"),
    "宿主侧三个入口没有共用记账实现",
  );
});

test("成功收尾的门槛：硬失败 / 缺标记 / 安全阀失败都不许写，软失败照写", () => {
  // 判据不能只看「命令走到了收尾」：V2 的硬错就是把部分失败的那一轮写成了账本里的成功轮。
  const hard = summarizeApplyReport([{ patch_id: 1, status: "write_error:EACCES" }]);
  assert.equal(hard.failed.length, 1);
  assert.equal(
    reapply.isCleanApplyRound({ failed: hard.failed.length, hostWritten: true }),
    false,
    "有硬失败的那一轮不许占住账本",
  );
  const readFailed = summarizeApplyReport([{ patch_id: 1, status: "read_error" }]);
  assert.equal(reapply.isCleanApplyRound({ failed: readFailed.failed.length, hostWritten: true }), false);

  // 软失败（补丁自己声明可接受）不进 failed，与面板的 complete 同一口径。
  const softPatch = { id: 2, name: "SOFT", layer: "代码", marker: "MISSING", onMiss: "ignore", file: "k" };
  const soft = summarizeApplyReport([{ patch_id: 2, status: "pattern_not_found" }], [softPatch]);
  assert.equal(soft.failed.length, 0);
  assert.equal(reapply.isCleanApplyRound({ failed: soft.failed.length, hostWritten: true }), true);

  assert.equal(reapply.isCleanApplyRound({ failed: 0, hostWritten: false }), false, "标记没落地 = 没写进宿主，不许记账");
  assert.equal(reapply.isCleanApplyRound({ failed: 0, hostWritten: true, hookDenyRestoreFailed: true }), false);
  assert.equal(reapply.isCleanApplyRound({ failed: 0, hostWritten: true, hookDenyRestoreFailed: false }), true);
  assert.equal(reapply.isCleanApplyRound({}), false, "缺输入时按「没洗干净」处理，不许默认放行");
  assert.equal(reapply.isCleanApplyRound(), false);
  assert.equal(reapply.isCleanApplyRound(null), false);
});

test("版本账本：失败收尾也写事实，但不占住「最后一次成功 apply」的身份", () => {
  // 契约在这一版翻面：**事实每轮都写，身份只给干净轮**。
  //
  // 旧契约是「判定为否就一次都不调」。它错在把两件事绑在一起：失败轮真写过的字节因此
  // 一条也进不了账本，下一轮仍按旧世代判它们待应用 —— pending 让轮次不干净、不干净就不写、
  // 不写下一轮还判 pending。跨代升级后的第一轮就是这么把自己锁死的。
  const home = makeTemp("dsh-purge-ledger-home-");
  const previous = process.env.DSH_HOME;
  const stampPath = path.join(home, "dsh-purge", "applied.json");
  try {
    process.env.DSH_HOME = home;
    const previousRun = "apply-20260101T000000Z-0ld0";
    reapply.markPatchesApplied(undefined, { runId: previousRun });
    const before = JSON.parse(fs.readFileSync(stampPath, "utf8"));
    // 三档任一不过就不算干净轮（与 bin / index 三个入口同一判据）。
    for (const input of [
      { failed: 2, hostWritten: true, hookDenyRestoreFailed: false },
      { failed: 0, hostWritten: false, hookDenyRestoreFailed: false },
      { failed: 0, hostWritten: true, hookDenyRestoreFailed: true },
    ]) {
      assert.equal(reapply.isCleanApplyRound(input), false, "这三档都不该算干净轮");
    }

    const written = path.join(home, "host.js");
    fs.writeFileSync(written, "x", "utf8");
    const round = reapply.recordApplyRound({
      entry: "cli",
      runId: "apply-20260101T000000Z-bad0",
      clean: false,
      roundFailed: true,
      report: [{ patch_id: 1, status: "write_error:EACCES" }],
      evidence: { patchesWritten: ["1"], filesWritten: [written] },
      hostWritten: true,
      hookDenyRestoreFailed: false,
    });
    assert.equal(round.error, "", "写失败轮事实时报错了");
    assert.equal(round.clean, false, "有硬失败的那一轮不许算干净轮");

    const after = JSON.parse(fs.readFileSync(stampPath, "utf8"));
    assert.equal(after.run_id, previousRun, "失败轮把「最后一次成功 apply」的身份覆盖了");
    assert.ok(after.patchesWritten.includes("1"), "失败轮真写过的补丁必须进账本，否则下一轮自锁");
    assert.ok(
      after.contentSha && Object.keys(after.contentSha).length > 0,
      "失败轮写过的文件字节要留下指纹：下一轮靠它判断字节有没有被动过",
    );
    assert.equal(after.lastRound && after.lastRound.clean, false, "「这一轮没洗干净」这件事本身也要留下");
    assert.notDeepEqual(after, before, "失败轮必须留下事实（旧契约是整份 applied.json 不动）");
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("干净轮才写身份：干净轮把 run_id 换成这一轮的", () => {
  const home = makeTemp("dsh-purge-ledger-home-");
  const previous = process.env.DSH_HOME;
  const stampPath = path.join(home, "dsh-purge", "applied.json");
  try {
    process.env.DSH_HOME = home;
    reapply.markPatchesApplied(undefined, { runId: "apply-20260101T000000Z-0ld0" });
    const runId = "apply-20260101T000000Z-900d";
    const round = reapply.recordApplyRound({
      entry: "cli",
      runId,
      clean: true,
      report: [{ patch_id: 1, status: "applied" }],
      evidence: { patchesWritten: ["1"] },
      hostWritten: true,
    });
    assert.equal(round.clean, true, "干净的轮次没被认出来");
    const after = JSON.parse(fs.readFileSync(stampPath, "utf8"));
    assert.equal(after.run_id, runId, "干净轮必须把身份换成这一轮的");
    assert.equal(after.lastRound.clean, true);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("版本账本：临时 home 里 markPatchesApplied + noteAppliedAudit 写出 run_id 与 audit 摘要", () => {
  const home = makeTemp("dsh-purge-ledger-home-");
  const previous = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = home;
    const runId = "apply-20260101T000000Z-7e57";
    reapply.markPatchesApplied(undefined, { runId });
    const merged = reapply.noteAppliedAudit({
      runId,
      events: 6,
      layers: { prompt: { result: "ok" }, code: { result: "ok" }, tool: { result: "ok" } },
      unresolved: [],
    });
    assert.equal(merged, true, "并摘要失败：账本里没有「这一轮记全了没有」");
    const applied = JSON.parse(fs.readFileSync(path.join(home, "dsh-purge", "applied.json"), "utf8"));
    assert.equal(applied.run_id, runId, "applied.json.run_id 不是这一轮的 runId");
    assert.equal(applied.audit.events, 6, "audit.events 与落账不一致");
    assert.deepEqual(applied.audit.layers, { prompt: "ok", code: "ok", tool: "ok" });
    assert.deepEqual(applied.audit.unresolved, []);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("两轨口径：硬 miss 与软 miss 分别给出 fail / skip，诊断轨只数硬失败", () => {
  const home = makeTemp("dsh-purge-entry-home-");
  try {
    const hard = { id: 11, name: "HARD", layer: "代码", marker: "MISSING", file: "k1" };
    const soft = { id: 12, name: "SOFT", layer: "代码", marker: "MISSING", file: "k2", onMiss: "ignore" };
    const report = [
      { patch_id: hard.id, status: "pattern_not_found" },
      { patch_id: soft.id, status: "pattern_not_found" },
    ];
    const artifact = recordApplyRun({
      dshHome: home,
      report,
      patches: [hard, soft],
      targets: { k1: path.join(home, "a.js"), k2: path.join(home, "b.js") },
      before: {},
      runId: "apply-20260101T000000Z-5f7a",
    });
    assert.equal(artifact.record.layers.code.failed, 1, "只有硬 miss 算失败");
    assert.equal(artifact.record.layers.code.skipped, 1, "软 miss 记 skip，与诊断轨的 soft 同一结论");
    assert.deepEqual(
      summarizeApplyReport(report, [hard, soft]).failed.map((row) => row.patch_id),
      [hard.id],
      "诊断轨也只把硬 miss 算进 failed —— 两轨不能各说各话",
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
