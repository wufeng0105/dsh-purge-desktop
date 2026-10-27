/**
 * test/probe-content-outcome.test.mjs — 只读探针与产品判据同一条：`contentOutcomeOf` 就是 `patchStatus` 的逐文件口径。
 *
 * 为什么单独立一份：两个探针（`check-clean-host-sim`、`probe-host-patches`）要复算逐文件结论，
 * 原先调 `filePatchOutcome`（marker 先行）。带共享 marker 的补丁（#73 借 #70 的 marker）在它那里
 * 判 applied、在 `patchStatus` 里判 pending —— 同一份文件两个结论，探针的「复算」就不再说明问题。
 *
 * 判据三条：
 *   1. 73 形态：待删文本还在 → pending；删掉之后 → applied；每一步都与 `patchStatus` 同结论；
 *   2. 自匹配形态（#42）：应用态在两边都判 applied，不因为「pattern 还命中」被判成 pending；
 *   3. 源码级：两个探针都不许再直调 `filePatchOutcome`（判据只能有一份）。
 */
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "../lib/core.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MARKER = "// SHARED_MARKER_FOR_PROBE";
const NEEDLE_LINE = "\t* MIRROR HINT LINE.";

/** 共享 marker 的删除型补丁（#73 的形状）。 */
function removalPatch() {
  return {
    id: 910,
    name: "PROBE_REMOVAL_FIXTURE",
    layer: "提示词",
    desc: "删除型、共享 marker",
    file: "agent-loop",
    onMiss: "ignore",
    skipIfMarked: true,
    markers: [MARKER],
    replacements: [{ pattern: /\n[ \t]*\* MIRROR HINT LINE\.\n/, replace: "\n" }],
  };
}

/** 自匹配型（#42 的形状：替换产物仍以原 pattern 开头）。 */
function selfMatchPatch() {
  return {
    id: 911,
    name: "PROBE_SELFMATCH_FIXTURE",
    layer: "代码",
    desc: "自匹配替换",
    file: "agent-loop",
    skipIfMarked: true,
    replacements: [{ pattern: "\tserve(presentation) {", replace: `\tserve(presentation) { ${MARKER}` }],
    markers: [MARKER],
  };
}

function makeHost(text) {
  const aiBase = join(mkdtempSync(join(tmpdirSafe(), "wp11-probe-")), "node_modules", "@deepseek-ai");
  const dir = join(aiBase, "dsh-agent-loop", "lib");
  mkdirSync(dir, { recursive: true });
  const fp = join(dir, "index.js");
  writeFileSync(fp, text, "utf8");
  return { aiBase, fp };
}

function tmpdirSafe() {
  return process.env.TEMP || process.env.TMP || ".";
}

async function withEnv(run) {
  const previousSurface = process.env.DSH_SURFACE;
  process.env.DSH_SURFACE = "desktop";
  try {
    return await run();
  } finally {
    if (previousSurface === undefined) delete process.env.DSH_SURFACE;
    else process.env.DSH_SURFACE = previousSurface;
  }
}

test("73 形态：待删文本还在 → 探针与 patchStatus 都判 pending；删掉之后都判 applied", async () => {
  await withEnv(async () => {
    const patch = removalPatch();
    const pendingText = `${MARKER}\n${NEEDLE_LINE}\nconst x = 1;\n`;
    const pendingHost = makeHost(pendingText);
    assert.equal(
      core.contentOutcomeOf(pendingText, patch, pendingHost.fp),
      "pending",
      "还有活就是 pending —— marker 在也不许把删除型补丁判成 applied",
    );
    const pendingStatus = await core.patchStatus(pendingHost.aiBase, [patch], { identity: {} });
    assert.equal(pendingStatus[910], "pending", "与 patchStatus 同结论");

    const doneText = `${MARKER}\nconst x = 1;\n`;
    const doneHost = makeHost(doneText);
    assert.equal(core.contentOutcomeOf(doneText, patch, doneHost.fp), "applied", "活干完了就是 applied");
    const doneStatus = await core.patchStatus(doneHost.aiBase, [patch], { identity: {} });
    assert.equal(doneStatus[910], "applied", "与 patchStatus 同结论");
  });
});

test("自匹配形态：应用态两边都判 applied，不因 pattern 仍命中被判 pending", async () => {
  await withEnv(async () => {
    const patch = selfMatchPatch();
    const text = `\tserve(presentation) { ${MARKER}\n`;
    const host = makeHost(text);
    assert.equal(core.contentOutcomeOf(text, patch, host.fp), "applied", "自匹配不该被旧判据钉成 pending");
    const status = await core.patchStatus(host.aiBase, [patch], { identity: {} });
    assert.equal(status[911], "applied", "与 patchStatus 同结论");
  });
});

test("判据只有一份：两个探针都不许再直调 filePatchOutcome", () => {
  const offenders = [];
  for (const probe of ["check-clean-host-sim.mjs", "probe-host-patches.mjs"]) {
    const source = readFileSync(join(ROOT, "scripts", probe), "utf8");
    if (/\bfilePatchOutcome\s*\(/.test(source)) offenders.push(`${probe}：还在直调 filePatchOutcome`);
    if (!source.includes("contentOutcomeOf")) offenders.push(`${probe}：没接上 contentOutcomeOf`);
  }
  assert.deepEqual(offenders, [], `这些探针没有跟上产品判据：\n  ${offenders.join("\n  ")}`);
});
