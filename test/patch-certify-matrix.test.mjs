/**
 * test/patch-certify-matrix.test.mjs — 认证矩阵九行：谁有资格说「这一版表已生效」。
 *
 * 为什么单独立一份：三次真机缺陷（自匹配假红、共享 marker 短路、already 永不被认证）长在同一个
 * 接缝上，而每次修法都只动一处 —— 修完那一处，另外几格没有判据在看着。于是「改一格」这件事
 * 没有任何症状：判据还是绿的，只是结论悄悄变成了第四种形态。这里把草案里那张表逐行钉住：
 * 一行一条用例，名子写清输入组合；表本体在 `docs/状态层契约.md` 的认证矩阵一节，
 * 本文件的 `MATRIX` 与那张表**逐格**比对，表与用例漂了就红。
 *
 * 判据只有一处实现：`lib/core.js` 的 `contentOutcomeOf` —— 逐文件结论的唯一出口
 * （状态侧与两个只读探针都调它）。用例不碰私有函数，也不自己复述状态机。
 *
 * 一句话读法：**marker 只是原料，`written` 说「这一版表写过它」，`settled` 说「核对时它就在目标态」**。
 * 前者能消化本轮 dry-run 找到的活，后者不能。
 */
import { test } from "node:test";
import assert from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import * as core from "../lib/core.js";
import { fileContentKey, patchFingerprints, tableFingerprint } from "../lib/patch/table-fingerprint.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const CONTRACT_DOC = path.join(ROOT, "docs", "状态层契约.md");

const PATCH_ID = 903;
const MARKER = "CERTIFY_MATRIX_MARKER";
const NEEDLE = "const CERTIFY_SOURCE = 0;";
const BODY = `const CERTIFY_TARGET = 1; // ${MARKER}`;
/** 目标文件路径：矩阵只判内容与账本，文件不必真的存在（`contentOutcomeOf` 收文本）。 */
const TARGET = path.join(ROOT, "node_modules", "@deepseek-ai", "dsh-agent-loop", "lib", "index.js");

/**
 * 九行矩阵。列与文档那张表一一对应：
 *   `marker`        文件里有没有这条补丁的 marker
 *   `dryRunWorked`  **本轮 apply** 的 dry-run 会不会改文本
 *   `ledger`        账本认证：none / written / settled / legacy（旧账本，两半见 `runRow`）
 *   `expected`      期望的逐文件结论
 * `doc*` 三列是文档里那一格的原文，用来做「表与用例漂了要红」的比对。
 */
const MATRIX = [
  {
    n: 1,
    title: "marker 否 + dry-run 有改动 + 账本无认证 → pending（原文还在，有活）",
    marker: false,
    dryRunWorked: true,
    ledger: "none",
    expected: "pending",
    docMarker: "否",
    docDryRun: "是",
    docLedger: "无",
    docExpected: "pending",
  },
  {
    n: 2,
    title: "marker 否 + dry-run 无改动 + 账本无认证 → skipped（点了也没有动作）",
    marker: false,
    dryRunWorked: false,
    ledger: "none",
    expected: "skipped",
    docMarker: "否",
    docDryRun: "否",
    docLedger: "无",
    docExpected: "skipped",
  },
  {
    n: 3,
    title: "marker 是 + dry-run 有改动 + 账本无认证 → pending（marker 不证明活干完）",
    marker: true,
    dryRunWorked: true,
    ledger: "none",
    expected: "pending",
    docMarker: "是",
    docDryRun: "是",
    docLedger: "无",
    docExpected: "pending",
  },
  {
    n: 4,
    title: "marker 是 + dry-run 有改动 + written → applied（这一版表写过，且不再有差）",
    marker: true,
    dryRunWorked: true,
    ledger: "written",
    expected: "applied",
    docMarker: "是",
    docDryRun: "是",
    docLedger: "written",
    docExpected: "applied",
  },
  {
    n: 5,
    title: "marker 是 + dry-run 无改动 + written → applied（正常已应用）",
    marker: true,
    dryRunWorked: false,
    ledger: "written",
    expected: "applied",
    docMarker: "是",
    docDryRun: "否",
    docLedger: "written",
    docExpected: "applied",
  },
  {
    n: 6,
    title: "marker 是 + dry-run 无改动 + settled → applied（already 型：早期就在目标态）",
    marker: true,
    dryRunWorked: false,
    ledger: "settled",
    expected: "applied",
    docMarker: "是",
    docDryRun: "否",
    docLedger: "settled",
    docExpected: "applied",
  },
  {
    n: 7,
    title: "marker 是 + dry-run 无改动 + 旧账本 → applied（未迁移，放行一次）/ pending（迁移后）",
    marker: true,
    dryRunWorked: false,
    ledger: "legacy",
    expected: ["applied", "pending"],
    docMarker: "是",
    docDryRun: "否",
    docLedger: "无（旧账本 / 无指纹）",
    docExpected: "applied（一次迁移）或 pending（迁移后）",
  },
  {
    n: 8,
    title: "marker 是 + dry-run 有改动 + settled → pending（settled 不许盖住新差）",
    marker: true,
    dryRunWorked: true,
    ledger: "settled",
    expected: "pending",
    docMarker: "是",
    docDryRun: "是",
    docLedger: "settled",
    docExpected: "pending",
  },
  {
    // 第九行是账本兼容路径：WP10→WP11 之间写下的账本没有 `patchesSettled`，那一版表既没记
    // 「写过」也没记「核对过」，但逐条指纹是在的。于是内容自证（指纹一致 + marker 在 + 再点也不改）
    // 就是唯一的认证原料 —— `patchCertifiedByContent` 专门接这一档，否则升级之后的第一次启动
    // 会把这类补丁全报成 pending。它与第 7 行的旧账本档不是一回事：那一档连指纹都没有。
    n: 9,
    title: "marker 是 + dry-run 无改动 + 表指纹一致、两清单都不含 → applied（账本兼容路径）",
    marker: true,
    dryRunWorked: false,
    ledger: "fingerprint",
    expected: "applied",
    docMarker: "是",
    docDryRun: "否",
    docLedger: "无（表指纹一致）",
    docExpected: "applied",
  },
];

/** 补丁：marker 与替换正文分开写，正文换代时 marker 不变。 */
function patchOf() {
  return {
    id: PATCH_ID,
    name: "CERTIFY_MATRIX_FIXTURE",
    layer: "代码",
    desc: "认证矩阵夹具",
    file: "agent-loop",
    replacements: [{ pattern: NEEDLE, replace: BODY }],
    markers: [MARKER],
  };
}

/**
 * 状态侧「还有活」= 本轮 dry-run 找到的活**没有被 written 消化**。
 *
 * 这一句是矩阵两列之间的桥：第 4 行与第 3、8 行的唯一差别就是它。
 * `settled` 不消化活 —— 它只说核对那一刻在目标态。
 */
function workedAtStatus(row) {
  return row.dryRunWorked && row.ledger !== "written";
}

/** 现场文本：有活就得留着原文；没活但有 marker 就是目标态；都没命中就是一条无关文件。 */
function textOf(row) {
  if (workedAtStatus(row)) return row.marker ? `// ${MARKER}\n${NEEDLE}\n` : `${NEEDLE}\n`;
  if (row.marker) return `${BODY}\n`;
  return "// unrelated file: 这条补丁在这个文件上没有痕迹\n";
}

function sha256Of(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/**
 * 账本。四条认证档各给一份；`content` 决定内容指纹表里有没有这份文件
 * （有且匹配 = 真写过这一版字节；没有 = 多宿主 / 密封宿主没记上，不该被当成否证）。
 *
 * `fingerprint` 一档（第 9 行）：逐条指纹在、两个清单都不含 —— 只有内容自证能认证它。
 */
function identityOf(row, { legacy = "unmigrated", content = "recorded" } = {}) {
  const patch = patchOf();
  const base = { version: "2.1.0", sha: "fixture-rev" };
  if (row.ledger === "legacy") {
    return legacy === "unmigrated"
      ? base
      : { ...base, migratedAt: "2026-10-26T00:00:00.000Z" };
  }
  const identity = {
    ...base,
    tableSha: tableFingerprint([patch]),
    patchShas: patchFingerprints([patch]),
    contentSha: {},
  };
  if (row.ledger === "written") identity.patchesWritten = [String(PATCH_ID)];
  if (row.ledger === "settled") identity.patchesSettled = [String(PATCH_ID)];
  if (content === "recorded") identity.contentSha[fileContentKey(TARGET)] = sha256Of(textOf(row));
  return identity;
}

/** 跑一行：逐文件结论走真实出口。 */
function outcomeOf(row, options) {
  return core.contentOutcomeOf(textOf(row), patchOf(), TARGET, identityOf(row, options));
}

// ── 九行逐行断言 ──────────────────────────────────────────────────────────────

for (const row of MATRIX) {
  test(`认证矩阵第 ${row.n} 行：${row.title}`, () => {
    const patch = patchOf();
    if (row.ledger === "legacy") {
      // 旧账本一行两半：未迁移放行一次（否则升级后第一次启动会把全表报成要重打），
      // 迁移写了 `migratedAt` 之后走真判据 —— 同一个现场，两种结论，必须都成立。
      assert.equal(
        outcomeOf(row, { legacy: "unmigrated" }),
        "applied",
        "旧账本（未迁移）：逐补丁指纹整份缺失时按痕量放行一次",
      );
      assert.equal(
        outcomeOf(row, { legacy: "migrated" }),
        "pending",
        "旧账本（已迁移）：指纹补写之后没有认证原料，marker 不能单独当证据",
      );
      return;
    }
    assert.ok(
      patch && textOf(row).includes(MARKER) === row.marker,
      "夹具不符：现场文本与 marker 那一列对不上（以后改夹具先看这条）",
    );
    assert.equal(outcomeOf(row), row.expected, `第 ${row.n} 行的结论被改了：${row.title}`);
  });
}

/** 内容指纹的两档：记过且匹配不许否证；没记过不许平白判 pending（第 4、5 行的分工就落在这里）。 */
test("认证矩阵：内容指纹记过且匹配不否证，没记过也不平白否证", () => {
  const row = MATRIX.find((item) => item.n === 4);
  assert.equal(outcomeOf(row, { content: "recorded" }), "applied", "字节就是这一版写的，不该被内容层否掉");
  assert.equal(outcomeOf(row, { content: "absent" }), "applied", "账本没记这份文件的内容指纹，不是「字节变了」");
});

// ── 表与用例一一对应 ──────────────────────────────────────────────────────────

/** 文档里「认证矩阵」那一节的表格数据行（表头与分隔行丢掉）。 */
function documentedMatrix() {
  const text = readFileSync(CONTRACT_DOC, "utf8");
  const at = text.indexOf("## 12. 认证矩阵");
  assert.ok(at >= 0, "docs/状态层契约.md 里没有「认证矩阵」那一节 —— 表是判据的一部分，不能在别处只写一半");
  const rest = text.slice(at);
  const next = rest.indexOf("\n## ", 1);
  const section = next >= 0 ? rest.slice(0, next) : rest;
  const rows = [];
  for (const line of section.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) {
      rows.pop();
      continue;
    }
    if (cells.length >= 6) rows.push(cells);
  }
  return rows;
}

test("表与用例一一对应：九行、逐格相同，多一行少一行改一格都红", () => {
  const rows = documentedMatrix();
  assert.equal(rows.length, MATRIX.length, `文档表有 ${rows.length} 行，用例有 ${MATRIX.length} 行`);
  const problems = [];
  MATRIX.forEach((expectedRow, index) => {
    const cells = rows[index];
    const [n, marker, dryRun, ledger, conclusion] = cells;
    if (n !== String(expectedRow.n)) problems.push(`第 ${index + 1} 行编号是 ${n}，用例是 ${expectedRow.n}`);
    if (marker !== expectedRow.docMarker) problems.push(`第 ${expectedRow.n} 行 marker 列：文档「${marker}」/ 用例「${expectedRow.docMarker}」`);
    if (dryRun !== expectedRow.docDryRun) problems.push(`第 ${expectedRow.n} 行 dry-run 列：文档「${dryRun}」/ 用例「${expectedRow.docDryRun}」`);
    if (ledger !== expectedRow.docLedger) problems.push(`第 ${expectedRow.n} 行认证列：文档「${ledger}」/ 用例「${expectedRow.docLedger}」`);
    if (conclusion !== expectedRow.docExpected) problems.push(`第 ${expectedRow.n} 行结论列：文档「${conclusion}」/ 用例「${expectedRow.docExpected}」`);
  });
  assert.deepEqual(problems, [], `契约文档与矩阵用例漂了：\n  ${problems.join("\n  ")}`);
});

