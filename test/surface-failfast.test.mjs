/**
 * 契约：fail-fast + 降级路径的分界。
 *
 * SURFACE-3 把「探测失败 = web」改成抛错。但**不是所有地方都该抛**：
 *
 *   该抛（业务路径）          不该抛（诊断/日志/降级路径）
 *   ─────────────────────     ──────────────────────────────
 *   detectSurface()           isDesktop()        → 返回 false
 *   adapterFor()              tryDetectSurface() → 返回 null
 *   hostAdapter()             gatherState()      → 返回 unsupported:*
 *
 * 这条分界线是 SURFACE-3 最容易搞错的地方：抛得太多会让 CLI 状态命令崩，
 * 抛得太少会退回「静默回退」的老毛病。本文件把两侧都锁住。
 */
import { test } from "node:test";
import assert from "node:assert";
import {
  SURFACE_UNSUPPORTED,
  adapterFor,
  detectSurface,
  isDesktop,
  tryDetectSurface,
} from "../lib/surface.js";

/** 一个明确不是桌面的输入。 */
const NOT_DESKTOP = { env: {}, execPath: "/usr/bin/node", argv: [] };
const FORCED_WEB = { env: { DSH_SURFACE: "web" }, execPath: "/usr/bin/node" };

test("SURFACE-3：业务路径必须抛错（detectSurface / adapterFor）", () => {
  for (const input of [NOT_DESKTOP, FORCED_WEB]) {
    assert.throws(
      () => detectSurface(input),
      (e) => e.code === SURFACE_UNSUPPORTED,
      `detectSurface(${JSON.stringify(input)}) 应抛错`,
    );
  }
  assert.throws(() => adapterFor("web"), (e) => e.code === SURFACE_UNSUPPORTED);
});

test("SURFACE-3：诊断路径不许抛错（isDesktop / tryDetectSurface）", () => {
  for (const input of [NOT_DESKTOP, FORCED_WEB]) {
    assert.doesNotThrow(() => isDesktop(input), `isDesktop(${JSON.stringify(input)}) 不该抛`);
    assert.equal(isDesktop(input), false);
    assert.doesNotThrow(
      () => tryDetectSurface(input),
      `tryDetectSurface(${JSON.stringify(input)}) 不该抛`,
    );
    assert.equal(tryDetectSurface(input), null, "探测失败应返回 null");
  }
});

test("SURFACE-3：tryDetectSurface 在桌面面返回 desktop", () => {
  assert.equal(tryDetectSurface({ env: { DSH_SURFACE: "desktop" } }), "desktop");
  assert.equal(tryDetectSurface({ env: {}, execPath: "C:/x/DSH Desktop.exe" }), "desktop");
});

test("SURFACE-3：gatherState 在非桌面进程降级，不崩", async () => {
  const core = await import("../lib/core.js");
  const previous = process.env.DSH_SURFACE;
  process.env.DSH_SURFACE = "web";
  try {
    const state = await core.gatherState();
    assert.match(
      String(state.surface),
      /^unsupported:/,
      `非桌面进程的 surface 应标成 unsupported:*，实际是 ${state.surface}`,
    );
    // 关键字段仍要给，好让人看清"为什么用不了"
    assert.ok(state.dsh_home !== undefined, "dsh_home 仍要返回");
    assert.equal(state.patches_total, 0, "非桌面进程不该有可打补丁");
  } finally {
    if (previous === undefined) delete process.env.DSH_SURFACE;
    else process.env.DSH_SURFACE = previous;
  }
});

test("SURFACE-3：sealedAsarHandoff 在非桌面进程返回 null（不是抛错）", async () => {
  const core = await import("../lib/core.js");
  assert.doesNotThrow(() => core.sealedAsarHandoff(NOT_DESKTOP));
  assert.equal(core.sealedAsarHandoff(NOT_DESKTOP), null);
});

test("SURFACE-3：desktopAsarStillSealed 在非桌面进程返回 false（不是抛错）", async () => {
  const core = await import("../lib/core.js");
  assert.doesNotThrow(() => core.desktopAsarStillSealed(NOT_DESKTOP));
  assert.equal(core.desktopAsarStillSealed(NOT_DESKTOP), false);
});

test("SURFACE-3：错误信息必须能让人看懂发生了什么", () => {
  let caught;
  try {
    detectSurface(NOT_DESKTOP);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, "应抛错");
  const message = String(caught.message);
  // 三件事都要说清楚：只支持什么、当前是什么、为什么
  assert.match(message, /只支持官方桌面端/);
  assert.match(message, /当前进程不是桌面宿主/);
  assert.match(message, /execPath=/);
  assert.match(message, /CLI 宿主面已在 1\.0\.0 移除/);
  // 不许只说"失败"而不给线索
  assert.ok(message.length > 80, "错误信息太短，定位不了问题");
});
