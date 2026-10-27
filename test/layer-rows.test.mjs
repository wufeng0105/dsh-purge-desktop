/**
 * 分节行数据的四条判据：空层、全空、reason 透传、error 透传。
 *
 * 这些都是「渲染前就该定死」的事，所以判据放在纯函数上，不需要 DOM、不需要宿主。
 */
import { test } from "node:test";
import assert from "node:assert";

import { buildLayerRows } from "../lib/layer-rows.js";

const patch = (id, layer, status, extra = {}) => ({ id, layer, status, title: `P${id}`, ...extra });

test("A：某层 0 条时，返回数组里不含该层", () => {
  const rows = buildLayerRows({ patches: [patch(1, "提示词", "applied"), patch(6, "代码", "applied")] });
  assert.deepEqual(rows.map((r) => r.layer), ["提示词", "代码"], "0 条的工具层与兼容层都不该出现");
  assert.equal(rows.some((r) => r.layer === "工具"), false);
  assert.equal(rows.some((r) => r.layer === "兼容"), false);
});

test("B：全空时返回空数组", () => {
  assert.deepEqual(buildLayerRows({ patches: [] }), []);
  assert.deepEqual(buildLayerRows({}), []);
  assert.deepEqual(buildLayerRows(null), []);
});

test("C：跳过项的 reason 原样透传", () => {
  const rows = buildLayerRows({ patches: [patch(46, "0.1.5 兼容", "skipped", { reason: "桌面壳文件不存在" })] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].layer, "兼容");
  assert.equal(rows[0].skipped, 1);
  assert.equal(rows[0].items[0].reason, "桌面壳文件不存在");
  assert.equal("error" in rows[0].items[0], false);
});

test("D：失败项的 error 原样透传，且该层 tone 是 error", () => {
  const rows = buildLayerRows({
    patches: [patch(3, "提示词", "applied"), patch(7, "提示词", "failed", { error: "pattern_not_found: 目标文件里没有锚点" })],
  });
  const prompt = rows.find((r) => r.layer === "提示词");
  assert.equal(prompt.tone, "error");
  const bad = prompt.items.find((i) => i.id === 7);
  assert.equal(bad.tone, "error");
  assert.equal(bad.error, "pattern_not_found: 目标文件里没有锚点");
  assert.equal(prompt.hit, 1);
  assert.equal(prompt.total, 2);
});
