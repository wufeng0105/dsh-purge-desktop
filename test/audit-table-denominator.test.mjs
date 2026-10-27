/**
 * test/audit-table-denominator.test.mjs — 完整性的分母来自**补丁表**，不是落账方自己算的 `considered`。
 *
 * 为什么单独立一份：真机上出现过「66 条只覆盖 63 条、缺的三条既不在 unresolved 也不在 exempt，
 * 而所有判据都是绿的」。根因不是漏算，是分母自我指涉 —— `considered` 是落账方「我折进来了这几条」
 * 的声明，它漏算的时候自己也不知道，拿它当分母的复算当然抓不到。
 *
 * 这里锁三件事：
 *   一、**红灯**：一组声称 `completeness.patches=true` 的层结论，把 40/47/49 交代掉之前，
 *       `audit check` 必须红并**点名这三个 id** —— 分母不在它们那边，它们才点得出来；
 *   二、**不误报**：交代过（`detail.table.unmapped`）之后同一份日志必须绿；
 *   三、**结构**：`audit check` 的源码里，分母那一处读的是补丁表，不是 `detail.considered`。
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runAuditCli } from "../lib/audit/index.js";
import { summarizeRuns } from "../lib/audit/runs.js";
import { ALL_PATCHES } from "../lib/patch/table.js";
import { LAYER_ORDER, layerOf } from "../lib/audit/layers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TS = "2026-10-26T10:00:00.000+08:00";
const RUN = "apply-20261026T020000Z-table";
const RID = "9f2c1d34-5a6b-4c7d-8e90-0a1b2c3d4e5f";
const DIGEST = { sha256: "c".repeat(64), bytes: 20 };

/** 补丁表按层分好：三层各一组 id，外加「没有层」的那一组（兼容类）。 */
function tableByLayer() {
  const buckets = { prompt: [], code: [], tool: [], unmapped: [] };
  for (const patch of ALL_PATCHES) {
    if (patch.auditExempt === true) continue;
    const layer = layerOf(patch);
    if (layer === "") buckets.unmapped.push(String(patch.id));
    else buckets[layer].push(String(patch.id));
  }
  return buckets;
}

const BUCKETS = tableByLayer();

function fileRow(seq, layer, patchId) {
  return {
    ts: TS,
    seq,
    recordId: RID,
    runId: RUN,
    observedTs: TS,
    event: `${layer}.patch-applied`,
    result: "ok",
    layer,
    actor: "host",
    entry: "http",
    target: `补丁${patchId}`,
    evidence: { file: "app.js", marker: "M", hits: 1, bytes: 20, before: DIGEST, after: DIGEST },
    detail: { patchId: Number(patchId), status: "applied" },
  };
}

/**
 * 造一轮「三层都记全了」的审计：文件行 + 结论，末条结论盖章。
 *
 * @param {{unmapped?:string[], declared?:boolean}} [options] `unmapped` 是写进 detail.table 的
 *   声明；`declared=false` 表示不写 detail.table（老口径形态）。
 */
function fullRun({ unmapped = BUCKETS.unmapped, declared = true } = {}) {
  const rows = [];
  let seq = 0;
  let last = "";
  for (const layer of LAYER_ORDER) {
    const ids = BUCKETS[layer];
    for (const id of ids) rows.push(fileRow(seq++, layer, id));
    last = layer;
  }
  for (const layer of LAYER_ORDER) {
    const ids = BUCKETS[layer];
    rows.push({
      ts: TS,
      seq: seq++,
      recordId: RID,
      runId: RUN,
      observedTs: TS,
      event: `${layer}.apply-result`,
      result: "ok",
      layer,
      actor: "host",
      entry: "http",
      target: layer,
      evidence: { refSeq: Math.max(0, seq - 3), quote: `${layer}.patch-applied` },
      detail: {
        applied: ids.length,
        failed: 0,
        skipped: 0,
        unresolved: [],
        exempt: [],
        completeness: { patches: true, files: true, layers: true },
        considered: ids,
        expectedRows: ids.length,
        ...(layer === last
          ? {
            runEnd: true,
            ...(declared ? {
              table: {
                total: ALL_PATCHES.length,
                exempt: ALL_PATCHES.filter((p) => p.auditExempt === true).map((p) => String(p.id)),
                unmapped,
                recorded: BUCKETS.prompt.length + BUCKETS.code.length + BUCKETS.tool.length,
              },
            } : {}),
          }
          : {}),
      },
    });
  }
  return rows;
}

/**
 * 造一轮**过滤 apply**：补丁表全量 66 条，这一轮只选中 `present` 里的那几条。
 *
 * `tableSelected` 与 `present` 分开给：前者是写侧声明的「这一轮 report 里出现过」，
 * 后者是真有文件行的。两者不一致，就是 selected 里的缺口 —— 判据要点名。
 */
function filteredRun({ present, tableSelected, recorded }) {
  const byLayer = new Map(LAYER_ORDER.map((layer) => [layer, []]));
  for (const id of present) {
    const patch = ALL_PATCHES.find((item) => String(item.id) === String(id));
    const layer = patch ? layerOf(patch) : "";
    if (layer) byLayer.get(layer).push(String(id));
  }
  const layers = LAYER_ORDER.filter((layer) => byLayer.get(layer).length > 0);
  const rows = [];
  let seq = 0;
  for (const layer of layers) {
    for (const id of byLayer.get(layer)) rows.push(fileRow(seq++, layer, id));
  }
  const last = layers[layers.length - 1];
  for (const layer of layers) {
    const ids = byLayer.get(layer);
    rows.push({
      ts: TS,
      seq: seq++,
      recordId: RID,
      runId: RUN,
      observedTs: TS,
      event: `${layer}.apply-result`,
      result: "partial",
      layer,
      actor: "host",
      entry: "http",
      target: layer,
      evidence: { refSeq: Math.max(0, seq - 3), quote: `${layer}.patch-applied` },
      detail: {
        applied: ids.length,
        failed: 0,
        skipped: 0,
        unresolved: [],
        exempt: [],
        completeness: { patches: true, files: true, layers: false },
        considered: ids,
        expectedRows: ids.length,
        partialReason: "record",
        ...(layer === last
          ? {
            runEnd: true,
            table: {
              total: ALL_PATCHES.length,
              exempt: ALL_PATCHES.filter((p) => p.auditExempt === true).map((p) => String(p.id)),
              unmapped: BUCKETS.unmapped,
              selected: tableSelected,
              recorded,
            },
          }
          : {}),
      },
    });
  }
  return rows;
}

function runAudit(argv) {
  const out = [];
  const err = [];
  const code = runAuditCli(argv, { out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out, err, text: out.join("\n") };
}

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-purge-table-den-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeJsonl(file, rows) {
  writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  return file;
}

test("补丁表的三条兼容类补丁（无层）在这张表里，且不在三层任何一组里", () => {
  // 判据本身的前提：40/47/49 确实没有层。它们不在这三组里，就说明「层结论」结构上记不下它们。
  assert.deepEqual(BUCKETS.unmapped, ["40", "47", "49"]);
  assert.equal(ALL_PATCHES.length, 66);
});

test("红灯：交代 40/47/49 之前，completeness.patches 声称记全了也必须红，并点名这三个 id", () => {
  withDir((dir) => {
    // 声明里故意把 unmapped 留空 —— 这正是「落账方自己算的分母」能写出的形态：
    // 三层 considered 都是全的，completeness 三项也全真，缺口却不在这套账里。
    const file = writeJsonl(join(dir, "2026-10-26.jsonl"), fullRun({ unmapped: [] }));
    const summary = summarizeRuns(fullRun({ unmapped: [] }), { patches: ALL_PATCHES });
    assert.equal(summary.runs[0].sealed, true, "这一轮的收尾没问题，红的应当是分母");
    assert.equal(summary.runs[0].closed, false);
    assert.deepEqual(summary.runs[0].gap, ["40", "47", "49"], "缺口必须正好是这三条");
    for (const id of ["40", "47", "49"]) {
      assert.ok(
        summary.problems.some((line) => line.includes("补丁表里有") && line.includes(id)),
        `没有点名补丁 ${id}：\n${summary.problems.join("\n")}`,
      );
    }

    const cli = runAudit(["check", "--jsonl", file]);
    assert.equal(cli.code, 1, "有缺口必须落到退出码 1");
    assert.match(cli.text, /40,47,49/, "输出里必须点名这三个 id");
  });
});

test("不误报：交代了 unmapped 之后，同一份日志是绿的", () => {
  withDir((dir) => {
    const file = writeJsonl(join(dir, "2026-10-26.jsonl"), fullRun());
    const summary = summarizeRuns(fullRun(), { patches: ALL_PATCHES });
    assert.deepEqual(summary.problems, [], summary.problems.join("\n"));
    assert.deepEqual(summary.runs[0].gap, []);
    assert.equal(summary.runs[0].closed, true);
    assert.ok(
      summary.notes.some((line) => line.includes("无 selected，按全表判")),
      `没有 selected 的日志必须说清这一档按全表判：\n${summary.notes.join("\n")}`,
    );

    const cli = runAudit(["check", "--jsonl", file]);
    assert.equal(cli.code, 0, cli.text);
  });
});

test("过滤 apply：分母是 selected 里去掉 exempt / unmapped 的 id，不是补丁表全量", () => {
  const present = [BUCKETS.prompt[0], BUCKETS.code[0]];
  const summary = summarizeRuns(filteredRun({ present, tableSelected: present, recorded: 2 }), {
    patches: ALL_PATCHES,
  });
  assert.deepEqual(summary.problems, [], `合法过滤轮被判红了：\n${summary.problems.join("\n")}`);
  assert.deepEqual(summary.runs[0].gap, [], "没选中的 64 条不该进缺口");
  assert.equal(summary.runs[0].closed, true);
});

test("过滤 apply：selected 里点名了却没有文件行，仍是缺口并指出那个 id", () => {
  const present = [BUCKETS.prompt[0], BUCKETS.code[0]];
  const summary = summarizeRuns(filteredRun({
    present,
    tableSelected: [...present, BUCKETS.tool[0]],
    recorded: present.length,
  }), { patches: ALL_PATCHES });
  assert.equal(summary.runs[0].closed, false);
  assert.deepEqual(summary.runs[0].gap, [BUCKETS.tool[0]], "缺口只许是 selected 里少的那一条");
  assert.ok(
    summary.problems.some((line) => line.includes("selected 里有") && line.includes(BUCKETS.tool[0])),
    `没点名 selected 里缺的补丁：\n${summary.problems.join("\n")}`,
  );
});

test("声明不许用来删分母：把有层的补丁记成 unmapped 直接判红", () => {
  const rows = fullRun({ unmapped: ["40", "47", "49", "1"] });
  const summary = summarizeRuns(rows, { patches: ALL_PATCHES });
  assert.equal(summary.runs[0].closed, false);
  assert.ok(
    summary.problems.some((line) => line.includes("detail.table.unmapped 列了补丁 1")),
    `没有指出有层补丁被塞进 unmapped：\n${summary.problems.join("\n")}`,
  );
});

test("老口径（没有 detail.table）不判红，但缺口照样点名", () => {
  const rows = fullRun({ declared: false });
  const summary = summarizeRuns(rows, { patches: ALL_PATCHES });
  assert.deepEqual(summary.problems, [], "判据没依据时报红等于报假");
  assert.ok(
    summary.notes.some((line) => line.includes("40,47,49") || line.includes("40")),
    `老口径也要把缺口说出来：\n${summary.notes.join("\n")}`,
  );
});

test("结构判据：分母那一处读的是补丁表，不是 detail.considered", () => {
  const check = fs.readFileSync(path.join(ROOT, "lib", "audit", "check.js"), "utf8");
  assert.match(check, /import\s*\{\s*ALL_PATCHES\s*\}\s*from\s*"\.\.\/patch\/table\.js"/, "audit check 必须直接读补丁表");
  assert.match(check, /summarizeRuns\([^)]*\{\s*patches:\s*ALL_PATCHES\s*\}/, "补丁表必须真的喂给判据");

  const runs = fs.readFileSync(path.join(ROOT, "lib", "audit", "runs.js"), "utf8");
  const start = runs.indexOf("function verifyAgainstTable");
  const end = runs.indexOf("function layerIdUnion");
  assert.ok(start > 0 && end > start, "找不到 verifyAgainstTable 的实现区间");
  const body = runs.slice(start, end);
  assert.ok(body.includes("patchIds"), "分母核对要读文件行");
  assert.ok(body.includes("await") === false, "分母核对是纯函数");
  assert.equal(
    /detail\.considered|\.considered\b/.test(body),
    false,
    "分母核对里不许出现 considered：它是落账方自己算的那一栏",
  );
});
