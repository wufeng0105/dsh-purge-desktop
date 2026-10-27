/**
 * `onMiss` 语义契约。
 *
 * 归一前「pattern 没命中算不算失败」由四个布尔字段 + 两个写死 id 的函数决定，
 * 54/86 条补丁把「没命中」当成功 —— 宿主升级后补丁静默失效，
 * 面板却显示 applied。这是全项目最危险的一条语义债。
 *
 * 归一化之后只剩一个字段，三值各有明确的、可断言的语义：
 *   fail   （缺省）没命中 = 清洗没做 = 整次 apply 失败
 *   warn   算成功，且「无残留 pattern 就算完成」（官方副本布局差异用这一支）
 *   ignore 算成功，但没残留 pattern 仍如实判 skipped（真·这一版不需要）
 *
 * 本文件锁四件事：
 *   1. 缺省值必须是 fail —— 漏写字段变成失败是**设计意图**，不是 bug
 *   2. warn / ignore 的**完成判定**差异（这是两者唯一的实质区别）
 *   3. isPatchResultSoftOk 只剩 onMiss 一个判据（strictFiles 是显式覆盖，另有测试）
 *   4. 补丁表里 warn / ignore 的实际分布（防止有人顺手把一个 ignore 改成 warn）
 */
import { test } from "node:test";
import assert from "node:assert";
import { ALL_PATCHES, onMissOf, isPatchResultSoftOk, filePatchOutcome } from "../lib/core.js";

/** 造一条最小合法补丁，避免依赖真实表项。 */
function patch(overrides = {}) {
  return {
    id: 9100,
    name: "ON_MISS_TEST",
    layer: "代码",
    desc: "test",
    file: "base",
    replacements: [{ pattern: "ORIGINAL_NEEDLE", replace: "PATCHED_NEEDLE" }],
    markers: ["PATCHED_NEEDLE"],
    ...overrides,
  };
}

test("onMiss 缺省值是 fail：没写字段 = 没命中就失败", () => {
  assert.equal(onMissOf({}), "fail");
  assert.equal(onMissOf(null), "fail");
  assert.equal(onMissOf(undefined), "fail");
  // 拼错的值也落到 fail，不静默变成「软成功」
  assert.equal(onMissOf({ onMiss: "false" }), "fail");
  assert.equal(onMissOf({ onMiss: "" }), "fail");
  assert.equal(onMissOf({ onMiss: null }), "fail");
});

test("onMiss 只认 warn / ignore 两个非缺省值", () => {
  assert.equal(onMissOf({ onMiss: "warn" }), "warn");
  assert.equal(onMissOf({ onMiss: "ignore" }), "ignore");
  assert.equal(onMissOf({ onMiss: "fail" }), "fail");
});

test("warn：pattern 对不上但无残留 pattern → 判 applied（布局差异容忍）", () => {
  // 这条输入既没有 marker（不是已应用态），也没有原始 pattern（不是待应用态）。
  // warn 组的语义是「官方副本布局不同，补丁目的已经达成」→ applied。
  const p = patch({ onMiss: "warn" });
  assert.equal(filePatchOutcome("nothing here matches", p), "applied");
});

test("ignore：pattern 对不上 → 判 skipped，不冒充 applied", () => {
  // 这是 warn 与 ignore 唯一的实质区别：ignore 不会因为「没有残留 pattern」
  // 就把对不上的文件判成已应用。两者都「算成功」，但只有 warn 改完成判定。
  const p = patch({ onMiss: "ignore" });
  assert.equal(filePatchOutcome("nothing here matches", p), "skipped");
});

test("fail：pattern 对不上 → 判 skipped 且汇总时算失败", () => {
  const p = patch(); // 缺省 fail
  assert.equal(filePatchOutcome("nothing here matches", p), "skipped");
  assert.equal(
    isPatchResultSoftOk({ status: "pattern_not_found", patch_id: p.id }, p),
    false,
    "fail 的补丁 pattern 没命中必须进 failed，不是 soft",
  );
});

test("三种 onMiss 在「已应用态」下都判 applied（marker 命中优先于 onMiss）", () => {
  for (const onMiss of ["fail", "warn", "ignore"]) {
    const p = patch({ onMiss });
    assert.equal(
      filePatchOutcome("PATCHED_NEEDLE", p),
      "applied",
      `onMiss=${onMiss} 时 marker 命中仍应判 applied`,
    );
  }
});

test("三种 onMiss 在「待应用态」下都判 pending（原文还在就必须打）", () => {
  for (const onMiss of ["fail", "warn", "ignore"]) {
    const p = patch({ onMiss });
    assert.equal(
      filePatchOutcome("ORIGINAL_NEEDLE", p),
      "pending",
      `onMiss=${onMiss} 时原文命中仍应判 pending`,
    );
  }
});

test("isPatchResultSoftOk：pattern_not_found 只由 onMiss 决定（strictFiles 除外）", () => {
  const row = (p) => ({ status: "pattern_not_found", patch_id: p.id });
  assert.equal(isPatchResultSoftOk(row(patch({ onMiss: "fail" })), patch({ onMiss: "fail" })), false);
  assert.equal(isPatchResultSoftOk(row(patch({ onMiss: "warn" })), patch({ onMiss: "warn" })), true);
  assert.equal(isPatchResultSoftOk(row(patch({ onMiss: "ignore" })), patch({ onMiss: "ignore" })), true);
  // strictFiles 是显式覆盖：即便是 warn/ignore，也钉死成失败
  assert.equal(
    isPatchResultSoftOk(row(patch({ onMiss: "warn", strictFiles: true })), patch({ onMiss: "warn", strictFiles: true })),
    false,
  );
  assert.equal(
    isPatchResultSoftOk(row(patch({ onMiss: "ignore", strictFiles: true })), patch({ onMiss: "ignore", strictFiles: true })),
    false,
  );
});

test("isPatchResultSoftOk：ALWAYS_SOFT 状态与 onMiss 无关", () => {
  // applied / already / missing_file / skipped / na / off 本来就是「能放过」的 ——
  // 它们不是「失败被放过」，而是压根没失败。这条防的是把 onMiss 误用成总开关。
  for (const status of ["applied", "already", "missing_file", "skipped", "na", "off"]) {
    assert.equal(
      isPatchResultSoftOk({ status, patch_id: 1 }, patch({ onMiss: "fail" })),
      true,
      `${status} 应始终算能放过`,
    );
  }
});

test("补丁表里 onMiss 的实际分布（改一条就要在这里改一行）", () => {
  const by = (want) => ALL_PATCHES.filter((p) => onMissOf(p) === want).map((p) => p.id);
  const warn = by("warn");
  const fail = by("fail");
  // warn 组 = 归一前的魔法 id（4/5/11/12/25/26）+ softSettle（21/48）。
  // 这 8 条是「无关文本上仍判 applied」的完整集合，characterization 快照第 5 列锁着同一件事。
  // 13 条安全策略转 fail 之后 warn 组没有变化 —— 那 13 条本来就不在 warn 组里。
  assert.deepEqual(warn.sort((a, b) => a - b), [11, 12, 21, 25, 26, 48]);
  // 38 与 45 已删，两条都是 ignore（optional 迁过来的），所以 ignore 从 43 降到 41。
  assert.equal(by("ignore").length, 31, "ignore 应为 31 条（66 条里 6 warn / 29 fail / 31 ignore）");
  // fail 是缺省值，但 13 条安全策略显式写了 onMiss:"fail"（便于 grep，也是「这条必须中」
  // 的可读标记）。数量不变：38/45 本来就不在 fail 组里。
  assert.equal(fail.length, 29, "fail 应为 29 条（66 - warn 6 - ignore 31）");
  // 13 条安全策略必须都在 fail 里，且带 strictFiles
  const STRICT = [6, 7, 13, 14, 15, 16, 17, 35, 51, 70, 92];
  for (const id of STRICT) {
    const p = ALL_PATCHES.find((x) => x.id === id);
    assert.equal(onMissOf(p), "fail", `id ${id} 必须是 onMiss:"fail"`);
    assert.equal(p.strictFiles, true, `id ${id} 必须带 strictFiles`);
  }
});
