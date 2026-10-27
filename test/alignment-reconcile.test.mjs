/**
 * 对齐判定的四象限：戳对不对 × 补丁在不在。
 *
 * 为什么单开一份用例：`patchesAlignmentStrict()` 要读真实宿主（`patchAlignment()` 依赖
 * `core.findAiBase()`），本机没有宿主，四象限凑不齐。判据抽成 `reconcileAlignment()` 纯函数后，
 * 这里把四种组合钉死；真机只负责验「这个函数拿到的是真数据」。
 *
 * 真机对照（2026-10-26，远端测试机）：同一个启动，戳被改成 2.0.0 而补丁全在，
 * 改动前 `patchesMatch=false / reason=stamp`，改动后 `patchesMatch=true / reason=stamp-stale`。
 */
import { test } from "node:test";
import assert from "node:assert";

import { reconcileAlignment, patchesAlignmentStrict } from "../lib/reapply.js";

const ok = { ok: true, reason: "", pending: [] };
const pending = (ids) => ({ ok: false, reason: "pending", pending: ids });

test("四象限①：戳对且实检过 → ok，reason 空", () => {
  const r = reconcileAlignment({ stampOk: true, alignment: ok });
  assert.equal(r.ok, true);
  assert.equal(r.stampOk, true);
  assert.equal(r.reason, "");
});

test("四象限②：戳旧但实检过 → ok（补丁齐就是齐），reason 标出戳旧", () => {
  const r = reconcileAlignment({ stampOk: false, alignment: ok });
  assert.equal(r.ok, true, "戳旧不等于补丁丢了；这一档若判 false，界面会与宿主实况相反");
  assert.equal(r.stampOk, false);
  assert.equal(r.reason, "stamp-stale");
});

test("四象限③：戳对但实检不过 → 不 ok，reason 用实检原因，并带出缺哪几条", () => {
  const r = reconcileAlignment({ stampOk: true, alignment: pending(["7", "63"]) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "pending");
  assert.deepEqual(r.pending, ["7", "63"]);
});

test("四象限④：戳旧且实检不过 → 不 ok，reason 归因到 stamp（先重打再说）", () => {
  const r = reconcileAlignment({ stampOk: false, alignment: pending(["7"]) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "stamp");
  assert.deepEqual(r.pending, ["7"]);
});

test("实检结论缺失（no-ai-base / 读错误）不能被当成通过", () => {
  const noBase = reconcileAlignment({ stampOk: true, alignment: { ok: false, reason: "no-ai-base", pending: [] } });
  assert.equal(noBase.ok, false);
  assert.equal(noBase.reason, "no-ai-base");
  const garbage = reconcileAlignment({ stampOk: false, alignment: null });
  assert.equal(garbage.ok, false);
  assert.equal(garbage.reason, "stamp");
});

test("pending 形状不合法时折成空数组，不把脏数据透传给日志", () => {
  const r = reconcileAlignment({ stampOk: true, alignment: { ok: false, reason: "pending", pending: "7,63" } });
  assert.equal(r.ok, false);
  assert.deepEqual(r.pending, []);
});

// ── 接线：`patchesAlignmentStrict` 把两份取数合成一个结论 ──────────────────────
//
// 为什么这两条必须存在：审计实测——把这个函数改成恒返回 `{ok:true}`，565 个用例全绿。
// 纯函数测了四象限，但**接线一行覆盖都没有**，等于「改坏它没人管」。注入两个取数入口后，
// 恒 ok 的变异会让下面第二条变红。

test("接线：戳旧 + 实检过 → ok:true，且 reason 标 stamp-stale", async () => {
  const r = await patchesAlignmentStrict({
    stampMatch: () => false,
    patchAlignment: async () => ({ ok: true, reason: "", pending: [] }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.stampOk, false);
  assert.equal(r.reason, "stamp-stale");
});

test("接线：戳旧 + 实检不过 → ok:false（恒 ok 的变异会被这条抓住）", async () => {
  const r = await patchesAlignmentStrict({
    stampMatch: () => false,
    patchAlignment: async () => ({ ok: false, reason: "pending", pending: ["7"] }),
  });
  assert.equal(r.ok, false, "实检不过必须是否决票；这里若为 true，说明接线把结论丢了");
  assert.equal(r.reason, "stamp");
  assert.deepEqual(r.pending, ["7"]);
});

test("接线：戳对 + 实检过 → ok:true 且 reason 空", async () => {
  const r = await patchesAlignmentStrict({
    stampMatch: () => true,
    patchAlignment: async () => ({ ok: true, reason: "", pending: [] }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.reason, "");
});
