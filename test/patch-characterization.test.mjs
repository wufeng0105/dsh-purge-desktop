/**
 * 补丁引擎的 characterization 快照。
 *
 * 为什么需要这个文件：
 *   `test/patch-three-state.test.mjs` 验的是「判定逻辑对」—— 它断言
 *   「已应用态幂等」「pattern 能产出 marker」「无关文本不动」。这三条对
 *   **每一对输入**都成立，但完全没锁住「66 条活跃补丁在固定输入下各自判成什么」。
 *
 *   补丁表的失败语义（`onMiss`）就是在这个快照的保护下改的：把
 *   `optional` / `softSettle` / 魔法 id（4/25/26/5/11/12）收敛成单字段。
 *   没有这张快照，改完只能靠通读 3500 行补丁表自证不变。
 *
 * 快照锁三件事（每条补丁 × 三种固定输入）：
 *   1. `filePatchOutcome` 在「已应用态」（marker 文本）下判什么
 *   2. `filePatchOutcome` 在「待应用态」（原始 pattern 文本）下判什么
 *   3. `filePatchOutcome` 在「无关文本」下判什么
 *   4. `isPatchResultSoftOk(pattern_not_found)` —— 这条补丁 pattern 没命中时
 *      算不算成功（这就是「静默失效」的判据本身）
 *   5. `strictFiles` —— pattern 没命中是否被强制计入 notFound
 *
 * 为什么 4/5 也要进快照：只锁 `filePatchOutcome` 不够。13 条安全策略
 * 补丁改成 `onMiss:"fail" + strictFiles:true`，其中 46 条 optional 里只有 51/92
 * 两条例外 —— 其余 11 条的 `filePatchOutcome` 本来就不受 `optional` 影响
 * （那三个字只进 `isPatchResultSoftOk`）。只锁三态会得出「什么都没变」的错觉。
 *
 * 输入怎么造：
 *   · 已应用态 = 该补丁 `markers[]`（无 markers 的 id 21 用空串，如实记录）
 *   · 待应用态 = 该补丁第一个**字面量** pattern。纯正则 pattern 无法反推原文，
 *     记作 `-`（诚实声明，不假装覆盖）。这也是 patch-three-state 已登记的方法限制。
 *   · 无关文本 = 一段固定的、不含任何补丁片段的 JS。
 *
 * 快照文件：test/fixtures/patch-characterization.snapshot.txt
 *
 * 更新方式（只在**有意**改语义时用）：
 *   $env:DSH_PURGE_UPDATE_SNAPSHOT=1; node --test test/patch-characterization.test.mjs
 * 然后 `git diff test/fixtures/...` 逐行看 —— 改了哪几行、为什么改，要能对上是哪次改动。
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ALL_PATCHES, filePatchOutcome, isPatchResultSoftOk } from "../lib/core.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = join(HERE, "fixtures", "patch-characterization.snapshot.txt");

/** 兼容 plural / singular 两套 schema（与 core.js 的 patchReplacements 同义）。 */
function repsOf(patch) {
  if (Array.isArray(patch.replacements)) return patch.replacements;
  return (patch.patterns ?? []).map((pattern) => ({ pattern, replace: patch.replace }));
}

/** 该补丁声明过的全部 marker（markers[] 或单数 marker）。 */
function markersOf(patch) {
  if (Array.isArray(patch.markers)) return patch.markers;
  return patch.marker ? [patch.marker] : [];
}

/**
 * 「已应用态」文本：把该补丁的 markers 全放进去。
 *
 * 为什么全部放而不只放第一个：`markersAny` 的 21 条是「任一命中即算 applied」，
 * 只放第一个会把它们和「要全部命中」的补丁混为一谈。
 * 无 marker 的补丁（id 21）如实给空串 —— 空串也是真实输入，别偷偷换成别的。
 */
function appliedTextOf(patch) {
  return markersOf(patch).map(String).join("\n");
}

/**
 * 「待应用态」文本：该补丁第一个字面量 pattern。
 *
 * 纯正则 pattern 返回 null —— 无法从正则反推原文，编一个假原文会让快照
 * 锁住一个宿主上不存在的输入。
 */
function pendingTextOf(patch) {
  for (const { pattern } of repsOf(patch)) {
    if (typeof pattern === "string" && pattern.length > 0) return pattern;
  }
  return null;
}

/** 固定的无关文本：不含任何补丁片段的普通 JS。 */
const NOISE = [
  "// unrelated content",
  "function foo() { return 42; }",
  "const x = 'nothing to see here';",
  "",
].join("\n");

/** 造一行快照。列顺序即文件里的列顺序，改动会让 diff 整片变红。 */
function rowOf(patch) {
  const applied = appliedTextOf(patch);
  const pending = pendingTextOf(patch);
  const noiseOutcome = filePatchOutcome(NOISE, patch);
  const markerOutcome = filePatchOutcome(applied, patch);
  // 纯正则补丁：没有可反推的原文，标记为 "-" 而不是编一个。
  const pendingOutcome = pending === null ? "-" : filePatchOutcome(pending, patch);
  // 「pattern 没命中算不算成功」—— 静默失效的判据本身。
  const softOk = isPatchResultSoftOk({ status: "pattern_not_found", patch_id: patch.id }, patch);
  return [
    String(patch.id).padStart(3, " "),
    patch.name,
    markerOutcome,
    pendingOutcome,
    noiseOutcome,
    softOk ? "soft" : "fail",
    patch.strictFiles ? "strict" : "-",
  ].join(" | ");
}

/**
 * 尾部计数：把「静默失效的规模」也锁进快照。
 *
 * 单独列 soft 与 strict 是因为它们就是失败语义收敛的全部作用面 —— 总数变了、
 * 分布变了，diff 尾巴上一眼可见，不用逐行数补丁表。
 */
function snapshotRows(patches = ALL_PATCHES) {
  const rows = patches.map(rowOf);
  const soft = rows.filter((r) => r.split(" | ")[5] === "soft").length;
  const strict = rows.filter((r) => r.split(" | ")[6] === "strict").length;
  const noLiteral = rows.filter((r) => r.split(" | ")[3] === "-").length;
  // 无关文本上仍判 applied 的条数：这就是「补丁静默失效、面板却说已生效」的实测量。
  const appliedOnNoise = rows.filter((r) => r.split(" | ")[4] === "applied").length;
  const tail = [
    "",
    `# 合计 ${rows.length} 条`,
    `# pattern_not_found 判 soft（静默失效） ${soft} 条`,
    `# strictFiles 必中 ${strict} 条`,
    `# 无字面量 pattern（快照判不了 pending） ${noLiteral} 条`,
    `# 无关文本仍判 applied（布局软补丁） ${appliedOnNoise} 条 —— 这些 id 是：` +
      rows.filter((r) => r.split(" | ")[4] === "applied").map((r) => r.split(" | ")[0].trim()).join(", "),
  ];
  return rows.concat(tail).join("\n") + "\n";
}

const HEADER = [
  "# dsh-purge 补丁引擎 characterization 快照",
  "#",
  "# 列：id | name | 已应用态 | 待应用态 | 无关文本 | pattern_not_found 判定 | strictFiles",
  "#",
  "# 生成：test/patch-characterization.test.mjs（见文件头注释）",
  "# 更新：$env:DSH_PURGE_UPDATE_SNAPSHOT=1; node --test test/patch-characterization.test.mjs",
  "#",
  "# 这个文件是补丁引擎唯一的行为基线。改语义时它必须逐行不变 ——",
  "# 有意改的改动（改 onMiss / 改 strictFiles / 增删补丁）才允许出现差异。",
].join("\n") + "\n\n";

/**
 * 归一到 LF 再比较。
 *
 * 必须做这一步：仓库 `core.autocrlf=true`，快照文件在 Windows 检出时是 CRLF、
 * 在 CI（ubuntu）上是 LF。原样逐字符串比较会让这条测试变成「只在写它那台机器上绿」，
 * 那正是 `path-zone.test.mjs` 踩过的坑（写死 Windows 路径）。
 */
function normalize(text) {
  return String(text).replace(/\r\n/g, "\n");
}

test("快照基线：补丁表全量 × 三态 × 软成功判定 = 逐行快照不变", () => {
  const actual = normalize(HEADER + snapshotRows());
  if (process.env.DSH_PURGE_UPDATE_SNAPSHOT === "1") {
    writeFileSync(SNAPSHOT, actual, "utf8");
    console.log(`[snapshot] 写回 ${SNAPSHOT}`);
    return;
  }
  assert.ok(existsSync(SNAPSHOT), `快照文件不存在：${SNAPSHOT}。先生成：DSH_PURGE_UPDATE_SNAPSHOT=1 node --test`);
  const expected = normalize(readFileSync(SNAPSHOT, "utf8"));
  if (actual === expected) return;

  // 逐行 diff：只报真正不同的行，不甩 90 行全文。
  const a = actual.split("\n");
  const e = expected.split("\n");
  const diffs = [];
  const max = Math.max(a.length, e.length);
  for (let i = 0; i < max; i += 1) {
    if ((a[i] ?? "") === (e[i] ?? "")) continue;
    diffs.push(`  L${i + 1}\n    快照: ${e[i] ?? "（缺行）"}\n    实际: ${a[i] ?? "（缺行）"}`);
  }
  assert.fail(
    `补丁引擎行为与快照基线不同（${diffs.length} 行）。\n` +
      `如果这不是有意改的，说明语义被改坏了：\n${diffs.join("\n")}\n\n` +
      `如果是有意改的（改 onMiss / 改 strictFiles / 增删补丁），用\n` +
      `DSH_PURGE_UPDATE_SNAPSHOT=1 重生成并 review 每一行。`,
  );
});

test("快照基线：快照覆盖全部补丁，且顺序与 ALL_PATCHES 一致", () => {
  // 防「快照被写成手挑的子集」：行数与 id 序列必须与补丁表逐条对齐。
  const rows = snapshotRows().split("\n").filter((l) => /^\s*\d+ \| /.test(l));
  assert.equal(rows.length, ALL_PATCHES.length, "快照行数与补丁总数不一致");
  const ids = rows.map((l) => Number(l.trim().split(" | ")[0]));
  assert.deepEqual(ids, ALL_PATCHES.map((p) => p.id), "快照的 id 顺序与 ALL_PATCHES 不一致");
});
