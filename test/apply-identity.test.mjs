/**
 * test/apply-identity.test.mjs — 入口声明的身份要随引擎事件落进 diag 行里。
 *
 * 为什么单独立一份：`lib/core.js` 本轮冻结，引擎那 12 个发射点里没有「谁触发的」。
 * 身份靠两段接缝才成立 —— 入口用 `withApplyRun` 声明、`lib/diag-log.js` 在 row 序列化
 * 之前补进去。任一接缝断掉，日志里每条 apply 事件都退回无主，而运行期看不出来，
 * 只有排障时才发现「分得开、连不上」。所以这里既验绿灯（声明了就有），也留一条对照
 * （不声明就没有），后者是「身份来自上下文而不是引擎」的反证。
 *
 * 覆盖缺口，明写：本文件只证 gate 之前的三条事件
 * apply.start / apply.hosts / apply.gate.reject。另外四条 —— apply.patch、apply.host、
 * apply.end、install.record —— 要真宿主才走得到，本包不证，也不造桩：桩得先自证与
 * 真宿主同构，那笔成本高于收益。看到本文件全绿，不等于那四条也带身份。
 *
 * 判据落在 mkdtempSync 造的一次性 home 上，真实 home 一个字节都不写。
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { currentApplyRun, newApplyRunId, withApplyRun } from "../lib/diag-log.js";

/** gate 之前能观测到的三条事件。其余四条见文件头的覆盖缺口。 */
const GATE_PATH_EVENTS = ["apply.start", "apply.hosts", "apply.gate.reject"];

function makeTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function diagFile(home) {
  return path.join(home, "dsh-purge", "logs", "diag.jsonl");
}

function rowsOf(home) {
  try {
    return fs.readFileSync(diagFile(home), "utf8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/**
 * 造一个版本明确不匹配的假宿主。门禁在写盘之前就整体拒绝，却完整走过
 * apply.start → apply.hosts → apply.gate.reject —— 正是本文件要观测的那一段，
 * 且不产生任何宿主副作用。
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

/** 夹具跑在临时宿主上：改环境变量，跑完一律复原，别把后面的用例带歪。 */
async function withFixtureEnv(aiBase, fn) {
  const previousBase = process.env.DSH_BASE;
  const previousSurface = process.env.DSH_SURFACE;
  process.env.DSH_SURFACE = "desktop";
  process.env.DSH_BASE = aiBase;
  try {
    return await fn();
  } finally {
    if (previousBase === undefined) delete process.env.DSH_BASE;
    else process.env.DSH_BASE = previousBase;
    if (previousSurface === undefined) delete process.env.DSH_SURFACE;
    else process.env.DSH_SURFACE = previousSurface;
  }
}

function indexByEvent(home) {
  const rows = rowsOf(home);
  assert.ok(rows.length > 0, `临时 home 下没有任何 diag 行：${diagFile(home)}`);
  return { rows, byEvent: new Map(rows.map((row) => [row.event, row])) };
}

test("声明身份后：apply.start / apply.hosts / apply.gate.reject 三行都带 entry 与 runId", async () => {
  const core = await import("../lib/core.js");
  const runId = newApplyRunId();
  const identity = { entry: "command", runId };
  const root = makeTemp("dsh-purge-identity-host-");
  const home = makeTemp("dsh-purge-identity-home-");
  let inside = null;
  try {
    const aiBase = makeMismatchedHost(root);
    await withFixtureEnv(aiBase, async () => {
      await assert.rejects(
        () => withApplyRun(identity, async () => {
          inside = currentApplyRun();
          return core.applyPatchesAllHosts(core.ALL_PATCHES, { dshHome: home });
        }),
        (error) => error.code === "DSH_PURGE_HOST_VERSION_MISMATCH",
      );
    });

    assert.deepEqual(inside, identity, "回调里读不到刚声明的身份 —— 上下文没进去");
    assert.equal(currentApplyRun(), null, "跑完还留着上下文 —— 身份会漏给下一次调用");

    const { rows, byEvent } = indexByEvent(home);
    for (const event of GATE_PATH_EVENTS) {
      const row = byEvent.get(event);
      assert.ok(row, `临时 home 里没有 ${event}：${rows.map((r) => r.event).join(", ")}`);
      assert.equal(row.entry, "command", `${event} 的 entry 不对：${row.entry}`);
      assert.equal(row.runId, runId, `${event} 的 runId 不对：${row.runId}`);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("对照：不声明身份时同一批事件一行都不带 entry 与 runId", async () => {
  const core = await import("../lib/core.js");
  const root = makeTemp("dsh-purge-identity-host-");
  const home = makeTemp("dsh-purge-identity-home-");
  try {
    const aiBase = makeMismatchedHost(root);
    await withFixtureEnv(aiBase, async () => {
      await assert.rejects(
        () => core.applyPatchesAllHosts(core.ALL_PATCHES, { dshHome: home }),
        (error) => error.code === "DSH_PURGE_HOST_VERSION_MISMATCH",
      );
    });

    const { rows, byEvent } = indexByEvent(home);
    for (const event of GATE_PATH_EVENTS) {
      const row = byEvent.get(event);
      assert.ok(row, `临时 home 里没有 ${event}：${rows.map((r) => r.event).join(", ")}`);
      // 有值就说明身份不是从上下文补的 —— 引擎自己变出了 identity，这条判据就失去了意义。
      assert.equal(row.entry, undefined, `${event} 没声明身份却带了 entry：${row.entry}`);
      assert.equal(row.runId, undefined, `${event} 没声明身份却带了 runId：${row.runId}`);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
