/**
 * 测试与运行的隔离接缝：测试跑的 apply 不许把事件写进真实 home。
 *
 * 为什么单独立一份：测试夹具用的是临时宿主树，但日志落点原先由 findDshHome() 决定，
 * 于是夹具路径混进了开发者真实 ~/.dsh/dsh-purge/logs/diag.jsonl —— 那份日志是排障
 * 时唯一的事实源，被测试噪声灌满后就失去了「哪次真实操作出了什么问题」的可读性。
 *
 * 三条判据对应三件事：日志跟着显式 dshHome 走；真实 home 一个字节都不动；
 * 同一进程内换 home 后落点会跟着换（而不是锁死在第一次写入的路径上）。
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { diagLog } from "../lib/diag-log.js";

const REAL_DIAG = path.join(os.homedir(), ".dsh", "dsh-purge", "logs", "diag.jsonl");

function makeTempHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function diagFile(home) {
  return path.join(home, "dsh-purge", "logs", "diag.jsonl");
}

function readLines(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** 真实 home 的日志指纹；文件不存在时用 exists=false 表示，避免把「没写」误判成「没变」。 */
function realDiagFingerprint() {
  try {
    const stat = fs.statSync(REAL_DIAG);
    return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return { exists: false, size: 0, mtimeMs: 0 };
  }
}

/**
 * 造一个版本明确不匹配的假宿主。门禁拒绝路径不会写任何宿主文件，
 * 却完整走过 apply 的 diag 接缝 —— 这就是我们要观测的那一段。
 */
function makeMismatchedHost(root) {
  const aiBase = path.join(root, "node_modules", "@deepseek-ai");
  fs.mkdirSync(path.join(aiBase, "dsh-agent-instructions", "lib"), { recursive: true });
  fs.writeFileSync(path.join(aiBase, "dsh-agent-instructions", "lib", "index.js"), "export const x = 1;\n");
  fs.writeFileSync(
    path.join(aiBase, "dsh-agent-instructions", "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh-agent-instructions", version: "0.3.0" }),
  );
  return aiBase;
}

test("判据 a：显式 dshHome 下跑 apply，diag 事件只落在临时 home", async () => {
  const core = await import("../lib/core.js");
  const root = makeTempHome("dsh-purge-log-iso-host-");
  const home = makeTempHome("dsh-purge-log-iso-home-");
  const aiBase = makeMismatchedHost(root);
  const previousBase = process.env.DSH_BASE;
  const previousSurface = process.env.DSH_SURFACE;
  // 故意不动 DSH_HOME：门禁拒绝路径除 diag 外零写盘，事件能落进临时 home 的
  // 唯一通道就是 options.dshHome —— 这条测试要测的正是注入点本身。
  process.env.DSH_SURFACE = "desktop";
  process.env.DSH_BASE = aiBase;
  try {
    await assert.rejects(
      () => core.applyPatchesAllHosts(core.ALL_PATCHES, { dshHome: home }),
      (error) => error.code === "DSH_PURGE_HOST_VERSION_MISMATCH",
    );

    const lines = readLines(diagFile(home));
    assert.ok(lines.length > 0, `临时 home 下没有 diag 事件：${diagFile(home)}`);
    const events = lines.map((line) => JSON.parse(line).event);
    assert.ok(events.includes("apply.start"), `临时 home 下缺少 apply.start：${events.join(", ")}`);
    assert.ok(events.includes("apply.gate.reject"), `临时 home 下缺少 apply.gate.reject：${events.join(", ")}`);

    // 事件里的路径只能指向临时树；出现别的宿主树说明枚举把不该带的东西带进来了。
    for (const line of lines) {
      const row = JSON.parse(line);
      for (const value of Object.values(row)) {
        if (typeof value !== "string" || !value.includes("dsh-purge")) continue;
        assert.ok(
          !value.includes(path.join(os.homedir(), ".dsh", "dsh-purge")),
          `临时 home 的事件里出现了真实 home 路径：${value}`,
        );
      }
    }
  } finally {
    if (previousBase === undefined) delete process.env.DSH_BASE;
    else process.env.DSH_BASE = previousBase;
    if (previousSurface === undefined) delete process.env.DSH_SURFACE;
    else process.env.DSH_SURFACE = previousSurface;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("判据 b：跑完临时 home 的 apply，真实 home 的 diag 字节数与 mtime 不变", async () => {
  const core = await import("../lib/core.js");
  const root = makeTempHome("dsh-purge-log-iso-host-");
  const home = makeTempHome("dsh-purge-log-iso-home-");
  const aiBase = makeMismatchedHost(root);
  const previousBase = process.env.DSH_BASE;
  const previousSurface = process.env.DSH_SURFACE;
  const before = realDiagFingerprint();
  // 同判据 a：不设 DSH_HOME，注入点一旦失效，事件就会落进真实 home 并被这里的指纹抓住。
  process.env.DSH_SURFACE = "desktop";
  process.env.DSH_BASE = aiBase;
  try {
    await assert.rejects(
      () => core.applyPatchesAllHosts(core.ALL_PATCHES, { dshHome: home }),
      (error) => error.code === "DSH_PURGE_HOST_VERSION_MISMATCH",
    );
    const after = realDiagFingerprint();
    assert.equal(after.exists, before.exists, "真实 diag 的存在性变了");
    assert.equal(after.size, before.size, `真实 diag 字节数变了：${before.size} → ${after.size}`);
    assert.equal(after.mtimeMs, before.mtimeMs, `真实 diag mtime 变了：${before.mtimeMs} → ${after.mtimeMs}`);
  } finally {
    if (previousBase === undefined) delete process.env.DSH_BASE;
    else process.env.DSH_BASE = previousBase;
    if (previousSurface === undefined) delete process.env.DSH_SURFACE;
    else process.env.DSH_SURFACE = previousSurface;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("判据 c：同进程先后用两个 dshHome 调 diagLog，两个目录各有一行", () => {
  const homeA = makeTempHome("dsh-purge-log-iso-a-");
  const homeB = makeTempHome("dsh-purge-log-iso-b-");
  try {
    const wroteA = diagLog("log-isolation.probe", { where: "a" }, homeA);
    const wroteB = diagLog("log-isolation.probe", { where: "b" }, homeB);

    assert.equal(wroteA, diagFile(homeA), "第一次调用的落点不对");
    assert.equal(wroteB, diagFile(homeB), "第二次调用仍写到了第一次的路径（cachedPath 又锁死了）");

    const linesA = readLines(diagFile(homeA));
    const linesB = readLines(diagFile(homeB));
    assert.equal(linesA.length, 1, `homeA 应有 1 行，实际 ${linesA.length}`);
    assert.equal(linesB.length, 1, `homeB 应有 1 行，实际 ${linesB.length}`);
    assert.equal(JSON.parse(linesA[0]).where, "a");
    assert.equal(JSON.parse(linesB[0]).where, "b");
  } finally {
    fs.rmSync(homeA, { recursive: true, force: true });
    fs.rmSync(homeB, { recursive: true, force: true });
  }
});

test("options.log === false 时本次 apply 不写 diag", async () => {
  const core = await import("../lib/core.js");
  const root = makeTempHome("dsh-purge-log-iso-host-");
  const home = makeTempHome("dsh-purge-log-iso-home-");
  const aiBase = makeMismatchedHost(root);
  const previousBase = process.env.DSH_BASE;
  const previousSurface = process.env.DSH_SURFACE;
  process.env.DSH_SURFACE = "desktop";
  process.env.DSH_BASE = aiBase;
  try {
    await assert.rejects(
      () => core.applyPatchesAllHosts(core.ALL_PATCHES, { dshHome: home, log: false }),
      (error) => error.code === "DSH_PURGE_HOST_VERSION_MISMATCH",
    );
    assert.deepEqual(readLines(diagFile(home)), [], "log:false 仍写出了 diag 行");
  } finally {
    if (previousBase === undefined) delete process.env.DSH_BASE;
    else process.env.DSH_BASE = previousBase;
    if (previousSurface === undefined) delete process.env.DSH_SURFACE;
    else process.env.DSH_SURFACE = previousSurface;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("两个内部探针写入器落同一个文件，且都不在系统临时目录", async () => {
  // 判据是结构性的：`logInternal` 唯一的调用入口在重启 / 换归档那几条路径上，
  // 测试里造不出来（要真解包、真动宿主树）。能锁的是「落点是谁算的」——
  // 系统临时目录会被 Windows 清掉，而这条日志记的正是下次开机要复盘的动作。
  const source = fs.readFileSync(path.join(import.meta.dirname, "..", "lib", "desktop.js"), "utf8");
  assert.ok(!source.includes("dsh-purge-desktop.log"), "logInternal 又写回系统临时目录的那个文件名了");
  assert.match(source, /INTERNAL_LOG_REL\s*=\s*path\.join\("dsh-purge",\s*"logs",\s*"desktop\.log"\)/);
  assert.match(source, /internalLogFile\(\)/, "logInternal 没有走 internalLogFile 算路径");
  assert.match(source, /rotateIfNeeded\(file, LOG_ROLLING\)/, "第二条旁路没有共用同一份滚动规格");

  const { purgeLogPath } = await import("../lib/purge-log.js");
  const home = makeTempHome("dsh-purge-log-iso-internal-");
  try {
    const expected = path.join(home, "dsh-purge", "logs", "desktop.log");
    assert.equal(purgeLogPath(home), expected, "purgeLog 的落点变了，desktop.js 那条旁路会写到另一个文件");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("测试调 diagLog 必须显式给落点（第三个参数或 DSH_PURGE_LOG_FILE）", () => {
  // 这条锁的是「测试噪声灌进真实诊断轨」那次事故：测试夹具跑完，开发机的
  // `~/.dsh/dsh-purge/logs/diag.jsonl` 里多出一堆 `log-isolation.probe`。
  // 判据只有一句：每个 diagLog 调用都得说出写哪儿 —— 第三参数，或者本文件把
  // DSH_PURGE_LOG_FILE 指到临时路径。缺一个，写的就是真实 home。
  const dir = path.join(import.meta.dirname);
  const offenders = [];
  let calls = 0;
  /** 数一条调用里的顶层逗号：花括号 / 方括号里的不算，字符串里的也不算。 */
  const topLevelArgs = (text) => {
    let depth = 0;
    let quote = null;
    let commas = 0;
    for (const ch of text) {
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "{" || ch === "[" || ch === "(") depth += 1;
      else if (ch === "}" || ch === "]" || ch === ")") depth -= 1;
      else if (ch === "," && depth === 0) commas += 1;
    }
    return commas + 1;
  };
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".mjs")) continue;
    const source = fs.readFileSync(path.join(dir, name), "utf8");
    const lines = source.split("\n");
    const isolated = source.includes("DSH_PURGE_LOG_FILE");
    lines.forEach((line, index) => {
      const at = line.indexOf("diagLog(");
      if (at === -1) return;
      // 引号紧贴在前面说明这是「断言源码里有没有某段字面量」，不是真调用。
      if (at > 0 && ['"', "'", "`"].includes(line[at - 1])) return;
      if (/^\s*(?:\*|\/\/)/.test(line)) return;
      calls += 1;
      const open = at + "diagLog(".length - 1;
      const args = topLevelArgs(line.slice(open).replace(/\);[^)]*$/, ")"));
      if (!isolated && args < 3) offenders.push(`${name}:${index + 1}  ${line.trim()}`);
    });
  }
  assert.ok(calls > 0, "一个 diagLog 调用都没扫到，判据跑空了");
  assert.deepEqual(offenders, [], "这些调用会给真实诊断轨写行：给第三个 dshHome 参数，或用 DSH_PURGE_LOG_FILE 指到临时");
});
