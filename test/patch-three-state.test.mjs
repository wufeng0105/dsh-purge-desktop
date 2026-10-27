/**
 * 契约：66 条补丁逐条三态验证（PATCH-6）。
 *
 * 补丁机的三态是：
 *   applied  —— 已生效
 *   pending  —— 还有活没干
 *   skipped  —— 原文对不上，再点应用也变不了
 *
 * 判定核心是 `filePatchOutcome`（core.js，未导出），它建立在
 * `applyReplacementsToText` 之上。本文件用后者做**逐条**验证：
 *
 *   1. 每条补丁的 markers 都能在「已应用态」下被判为 changed=false（幂等）
 *   2. 每条补丁的 pattern 在「原文态」下能真的改写出 markers
 *   3. 每条补丁在「无关键」文本下 changed=false（不会误改无关内容）
 *
 * 这是 PATCH-6 的实质：不是测「判定函数能不能跑」，而是测**每一条补丁**
 * 在自己该命中的地方命中、不该命中的地方不动。
 */
import { test } from "node:test";
import assert from "node:assert";
import { ALL_PATCHES, applyReplacementsToText } from "../lib/core.js";

/** 取出补丁的替换规则（兼容 plural / singular 两套 schema）。 */
function repsOf(patch) {
  if (Array.isArray(patch.replacements)) return patch.replacements;
  return (patch.patterns || []).map((pattern) => ({ pattern, replace: patch.replace }));
}

/** 取出补丁的 markers（兼容 plural / singular）。 */
function markersOf(patch) {
  if (Array.isArray(patch.markers)) return patch.markers;
  return patch.marker ? [patch.marker] : [];
}

/** 把 pattern 转成可读文本（正则用 source）。 */
function patternText(pattern) {
  if (pattern instanceof RegExp) return pattern.source;
  return String(pattern);
}

/** 有 markers 的补丁（PATCH-6 的验证对象）。 */
const WITH_MARKERS = ALL_PATCHES.filter((p) => markersOf(p).length > 0);
/** 无 markers 的补丁（已登记豁免，见 PATCH-2）。 */
const WITHOUT_MARKERS = ALL_PATCHES.filter((p) => markersOf(p).length === 0);

test("PATCH-6：补丁总数与分组完整（66 条）", () => {
  // 删过 28/71（86→84）、38/45（84→82），M6 内化 6 条 native + 删除 10 条 drop（82→66）。
  assert.equal(ALL_PATCHES.length, 66, "补丁总数变了，PATCH-6 的验证范围要同步");
  assert.equal(WITH_MARKERS.length, 65, "有 markers 的补丁应为 65 条");
  assert.deepEqual(
    WITHOUT_MARKERS.map((p) => p.id),
    [21],
    "无 markers 的补丁只应有 id 21（BASH_TIMEOUT_RESTORE，已登记豁免）",
  );
});

test("PATCH-6：每条有 markers 的补丁，在「已应用态」下幂等（changed=false）", () => {
  const broken = [];
  for (const patch of WITH_MARKERS) {
    const appliedText = markersOf(patch).join("\n");
    const result = applyReplacementsToText(appliedText, patch);
    if (result.changed !== false) {
      broken.push(`${patch.id}/${patch.name}`);
    }
  }
  assert.deepEqual(
    broken,
    [],
    `这些补丁在「已应用态」下仍会改写文本，重复 apply 会破坏文件：${broken.join(", ")}`,
  );
});

test("PATCH-6：每条有 markers 的补丁，至少一个 pattern 能产出 marker", () => {
  // 逐条验证：把每个字面量 pattern 的「原文」喂进去，只要**有一个**改写结果
  // 含 marker 就算这条补丁的 pattern/marker 是对得上的。
  //
  // 为什么是「至少一个」而不是「每个」：多 pattern 补丁（如 id 42 SETTINGS_LEGACY_API
  // 有 12 条替换）通常只有一条带 marker 注释，其余是配套改动。要求每条都产出
  // marker 会误报 —— 这是测试方法问题，不是补丁缺陷。
  //
  // 对正则 pattern 无法反推原文，跳过并计数（诚实声明覆盖范围）。
  const literal = [];
  const regexOnly = [];
  for (const patch of WITH_MARKERS) {
    const reps = repsOf(patch);
    const markers = markersOf(patch).map(String);
    const literalReps = reps.filter((r) => typeof r.pattern === "string");
    if (literalReps.length === 0) {
      regexOnly.push(`${patch.id}/${patch.name}`);
      continue;
    }
    let hitAny = false;
    for (const rep of literalReps) {
      const result = applyReplacementsToText(rep.pattern, patch);
      if (!result.changed) continue;
      if (markers.some((m) => String(result.text).includes(m.slice(0, 20)))) {
        hitAny = true;
        break;
      }
    }
    // markersAny 的补丁是"多选一"语义，任一条命中即可，已在上面覆盖
    if (!hitAny) literal.push(`${patch.id}/${patch.name}`);
  }
  assert.deepEqual(
    literal,
    [],
    `这些补丁的字面量 pattern 全都产不出 marker，pattern 与 marker 脱节：\n  ${literal.join("\n  ")}`,
  );
  // regexOnly 是诚实声明：正则 pattern 无法反推原文，本测试不覆盖
  assert.ok(
    regexOnly.length <= 30,
    `纯正则 pattern 的补丁有 ${regexOnly.length} 条，超过预期（说明新增了大量无法反推的补丁）`,
  );
});

test("PATCH-6：每条有 markers 的补丁，对无关文本不做改动", () => {
  const noisy = [
    "// unrelated content",
    "function foo() { return 42; }",
    "const x = 'nothing to see here';",
    "",
  ].join("\n");
  const broken = [];
  for (const patch of WITH_MARKERS) {
    const result = applyReplacementsToText(noisy, patch);
    if (result.changed) {
      broken.push(`${patch.id}/${patch.name}`);
    }
  }
  assert.deepEqual(
    broken,
    [],
    `这些补丁会误改无关文本（pattern 太宽）：${broken.join(", ")}`,
  );
});

test("PATCH-6：每条补丁的 pattern 都不为空", () => {
  const empty = [];
  for (const patch of ALL_PATCHES) {
    const reps = repsOf(patch);
    if (reps.length === 0) {
      empty.push(`${patch.id}/${patch.name}（无替换规则）`);
      continue;
    }
    for (const rep of reps) {
      const text = patternText(rep.pattern).trim();
      if (!text) empty.push(`${patch.id}/${patch.name}（pattern 为空）`);
      if (typeof rep.replace !== "string") {
        empty.push(`${patch.id}/${patch.name}（replace 不是字符串）`);
      }
    }
  }
  assert.deepEqual(empty, [], `这些补丁的替换规则不完整：\n  ${empty.join("\n  ")}`);
});

test("PATCH-6：markers 必须是非空字符串", () => {
  const bad = [];
  for (const patch of WITH_MARKERS) {
    for (const m of markersOf(patch)) {
      if (typeof m !== "string" || !m.trim()) {
        bad.push(`${patch.id}/${patch.name}`);
      }
    }
  }
  assert.deepEqual([...new Set(bad)], [], `这些补丁的 marker 非法：${[...new Set(bad)].join(", ")}`);
});

test("PATCH-4：singular schema 已清零，两套 schema 只剩 plural 一套", () => {
  // 最后 7 条（5,6,7,8,10,15,16）迁成 plural 之后，`patterns` / `replace` /
  // `marker` 这套单数写法在补丁表里不再存在。core.js 的 patchReplacements()
  // 仍保留兼容分支（有单测锁着两套 schema 等价，见 patch-outcome.test.mjs），
  // 但表里再出现 patterns 就是把已迁完的债又借回来。
  const singular = ALL_PATCHES.filter((p) => Array.isArray(p.patterns));
  assert.deepEqual(
    singular.map((p) => p.id).sort((a, b) => a - b),
    [],
    "又出现 singular schema 的补丁了",
  );
});

test("PATCH-6：三态在真实语义下可区分（applied / pending / skipped）", () => {
  // 用一条合成补丁演示三态判定，确认 applyReplacementsToText 的返回值
  // 足以支撑 filePatchOutcome 的三分：
  //   changed=false 且含 marker          → applied
  //   changed=true                       → pending（原文还在，能被改写）
  //   changed=false 且不含 marker        → skipped（对不上）
  const patch = {
    id: 9901,
    name: "B2_DEMO",
    layer: "代码",
    desc: "demo",
    file: "base",
    replacements: [{ pattern: "ORIGINAL_TEXT", replace: "PATCHED_TEXT" }],
    markers: ["PATCHED_TEXT"],
  };

  // applied：已是目标态
  const applied = applyReplacementsToText("PATCHED_TEXT", patch);
  assert.equal(applied.changed, false);
  assert.ok(applied.text.includes("PATCHED_TEXT"));

  // pending：原文还在
  const pending = applyReplacementsToText("ORIGINAL_TEXT", patch);
  assert.equal(pending.changed, true);
  assert.equal(pending.text, "PATCHED_TEXT");

  // skipped：两者都不在
  const skipped = applyReplacementsToText("SOMETHING_ELSE", patch);
  assert.equal(skipped.changed, false);
  assert.ok(!skipped.text.includes("PATCHED_TEXT"));
});
