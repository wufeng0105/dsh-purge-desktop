/**
 * test/patch-already-certified.test.mjs — 「核对过在目标态」也是认证的一半。
 *
 * 为什么单独立一份：远端第二轮 apply 之后 `patchesWritten` 只有 61 条，#2 / #3 / #50 这一轮
 * 是 `already`（文件早就在目标态、marker 在、没有可写的字节），于是它们从来不进写入清单；
 * 而 `patchTableTrusted` 要求「这一版表写过它」→ 三条永远不被认证 → 永远 pending →
 * `ensure` 永不为真 → 每次启动全量 revert+reapply。这与 WP2 修掉的「戳变成新 marker」同族，
 * 只是这回落在「写入清单只收写过的不收核对过的」。
 *
 * 判据四条：
 *   1. 红灯（目标态）：marker 在、dry-run 无改动、本轮无写入 → 认证后必须 applied；
 *   2. 反例：marker 在但 dry-run 有改动 → 不许算认证，仍 pending；
 *   3. 旧账本回落：缺 `patchesSettled` 时只认 `patchesWritten`，不许抛错也不许放宽；
 *   4. 内容指纹不回退：认证只进清单，`contentSha` 仍只记真写过的文件（WP2 的教训）。
 */
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "../lib/core.js";
import { markPatchesApplied } from "../lib/reapply.js";
import { fileContentKey, patchFingerprints, tableFingerprint } from "../lib/patch/table-fingerprint.js";

const PATCH_ID = 907;
const MARKER = "// ALREADY_CERTIFIED_MARKER";
const NEEDLE = "const LEGACY_BANNER = 1;";
const PATCHED = `const LEGACY_BANNER = 2; ${MARKER}`;

/** #2 / #3 / #50 的形状：单文件、普通替换、marker 在、打完不留残差。 */
function patchOf(overrides = {}) {
  return {
    id: PATCH_ID,
    name: "ALREADY_CERTIFIED_FIXTURE",
    layer: "代码",
    desc: "already 认证夹具",
    file: "agent-loop",
    replacements: [{ pattern: NEEDLE, replace: PATCHED }],
    markers: [MARKER],
    ...overrides,
  };
}

function makeHost(text) {
  const aiBase = join(mkdtempSync(join(tmpdir(), "wp11-already-")), "node_modules", "@deepseek-ai");
  const dir = join(aiBase, "dsh-agent-loop", "lib");
  mkdirSync(dir, { recursive: true });
  const fp = join(dir, "index.js");
  writeFileSync(fp, text, "utf8");
  return { aiBase, fp };
}

/** 账本：表没换（指纹对得上）、但这一版表**没写过**它 —— 远端 2/3/50 的处境。 */
function identityWithoutWrite(patch, extra = {}) {
  return {
    version: "2.1.0",
    sha: "fixture-rev",
    tableSha: tableFingerprint([patch]),
    patchShas: patchFingerprints([patch]),
    patchesWritten: [],
    contentSha: {},
    ...extra,
  };
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

test("红灯：marker 在、无改动、本轮无写入 → 本轮证据必须让它 applied", async () => {
  await withEnv(async () => {
    const patch = patchOf();
    const { aiBase } = makeHost(`${PATCHED}\n`);
    const ledger = identityWithoutWrite(patch);
    // 修前：账本没写过它 → tableTrusted=false → 永远 pending（远端 2/3/50 的现场）。
    const beforeFix = await core.patchStatus(aiBase, [patch], { identity: ledger });
    assert.equal(beforeFix[PATCH_ID], "pending", "旧口径只认写入清单，这一档就是 pending");

    // 修后：这一轮 apply 产出「核对过在目标态」的证据，判据按「账本 + 本轮证据」读。
    // 这正是 ensureHostClean 的读法：账本要等这次判完才写，只按旧账本读永远读不到这一半。
    const report = await core.applyPatches(aiBase, [patch], { identity: ledger });
    const evidence = core.collectApplyEvidence([{ report }]);
    assert.deepEqual(evidence.patchesSettled, [String(PATCH_ID)], "already 的一轮必须留下核对证据");
    const withEvidence = await core.patchStatus(aiBase, [patch], {
      identity: { ...ledger, patchesSettled: evidence.patchesSettled },
    });
    assert.equal(withEvidence[PATCH_ID], "applied", "核对过在目标态也算认证的一半");

    // 写下账本之后（下一轮）同样成立：核对清单是持久证据。
    const persisted = await core.patchStatus(aiBase, [patch], {
      identity: identityWithoutWrite(patch, { patchesSettled: [String(PATCH_ID)] }),
    });
    assert.equal(persisted[PATCH_ID], "applied", "账本里的核对清单必须被认");
  });
});

test("边界：核对清单不是免检通行证 —— marker 不在时仍判 skipped", async () => {
  await withEnv(async () => {
    const patch = patchOf();
    const { aiBase } = makeHost(`${PATCHED.split(MARKER).join("")}\n`);
    // 判据次序没有动：没有 marker 的文件在这一条补丁上是「没有痕迹」，
    // 核对清单只能证明「这一版表核对过它」，不能替一份没有痕迹的文件编出痕迹。
    const withoutList = await core.patchStatus(aiBase, [patch], { identity: identityWithoutWrite(patch) });
    assert.equal(withoutList[PATCH_ID], "skipped", "没有 marker、没有核对清单：这一版不需要它");

    const withList = await core.patchStatus(aiBase, [patch], {
      identity: identityWithoutWrite(patch, { patchesSettled: [String(PATCH_ID)] }),
    });
    assert.equal(withList[PATCH_ID], "skipped", "核对清单不改判据次序：marker 那一关过不了就是 skipped");
  });
});

test("反例：marker 在但 dry-run 有改动 → 不许算认证，仍 pending", async () => {
  await withEnv(async () => {
    const patch = patchOf();
    // 已应用态里再塞一条残留原文：marker 在，但活真的还在。
    const { aiBase } = makeHost(`${PATCHED}\n${NEEDLE}\n`);
    const status = await core.patchStatus(aiBase, [patch], {
      identity: identityWithoutWrite(patch, { patchesSettled: [String(PATCH_ID)] }),
    });
    assert.equal(status[PATCH_ID], "pending", "有活的补丁不许被「核对过」这条认证放行");
  });
});

test("apply 侧：already 的一轮要留下 settled 证据，写过的不算", async () => {
  await withEnv(async () => {
    const appliedHost = makeHost(`${PATCHED}\n`);
    const patch = patchOf();
    const report = await core.applyPatches(appliedHost.aiBase, [patch], { identity: identityWithoutWrite(patch) });
    const row = report.find((item) => item.patch_id === PATCH_ID);
    assert.ok(row, "apply 报告里没有这条补丁");
    assert.equal(row.status, "already", "文件已在目标态：这一轮不该写");
    assert.equal(row.settled, true, "already 的补丁必须带「核对过在目标态」的证据");

    const evidence = core.collectApplyEvidence([{ report }]);
    assert.deepEqual(evidence.patchesSettled, [String(PATCH_ID)], "核对证据要能被收成清单");
    assert.deepEqual(evidence.patchesWritten, [], "没写过就不能进写入清单");
    assert.deepEqual(evidence.filesWritten, [], "没写过就没有文件指纹");

    // 需要写的那一轮反过来：进写入清单，不进核对清单。
    const pendingHost = makeHost(`${NEEDLE}\n`);
    const pendingPatch = patchOf({ id: 908, name: "ALREADY_CERTIFIED_FIXTURE_2" });
    const pendingReport = await core.applyPatches(pendingHost.aiBase, [pendingPatch], { identity: identityWithoutWrite(pendingPatch) });
    const pendingRow = pendingReport.find((item) => item.patch_id === 908);
    assert.equal(pendingRow.status, "applied", "原文还在的一轮必须真写");
    assert.equal(pendingRow.settled, undefined, "写过的不该同时算「核对过」");
    const pendingEvidence = core.collectApplyEvidence([{ report: pendingReport }]);
    assert.deepEqual(pendingEvidence.patchesSettled, [], "写过不等于核对过");
    assert.deepEqual(pendingEvidence.patchesWritten, ["908"]);
  });
});

test("表换了就不许认证：指纹对不上的账本 → pending（这才是 T1 那条假绿）", async () => {
  await withEnv(async () => {
    const patch = patchOf();
    const { aiBase } = makeHost(`${PATCHED}\n`);
    // 账本里的指纹来自**另一代**表（这里用一个别的指纹冒充）：内容再怎么「没活」也不许认证。
    const stale = identityWithoutWrite(patch, { patchShas: { [String(PATCH_ID)]: "0".repeat(64) } });
    const status = await core.patchStatus(aiBase, [patch], { identity: stale });
    assert.equal(status[PATCH_ID], "pending", "表换代时内容认证必须失效，否则载荷换代会被判成已生效");

    // 连指纹都没有的旧戳仍按痕量放行一次（WP2 的行为不变）。
    const bare = await core.patchStatus(aiBase, [patch], { identity: { version: "2.1.0", sha: "fixture-rev" } });
    assert.equal(bare[PATCH_ID], "applied", "无指纹的旧戳仍然放行一次，新字段缺失不许让它变红");
  });
});

test("内容指纹不回退：认证只进清单，contentSha 仍只记真写过的文件", async () => {
  const home = mkdtempSync(join(tmpdir(), "wp11-home-"));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    markPatchesApplied("fixture-rev", {
      patchesSettled: [String(PATCH_ID)],
      patchesWritten: [],
      filesWritten: [],
    });
    const stamp = JSON.parse(readFileSync(join(home, "dsh-purge", "applied.json"), "utf8"));
    assert.deepEqual(stamp.patchesSettled, [String(PATCH_ID)], "核对清单要落进账本");
    assert.deepEqual(stamp.patchesWritten, [], "这一轮没写过补丁");
    assert.equal(Object.keys(stamp.contentSha || {}).length, 0, "没写过就不许有内容指纹（WP2 的教训）");

    // 再跑一轮同表的 apply：清单累积，内容指纹仍然只来自真写过的文件。
    const hostFile = join(home, "host.js");
    writeFileSync(hostFile, "x", "utf8");
    markPatchesApplied("fixture-rev", {
      patchesSettled: [],
      patchesWritten: ["42"],
      filesWritten: [hostFile],
    });
    const again = JSON.parse(readFileSync(join(home, "dsh-purge", "applied.json"), "utf8"));
    assert.deepEqual(again.patchesSettled, [String(PATCH_ID)], "同表累积：上一轮的核对证据不许丢");
    assert.ok(again.patchesWritten.includes("42"), "写入清单按同表累积");
    assert.deepEqual(
      Object.keys(again.contentSha || {}),
      [fileContentKey(hostFile)],
      "内容指纹只记真写过的文件",
    );
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
});
