/**
 * 三层汇总的判据：分类折算、分母口径、层结论的四档收敛。
 *
 * 这几条断言守的是同一件事 —— 「结论层的绿不能盖住别处的红」。
 * 所以既测单层计算，也测最差层那条聚合：一处断掉就是断掉。
 */
import { test } from "node:test";
import assert from "node:assert";

import {
  LAYER_ORDER,
  foldCompleteness,
  layerOf,
  resultOfStatus,
  summarizeLayers,
  worstLayerResult,
} from "../lib/audit/layers.js";

const patches = [
  { id: 1, name: "A", layer: "提示词" },
  { id: 2, name: "B", layer: "提示词" },
  { id: 3, name: "C", layer: "代码" },
  { id: 4, name: "D", layer: "工具" },
  { id: 5, name: "E", layer: "0.2.0 兼容" },
];

test("layerOf：只有三档归位，兼容类补丁不塞进任何一层", () => {
  assert.equal(layerOf({ layer: "提示词" }), "prompt");
  assert.equal(layerOf({ layer: "代码" }), "code");
  assert.equal(layerOf({ layer: "工具" }), "tool");
  assert.equal(layerOf({ layer: "0.2.0 兼容" }), "");
  assert.equal(layerOf({}), "");
  assert.equal(layerOf(null), "");
});

test("resultOfStatus：applied 才是 ok，pending 不算失败", () => {
  assert.equal(resultOfStatus("applied"), "ok");
  // 口径修正（本轮）：missing_file 与 off 不再算失败。缺件是「候选路径全部不存在」，
  // 那批补丁在当前宿主本来就不适用；off 是「设置里关掉的」。审计轨原先把它们记成
  // fail，与另外五处的口径相反 —— 那就是「同一个 status 六个地方六个意思」的那一半。
  assert.equal(resultOfStatus("missing_file"), "skip");
  assert.equal(resultOfStatus("off"), "skip");
  assert.equal(resultOfStatus("pattern_not_found"), "fail");
  assert.equal(resultOfStatus("pending"), "skip");
  assert.equal(resultOfStatus("skipped"), "skip");
  assert.equal(resultOfStatus(undefined), "skip");
});

test("resultOfStatus：missing_file 与 off 在审计轨是 skip —— 有 code 依据的裁定", () => {
  // 这两条的「不适用」性质各有来源：missing_file 由 onMiss 与 keyCount 决定
  // （候选路径全缺），off 是设置关掉。它们都不是「改失败了」，记成 fail 会让每一次
  // 干净的 apply 都带红，真正要追的读写失败反而被淹掉。
  for (const status of ["missing_file", "off"]) {
    assert.equal(resultOfStatus(status), "skip", `${status} 应折成 skip`);
  }
  // 对照：真失败仍是 fail，别把口径放松顺手放松到这里。
  for (const status of ["pattern_not_found", "read_error", "write_error:EACCES", "failed"]) {
    assert.equal(resultOfStatus(status), "fail", `${status} 应仍是 fail`);
  }
});

test("summarizeLayers：没判定的补丁不进分母，兼容类单独计数", () => {
  const out = summarizeLayers(patches, { 1: "applied", 2: "applied", 3: "applied", 4: "na" });
  assert.equal(out.prompt.total, 2);
  assert.equal(out.prompt.applied, 2);
  assert.equal(out.prompt.result, "ok");
  assert.equal(out.code.total, 1);
  assert.equal(out.code.result, "ok");
  // 4 是 na，3 已计入代码层 —— 工具层因此没有任何判定，不是「失败」
  assert.equal(out.tool.total, 0);
  assert.equal(out.tool.result, "skip");
  assert.equal(out.unmapped, 1, "兼容类补丁必须单独计数，不能静默丢");
});

test("summarizeLayers：一层里有一条 fail，该层就是 fail，不受其余条影响", () => {
  // 造 fail 用 pattern_not_found：missing_file 自本轮起是 skip，拿它当 fail 会把
  // 「一层里有一条 fail」测成「一条成功 + 一条跳过」。
  const out = summarizeLayers(patches, { 1: "applied", 2: "pattern_not_found" });
  assert.equal(out.prompt.applied, 1);
  assert.equal(out.prompt.failed, 1);
  assert.equal(out.prompt.result, "fail");
});

test("summarizeLayers：部分命中是 partial，全部未命中是 skip", () => {
  const partial = summarizeLayers(patches, { 1: "applied", 2: "pending" });
  assert.equal(partial.prompt.result, "partial");
  const none = summarizeLayers(patches, { 1: "pending", 2: "skipped" });
  assert.equal(none.prompt.result, "skip");
});

test("resultOfStatus：读写失败是 fail，不是 skip", () => {
  // 引擎真的会产出这两档（`lib/core.js` 的读失败分支与 `write_error:${e}`），
  // 而它们说明「这条补丁改成没改成」根本没判出来 —— 归 skip 等于把「不知道」说成「没事」。
  assert.equal(resultOfStatus("read_error"), "fail");
  assert.equal(resultOfStatus("write_error:EACCES"), "fail");
  assert.equal(resultOfStatus("write_error:Error: EPERM: operation not permitted, open 'x'"), "fail", "写失败带冒号和整段错误文本，必须按前缀判");
  assert.equal(resultOfStatus("failed"), "fail", "引擎状态排序表里最差的一档，名字就是失败");
  // 反面：不构成结论的那几档不许被顺手判死，否则每次改表都像出了事故。
  assert.equal(resultOfStatus("already"), "skip");
  assert.equal(resultOfStatus("skipped"), "skip");
  assert.equal(resultOfStatus("na"), "skip");
  assert.equal(resultOfStatus("pending"), "skip");
});

test("summarizeLayers：读错误进 failed 计数，层结论是 fail 而不是 partial", () => {
  const out = summarizeLayers(patches, { 1: "applied", 2: "read_error" });
  assert.equal(out.prompt.total, 2);
  assert.equal(out.prompt.applied, 1);
  assert.equal(out.prompt.failed, 1, "读写失败必须计进 failed");
  assert.equal(out.prompt.skipped, 0, "不许同时计进 skipped");
  assert.equal(out.prompt.result, "fail", "层内一条读写失败就是 fail，不能被另一条成功摊成 partial");

  const writeOnly = summarizeLayers(patches, { 3: "write_error:EPERM" });
  assert.equal(writeOnly.code.failed, 1);
  assert.equal(writeOnly.code.result, "fail");

  const none = summarizeLayers(patches, { 1: "skipped", 2: "na" });
  assert.equal(none.prompt.result, "skip", "全是不构成结论的档，层结论仍是 skip");
});

test("summarizeLayers：入参不是对象时不抛错，按空判定处理", () => {
  const out = summarizeLayers(patches, null);
  for (const layer of LAYER_ORDER) {
    assert.equal(out[layer].total, 0);
    assert.equal(out[layer].result, "skip");
  }
  assert.equal(summarizeLayers(null, {}).prompt.total, 0);
});

test("worstLayerResult：fail 优先，其次 partial，全 skip 记 skip", () => {
  assert.equal(worstLayerResult({ prompt: { result: "ok" }, code: { result: "fail" }, tool: { result: "ok" } }), "fail");
  assert.equal(worstLayerResult({ prompt: { result: "ok" }, code: { result: "partial" }, tool: { result: "skip" } }), "partial");
  assert.equal(worstLayerResult({ prompt: { result: "skip" }, code: { result: "skip" }, tool: { result: "skip" } }), "skip");
  assert.equal(worstLayerResult({ prompt: { result: "ok" }, code: { result: "skip" }, tool: { result: "ok" } }), "ok");
});

test("foldCompleteness：三布尔任一为假，ok / skip 压成 partial，fail 保持，缺席放行", () => {
  const allTrue = { patches: true, files: true, layers: true };
  assert.equal(foldCompleteness("ok", allTrue), "ok");
  assert.equal(foldCompleteness("fail", { patches: false, files: true, layers: true }), "fail", "fail 比 partial 更严重");
  assert.equal(foldCompleteness("ok", { patches: false, files: true, layers: true }), "partial");
  assert.equal(foldCompleteness("ok", { patches: true, files: false, layers: true }), "partial");
  assert.equal(foldCompleteness("skip", { patches: true, files: true, layers: false }), "partial", "skip 同样不许 —— 记录缺口不是「没发生」");
  assert.equal(foldCompleteness("ok", undefined), "ok", "completeness 缺席（旧调用方）时原样放行");
  assert.equal(foldCompleteness("ok", {}), "ok", "全 undefined 视为没有缺口声明，不强行降级");
});
