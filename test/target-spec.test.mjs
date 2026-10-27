/**
 * 目标文件表的契约（SPEC 数据表的守卫）。
 *
 * `targetFiles()` 的 key 是补丁表 `file` 字段的唯一合法取值。这两张表分居
 * 两个文件，一旦漂移，症状是「某条补丁永远 missing_file」—— 而状态面板上
 * 那行 ✗ 看起来像「宿主没装这个包」，没人会想到是 key 拼错了。
 *
 * 收敛前这种漂移只能靠人肉对照 237 行手写体；现在有 SPEC 数据表，
 * 可以直接把「补丁引用的 key 集合」与「SPEC 登记的 key 集合」做双向断言。
 *
 * 三条断言：
 *   1. 补丁引用的每个 key 都在 SPEC 里（否则那条补丁永远是 missing_file）
 *   2. SPEC 里每个 key 都被至少一条补丁引用（否则是白跑一趟的空探测）
 *   3. 没有重复 key（重复会让后者静默覆盖前者）
 */
import { test } from "node:test";
import assert from "node:assert";
import { ALL_PATCHES } from "../lib/patch/table.js";
import { TARGET_KEYS } from "../lib/host/targets.js";

/** 补丁表里出现的全部 file key（字符串 / 数组 / 对象三种形态）。 */
function referencedKeys(patches) {
  const out = new Set();
  for (const p of patches) {
    const f = p.file;
    if (Array.isArray(f)) f.forEach((k) => out.add(k));
    else if (typeof f === "string") out.add(f);
    else if (f && typeof f === "object") Object.keys(f).forEach((k) => out.add(k));
  }
  return out;
}

test("补丁引用的每个 key 都在 SPEC 里登记", () => {
  const spec = new Set(TARGET_KEYS);
  const missing = [...referencedKeys(ALL_PATCHES)].filter((k) => !spec.has(k)).sort();
  assert.deepEqual(
    missing,
    [],
    `这些 key 被补丁引用但 SPEC 里没有 —— 对应补丁会永远 missing_file：${missing.join(", ")}`,
  );
});

// M6 删掉 16 条补丁后，这些 key 暂时失去补丁引用；宿主文件仍在（web-app / headless / hooks-* 等），
// SPEC 保留它们供诊断路径解析，key 不删。等有补丁再用时，从这里移除。
const KNOWN_UNREFERENCED = new Set(["agent-preset", "headless", "hooks-claude-code", "hooks-claude-code-nested",
  "hooks-codex", "hooks-codex-nested", "preset-acp-app", "preset-sdk-app", "web-app", "web-app-lib"]);

test("SPEC 里没有无补丁引用的死 key（已登记的空探测除外）", () => {
  const refs = referencedKeys(ALL_PATCHES);
  const dead = TARGET_KEYS.filter((k) => !refs.has(k) && !KNOWN_UNREFERENCED.has(k)).sort();
  assert.deepEqual(
    dead,
    [],
    `这些 key 在 SPEC 里但没有补丁引用 —— 每次 gatherState 都是白跑一趟的空探测：${dead.join(", ")}`,
  );
});

test("SPEC 里没有重复 key", () => {
  const seen = new Set();
  const dup = [];
  for (const k of TARGET_KEYS) {
    if (seen.has(k)) dup.push(k);
    seen.add(k);
  }
  assert.deepEqual(dup, [], `SPEC 里有重复 key（后者会静默覆盖前者）：${dup.join(", ")}`);
});
