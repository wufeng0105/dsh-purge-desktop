/**
 * test/revert-identity.test.mjs — 还原的五条事件必须带入口身份，且同一次还原共用一个 runId。
 *
 * 为什么存在：真机上 82 条 `revert.*` 一条 `entry` 都没有 —— 「这次还原是谁点的」
 * 只能按时间猜。身份走的是与 apply 同一条环境缝（`withApplyRun`），所以判据也分两层：
 * 还原本体在声明身份后五条事件都带上，以及四个入口都从带身份的入口函数进来。
 *
 * 还原没有版本门禁：这里一律显式给 `bases` 与 `dshHome`，绝不靠枚举去碰本机宿主树。
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

function makeTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readDiag(home) {
  try {
    return fs.readFileSync(path.join(home, "dsh-purge", "logs", "diag.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/** 造一个最小宿主：一个目标文件 + 一份官方原件备份，还原才有「文件被写回」可言。 */
async function fixture(core) {
  const host = makeTemp("dsh-purge-revert-host-");
  const home = makeTemp("dsh-purge-revert-home-");
  const aiBase = path.join(host, "node_modules", "@deepseek-ai");
  const libDir = path.join(aiBase, "dsh-agent-instructions", "lib");
  fs.mkdirSync(libDir, { recursive: true });
  fs.writeFileSync(path.join(libDir, "index.js"), "export const x = 1;\n");
  fs.writeFileSync(
    path.join(aiBase, "dsh-agent-instructions", "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh-agent-instructions", version: "0.2.1-rc.2" }),
  );
  process.env.DSH_HOME = home;
  process.env.DSH_BASE = aiBase;
  process.env.DSH_SURFACE = "desktop";
  const backups = await core.backupAll(aiBase);
  assert.equal(backups.errors.length, 0, `夹具备份失败：${JSON.stringify(backups.errors)}`);
  // 打上清洗痕迹，还原才有事可做。
  fs.writeFileSync(path.join(libDir, "index.js"), "export const x = 1;\n// dsh-purge patch\n");
  return { host, home, aiBase };
}

/** 环境变量在本文件的所有用例里都要复原：同一文件内的用例共享一个进程。 */
function restoreEnv(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test("声明入口后：revert.start / revert.file / revert.end 三条都带 entry 与同一个 runId", async () => {
  const core = await import("../lib/core.js");
  const previous = {
    DSH_HOME: process.env.DSH_HOME,
    DSH_BASE: process.env.DSH_BASE,
    DSH_SURFACE: process.env.DSH_SURFACE,
  };
  const dirs = { host: "", home: "" };
  try {
    const made = await fixture(core);
    dirs.host = made.host;
    dirs.home = made.home;
    const result = await core.revertAllHostsFor("command", { bases: [made.aiBase], dshHome: made.home });
    assert.equal(result.reverted.length, 1, "夹具里应当有一个文件被写回官方原件");

    const rows = readDiag(made.home).filter((row) => row.event.startsWith("revert."));
    assert.deepEqual(rows.map((row) => row.event), ["revert.start", "revert.file", "revert.end"]);
    const runIds = new Set(rows.map((row) => row.runId));
    assert.equal(runIds.size, 1, `同一次还原的 runId 不一致：${[...runIds].join(", ")}`);
    assert.match([...runIds][0], /^apply-\d{8}T\d{6}Z-[0-9a-f]{4}$/);
    for (const row of rows) {
      assert.equal(row.entry, "command", `${row.event} 的 entry 不对：${row.entry}`);
    }
  } finally {
    restoreEnv(previous);
    for (const dir of [dirs.host, dirs.home]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("对照：不声明身份直接调 revertAllHosts，事件一行都不带 entry 与 runId", async () => {
  const core = await import("../lib/core.js");
  const home = makeTemp("dsh-purge-revert-home-");
  const previous = { DSH_HOME: process.env.DSH_HOME };
  try {
    process.env.DSH_HOME = home;
    await core.revertAllHosts({ bases: [], dshHome: home });
    const rows = readDiag(home).filter((row) => row.event.startsWith("revert."));
    assert.deepEqual(rows.map((row) => row.event), ["revert.start", "revert.end"]);
    for (const row of rows) {
      assert.equal(row.entry, undefined, `${row.event} 没声明身份却带了 entry：${row.entry}`);
      assert.equal(row.runId, undefined, `${row.event} 没声明身份却带了 runId：${row.runId}`);
    }
  } finally {
    restoreEnv(previous);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("接线结构：四个入口都从 revertAllHostsFor 进来，没有谁绕过去直接调引擎", () => {
  const index = fs.readFileSync(path.join(ROOT, "lib", "index.js"), "utf8");
  const bin = fs.readFileSync(path.join(ROOT, "bin", "dsh-purge.js"), "utf8");
  for (const entry of ["command", "tool", "http"]) {
    assert.ok(
      index.includes(`core.revertAllHostsFor("${entry}")`),
      `${entry} 入口没有走带身份的 revertAllHostsFor`,
    );
  }
  assert.ok(bin.includes('core.revertAllHostsFor("cli")'), "CLI --revert 没有走带身份的入口");
  assert.ok(!/core\.revertAllHosts\(\)/.test(index), "lib/index.js 仍有绕过身份的 revertAllHosts() 直调");
  assert.ok(!/core\.revertAllHosts\(\)/.test(bin), "bin 仍有绕过身份的 revertAllHosts() 直调");
});
