/**
 * 补丁三态机表征测试（PATCH-6）。
 *
 * `filePatchOutcome` 是整台补丁机的判定核心：
 *   applied  —— 已生效
 *   pending  —— 还有活没干
 *   skipped  —— 原文对不上，再点应用也变不了
 *
 * 它此前没有任何测试。86 条补丁的「有没有打上」全靠它，而它自己不可测 ——
 * 这就是「失效是静默的」的机制来源（PATCH-6 的立项理由）。
 *
 * 本文件锁的是**判定逻辑**，不是**每条补丁的内容**。
 * 后者需要真实宿主文件，属于 A/B 阶段的集成测试，不在 WORKFLOW-1 范围。
 */
import { test } from "node:test";
import assert from "node:assert";
import { applyReplacementsToText, patchAppliesHere } from "../lib/core.js";

/** 造一条最小合法补丁，避免依赖真实表项。 */
function patch(overrides = {}) {
  return {
    id: 9001,
    name: "TEST_PATCH",
    layer: "代码",
    desc: "test",
    file: "base",
    replacements: [{ pattern: "OLD_NEEDLE_HERE", replace: "NEW_NEEDLE_HERE" }],
    markers: ["NEW_NEEDLE_HERE"],
    ...overrides,
  };
}

test("applied：原文命中 → 改写 + changed=true", () => {
  const result = applyReplacementsToText("before OLD_NEEDLE_HERE after", patch());
  assert.equal(result.changed, true);
  assert.equal(result.text, "before NEW_NEEDLE_HERE after");
});

test("applied：已是目标态 → changed=false，且不重复改写", () => {
  const result = applyReplacementsToText("before NEW_NEEDLE_HERE after", patch());
  assert.equal(result.changed, false, "已生效的补丁不许再改一次");
  assert.equal(result.text, "before NEW_NEEDLE_HERE after");
});

test("skipped：原文对不上 → changed=false，文本原样返回", () => {
  const input = "nothing matches here";
  const result = applyReplacementsToText(input, patch());
  assert.equal(result.changed, false);
  assert.equal(result.text, input, "没命中就不许动文件");
});

test("plural 与 singular 两种 schema 产出完全一致的结果", () => {
  const text = "before OLD_NEEDLE_HERE after";
  const plural = applyReplacementsToText(text, patch());
  const singular = applyReplacementsToText(
    text,
    patch({ replacements: undefined, patterns: ["OLD_NEEDLE_HERE"], replace: "NEW_NEEDLE_HERE", marker: "NEW_NEEDLE_HERE" }),
  );
  assert.deepEqual(
    singular,
    plural,
 "两套 schema 必须等价，否则 PATCH-4 的迁移无法保证行为不变",
  );
});

test("幂等：同一补丁连打两次，第二次 changed=false", () => {
  const once = applyReplacementsToText("x OLD_NEEDLE_HERE y", patch());
  const twice = applyReplacementsToText(once.text, patch());
  assert.equal(twice.changed, false);
  assert.equal(twice.text, once.text);
});

test("多替换：按声明顺序依次应用，后者能看到前者的结果", () => {
  const multi = patch({
    replacements: [
      { pattern: "STEP_ONE", replace: "STEP_TWO" },
      { pattern: "STEP_TWO", replace: "STEP_THREE" },
    ],
    markers: ["STEP_THREE"],
  });
  const result = applyReplacementsToText("a STEP_ONE b", multi);
  assert.equal(result.text, "a STEP_THREE b");
  assert.equal(result.changed, true);
});

test("CRLF 文件保持 CRLF（换行风格不许被补丁顺手改掉）", () => {
  const crlf = "line1\r\nOLD_NEEDLE_HERE\r\nline3\r\n";
  const result = applyReplacementsToText(crlf, patch());
  assert.equal(result.changed, true);
  assert.ok(result.text.includes("\r\n"), "CRLF 被改成了 LF");
  assert.ok(result.text.includes("NEW_NEEDLE_HERE"));
});

test("surfaces 门禁：desktop-only 补丁只在桌面面适用", () => {
  const desktopOnly = { surfaces: ["desktop"] };
  assert.equal(patchAppliesHere(desktopOnly, "desktop"), true);
 // 缺省 surfaces = 全宿主适用（PATCH-3 的缺省语义）。
 // 注意：现在非桌面面在更早的地方就会被 detectSurface 拦住，
  // 但 patchAppliesHere 是纯判定函数，仍要能对任意 surface 值给出稳定答案。
  assert.equal(patchAppliesHere({}, "desktop"), true);
  assert.equal(patchAppliesHere({ surfaces: [] }, "desktop"), true, "空数组等同缺省");
});

test("SURFACE-3：patchAppliesHere 对非桌面面返回 false（不抛错）", () => {
 // 现在 adapterFor 对非 desktop 抛错，patchAppliesHere 必须优雅降级：
  // 它是纯判定函数，问"这条补丁在 web 上适用吗"应得到 false，而不是异常。
  const desktopOnly = { surfaces: ["desktop"] };
  for (const surface of ["web", "gui", "tui"]) {
    assert.equal(
      patchAppliesHere(desktopOnly, surface),
      false,
      `desktop-only 补丁在 ${surface} 上应不适用`,
    );
    // 缺省 surfaces 的补丁对所有面都适用（它没有声明归属）
    assert.equal(patchAppliesHere({}, surface), true, `缺省补丁在 ${surface} 上应适用`);
  }
});
