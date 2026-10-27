/**
 * test/cross-generation-converge.test.mjs — 跨代表升级：单次 apply 必须收敛。
 *
 * 现场（远端实测）：宿主已被旧版插件打过补丁，插件换成新版本（补丁表换代），
 * `--revert` + 单次 `--apply` 之后仍有 3 条 pending，要再跑一次 apply 才收敛。
 *
 * 根因是三条链组成的死循环：
 *   1. 状态侧只认账本（`patchFileTrusted`），而账本里是**旧表**的逐条指纹；
 *   2. 内容认证（`patchCertifiedByContent` / `patchVacuousOnOfficial`）也要旧表指纹，
 *      于是「文件早在目标态、没有可写字节」的补丁这一轮一个也认证不了；
 *   3. 账本只在不含 pending 的轮次写，而 pending 又让这一轮不干净 —— 于是它永远不写。
 *
 * 修法是给判据加第三种证据：`apply(当前表, 官方原文) === 现场字节`。它不读账本，
 * 所以本轮就能产生；写进账本之后下一轮也读得到。本用例把两件事一次钉住：
 * 「旧账本 + 新表 + 现场已是目标态」时**状态侧当场就判 applied**（不再要求先跑一轮 apply
 * 把证据写进账本），以及落账之后同一份现场仍然判 applied。
 *
 * 自证的单位是**文件**而不是单条补丁：同一文件上后一条补丁会改写前一条的产物，
 * 单条重放与现场永远对不上 —— 那种判据在换表后的第一轮会把一条不缺的补丁判成待应用。
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as core from "../lib/core.js";
import { markPatchesApplied } from "../lib/reapply.js";
import { patchFingerprints } from "../lib/patch/table-fingerprint.js";

const PATCH_ID = 941;
const MARKER = "[dsh-purge] CROSS_GEN_MARKER";
const OLD_ANCHOR = "const CROSS_GEN_SOURCE = 1;";
const NEW_BODY = `const CROSS_GEN_SOURCE = 2; // ${MARKER}`;
const OLD_BODY = `const CROSS_GEN_SOURCE = 3; // ${MARKER}`;

/** 新版补丁：把官方原文改写成 NEW_BODY。 */
function newPatch() {
  return {
    id: PATCH_ID,
    name: "CROSS_GEN_FIXTURE",
    layer: "代码",
    desc: "跨代收敛夹具",
    file: "agent-loop",
    replacements: [{ pattern: OLD_ANCHOR, replace: NEW_BODY }],
    markers: [MARKER],
  };
}

/** 旧版补丁：同一 id、不同正文 —— 于是账本里的逐条指纹与当前表对不上。 */
function oldPatch() {
  return { ...newPatch(), replacements: [{ pattern: OLD_ANCHOR, replace: OLD_BODY }] };
}

/** 旧世代账本：表指纹与逐条指纹都是旧表的，写入清单为空。 */
function oldLedger() {
  return {
    version: "2.0.0",
    sha: "fixture-rev-old",
    tableSha: "f".repeat(64),
    patchShas: patchFingerprints([oldPatch()]),
    patchesWritten: [],
    patchesSettled: [],
    contentSha: {},
    migratedAt: "2026-01-01T00:00:00.000Z",
  };
}

/**
 * 假宿主：现场已经是**新版**的产物，旁边留着旧世代的官方原文快照（带来源）。
 * 这正是「旧版打过补丁 + 官方原文还在保险柜 + 表换代」的三件套。
 */
function makeHost() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp12-crossgen-"));
  const aiBase = path.join(root, "node_modules", "@deepseek-ai");
  const dir = path.join(aiBase, "dsh-agent-loop", "lib");
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, "index.js");
  fs.writeFileSync(fp, `${NEW_BODY}\n`, "utf8");
  fs.writeFileSync(`${fp}.dshpurge.bak`, `${OLD_ANCHOR}\n`, "utf8");
  fs.writeFileSync(
    `${fp}.dshpurge.json`,
    JSON.stringify({ path: fp, at: "2026-01-01T00:00:00.000Z", source: "first-seen-clean" }),
    "utf8",
  );
  return { root, aiBase, fp };
}

async function withEnv(host, run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wp12-crossgen-home-"));
  const previous = {
    DSH_HOME: process.env.DSH_HOME,
    DSH_BASE: process.env.DSH_BASE,
    DSH_SURFACE: process.env.DSH_SURFACE,
  };
  process.env.DSH_HOME = home;
  process.env.DSH_BASE = host.aiBase;
  process.env.DSH_SURFACE = "desktop";
  try {
    return await run(home);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(host.root, { recursive: true, force: true });
  }
}

test("状态侧自证：旧账本 + 新表，现场字节就是这一版表的产物 → 当场判 applied", async () => {
  const host = makeHost();
  await withEnv(host, async () => {
    const status = await core.patchStatus(host.aiBase, [newPatch()], { identity: oldLedger() });
    assert.equal(
      status[PATCH_ID],
      "applied",
      "账本旧、现场对：判据必须问现场（官方原文 + 这一版表 == 现场字节），不许被旧指纹否决",
    );
  });
});

test("反例：现场不是这一版表的产物 → 仍然 pending（自证不许放宽）", async () => {
  const host = makeHost();
  await withEnv(host, async () => {
    // 现场换成另一代正文：官方原文 + 这一版表得到的不是它，自证必须不成立。
    fs.writeFileSync(host.fp, `${OLD_ANCHOR}\n`, "utf8");
    const status = await core.patchStatus(host.aiBase, [newPatch()], { identity: oldLedger() });
    assert.ok(
      status[PATCH_ID] === "pending" || status[PATCH_ID] === "skipped",
      `现场还没打上，不许判 applied（实际 ${status[PATCH_ID]}）`,
    );
  });
});

test("绿灯：单次 apply 产出逐文件核对记录，落账后同一份现场判 applied", async () => {
  const host = makeHost();
  await withEnv(host, async (home) => {
    const report = await core.applyPatches(host.aiBase, [newPatch()], { identity: oldLedger() });
    const row = report.find((item) => item.patch_id === PATCH_ID);
    assert.ok(row, "报告里没有这条补丁");
    assert.notEqual(row.status, "pending", `单次 apply 之后不许还有 pending（实际 ${row.status}）`);
    assert.equal(fs.readFileSync(host.fp, "utf8"), `${NEW_BODY}\n`, "文件已在目标态，这一轮不该改写它");

    const evidence = core.collectApplyEvidence([{ report }]);
    assert.deepEqual(evidence.patchesWritten, [], "没写过就不能进写入清单");
    assert.ok(evidence.excludedWrites.length > 0, "「没写但核对过」必须留下逐文件记录");
    const record = evidence.excludedWrites[0];
    assert.equal(record.verified, true, "官方原文 + 当前表重放 == 现场：这条记录必须标成核对通过");
    assert.ok(record.contentSha, "核对记录要绑定当时的字节，文件一动它就失效");

    // 落账（跨代那一轮的表指纹是新的，旧证据作废，只认这一轮的核对记录）。
    markPatchesApplied("fixture-rev", evidence);
    const stamp = JSON.parse(fs.readFileSync(path.join(home, "dsh-purge", "applied.json"), "utf8"));
    assert.equal(stamp.evidenceExcluded.length, 1, "核对记录要进账本");
    assert.equal(stamp.patchesWritten.length, 0, "没写过就是没写过");

    const after = await core.patchStatus(host.aiBase, [newPatch()]);
    assert.equal(after[PATCH_ID], "applied", "落账之后同一份现场必须判 applied —— 这才叫收敛");
  });
});

test("边界：核对记录不许自我认证 —— 官方原文与现场逐字相同的一档不算证据", async () => {
  const host = makeHost();
  await withEnv(host, async () => {
    // 把「官方原文」改成与现场相同：那一份答不了「现场是不是原文打出来的」。
    fs.writeFileSync(`${host.fp}.dshpurge.bak`, `${NEW_BODY}\n`, "utf8");
    const report = await core.applyPatches(host.aiBase, [newPatch()], { identity: oldLedger() });
    const row = report.find((item) => item.patch_id === PATCH_ID);
    const records = Array.isArray(row.excluded_files) ? row.excluded_files : [];
    assert.equal(records.some((item) => item.verified === true), false, "拿现场当原文，等于自己证自己");
  });
});
