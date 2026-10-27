/**
 * test/client-bundle-selfheal.test.mjs — 自愈轮跳过 client bundle 时，账本里必须有「本轮没写它」的显式证据。
 *
 * 为什么单独立一份：启动自愈（`reapplyInstalled`）为了避开 client-hmr 的 #63 问题，不写
 * `node_modules/@…/lib/client.js`。这条路径不产生 `written_files`，于是表换代之后账本里
 * 没有这条补丁的写入证据，状态侧按「marker 不可信」判 pending —— 文件明明已经是这一版
 * 表的产物，界面上却挂着一条待应用，而且下一轮自愈仍然不写它，永久不消。
 *
 * 这里钉三件事：
 *   一、自愈轮不写 bundle，但要在报告里留下 `excluded_files`（`verified` + 现场字节 sha256）；
 *   二、`collectApplyEvidence` 把这份排除记录带出 apply 管线，账本 `evidenceExcluded` 收下它；
 *   三、状态侧凭「补丁指纹一致 + 现场字节仍是核对时那份」判已生效，不因缺写入证据假红；
 *   四、现场字节不是这一版表的产物时，排除记录只能是 `verified:false`，状态仍判待应用。
 *
 * 页面加载前的同步写路径（`patchWatchedClientBundlesSync`）另有一条「真写过什么」的清单，
 * 一并钉住返回形状：那条路径一旦真的写盘，证据必须能原样交给 `markPatchesApplied`。
 */
import { test } from "node:test";
import assert from "node:assert";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as core from "../lib/core.js";
import * as reapply from "../lib/reapply.js";
import { fileContentKey, patchFingerprints } from "../lib/patch/table-fingerprint.js";

const PATCH_ID = 956;
// marker 必须带 `dsh-purge` 这几个字：真表的每条补丁都是这样（PATCH-2 的判据），
// 而「这份字节是不是官方原文」正是按这个字样判的 —— 夹具不带它，备份那一步就会把
// 已经打了补丁的文件当成官方原文存下来，用例测的就不再是真实形态。
const MARK = "[dsh-purge] SELFHEAL_BUNDLE_MARK";
const OLD_ANCHOR = "const BUNDLE_ANCHOR = 1;";
const NEW_ANCHOR = `const BUNDLE_ANCHOR = 2; // ${MARK}`;

/** 合成补丁：只改 client bundle 一行，marker 由 replace 正文带出来。 */
function patchOf() {
  return {
    id: PATCH_ID,
    name: "SELFHEAL_BUNDLE_FIXTURE",
    layer: "代码",
    desc: "自愈轮 client bundle 证据夹具",
    file: ["conversation-client"],
    skipIfMarked: true,
    markers: [MARK],
    replacements: [{ pattern: OLD_ANCHOR, replace: NEW_ANCHOR }],
  };
}

function sha256Of(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/** 最小宿主：`<root>/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js`。 */
function makeHost(text) {
  const aiBase = path.join(mkdtemp("wp4-bundle-"), "node_modules", "@deepseek-ai");
  const dir = path.join(aiBase, "dsh-client-ui-conversation", "lib");
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, "client.js");
  fs.writeFileSync(fp, text, "utf8");
  // 官方原文快照：核对「现场字节是不是这一版表的产物」要拿它做底。
  // 来源标记必须一起写（`<sidecar>.json`）：没有来源的快照在判据里按「不可信」处理 ——
  // 同目录里任何写这个文件的人都能造一份 .bak，那是假绿的入口。
  fs.writeFileSync(`${fp}.dshpurge.bak`, `${OLD_ANCHOR}\n`, "utf8");
  fs.writeFileSync(
    `${fp}.dshpurge.json`,
    JSON.stringify({ path: fp, at: "2026-10-26T00:00:00.000Z", source: "first-seen-clean" }),
    "utf8",
  );
  return { aiBase, fp };
}

function mkdtemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * 账本夹具：表指纹与逐补丁指纹都来自**上一版表**，写入清单为空。
 * 这正是「表换代之后、自愈轮还没写 bundle」的现场。
 */
function changedTableIdentity() {
  const previous = { ...patchOf(), replacements: [{ pattern: OLD_ANCHOR, replace: "const BUNDLE_ANCHOR = 0;" }] };
  return {
    tableSha: "f".repeat(64),
    patchShas: patchFingerprints([previous]),
    patchesWritten: [],
    contentSha: {},
    migratedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function withHost(text, run) {
  const host = makeHost(text);
  const home = mkdtemp("wp4-bundle-home-");
  const previous = {
    DSH_HOME: process.env.DSH_HOME,
    DSH_BASE: process.env.DSH_BASE,
    DSH_SURFACE: process.env.DSH_SURFACE,
  };
  process.env.DSH_HOME = home;
  process.env.DSH_BASE = host.aiBase;
  process.env.DSH_SURFACE = "desktop";
  try {
    return await run(host, home);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(host.aiBase, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("红灯：自愈轮不写 client bundle，但排除记录要带出「现场已核对」的证据", async () => {
  await withHost(`${NEW_ANCHOR}\n`, async ({ aiBase, fp }) => {
    const patch = patchOf();
    const report = await core.applyPatches(aiBase, [patch], {
      identity: changedTableIdentity(),
      preserveClientBundles: true,
    });
    const row = report.find((item) => item.patch_id === PATCH_ID);
    assert.ok(row, "报告里没有这条补丁");
    assert.equal(fs.readFileSync(fp, "utf8"), `${NEW_ANCHOR}\n`, "自愈轮不许写 client bundle");
    assert.ok(
      Array.isArray(row.excluded_files) && row.excluded_files.length === 1,
      "自愈轮跳过 bundle 必须在报告里留排除记录，否则账本只看到「没写过」",
    );
    const [excluded] = row.excluded_files;
    assert.equal(excluded.file, fileContentKey(fp), "排除记录要指向具体文件（与账本同一套归一化路径）");
    assert.equal(excluded.verified, true, "现场字节就是这一版补丁的产物时，排除记录要说清核对通过");
    assert.equal(excluded.contentSha, sha256Of(`${NEW_ANCHOR}\n`), "排除记录要绑定核对时的字节");

    const evidence = core.collectApplyEvidence([{ report }]);
    assert.deepEqual(evidence.filesWritten, [], "这一轮确实没写文件");
    assert.equal(evidence.excludedWrites.length, 1, "排除记录必须从 apply 管线带出来");
    reapply.markPatchesApplied(undefined, { runId: "selfheal-1", ...evidence });

    const stamp = JSON.parse(fs.readFileSync(path.join(process.env.DSH_HOME, "dsh-purge", "applied.json"), "utf8"));
    assert.ok(Array.isArray(stamp.evidenceExcluded) && stamp.evidenceExcluded.length === 1, "账本里没有排除记录");
    assert.equal(stamp.evidenceExcluded[0].verified, true);
    assert.equal(stamp.evidenceExcluded[0].patchSha, patchFingerprints([patch])[String(PATCH_ID)]);
    assert.equal(stamp.contentSha[fileContentKey(fp)], sha256Of(`${NEW_ANCHOR}\n`), "排除记录的字节指纹没有进内容表");

    const status = await core.patchStatus(aiBase, [patch]);
    assert.equal(status[PATCH_ID], "applied", "自愈轮之后状态因缺写入证据假红（pending）");
  });
});

test("排除记录不许认证旧字节：现场不是这一版表的产物时只能记 verified=false", async () => {
  await withHost(`${OLD_ANCHOR}\n`, async ({ aiBase, fp }) => {
    const patch = patchOf();
    const report = await core.applyPatches(aiBase, [patch], {
      identity: changedTableIdentity(),
      preserveClientBundles: true,
    });
    const row = report.find((item) => item.patch_id === PATCH_ID);
    assert.equal(fs.readFileSync(fp, "utf8"), `${OLD_ANCHOR}\n`, "自愈轮不许写 client bundle");
    assert.equal(row.excluded_files.length, 1, "没写它也要留排除记录");
    assert.equal(row.excluded_files[0].verified, false, "原文还没替换，排除记录不许说核对通过");
    assert.equal(row.status, "pending", "还有活的补丁要如实判待应用");

    const evidence = core.collectApplyEvidence([{ report }]);
    reapply.markPatchesApplied(undefined, { runId: "selfheal-2", ...evidence });
    const status = await core.patchStatus(aiBase, [patch]);
    assert.equal(status[PATCH_ID], "pending", "旧字节被排除记录认证成了已生效");
  });
});

test("页面加载前的同步写路径要返回本轮真写过的包 / 补丁 / 文件", async () => {
  const real = core.ALL_PATCHES.find((item) => item.id === 56);
  assert.ok(real, "补丁表里找不到 id 56");
  const first = real.replacements[0];
  await withHost(`${first.pattern}\n`, async ({ aiBase, fp }) => {
    const written = core.patchWatchedClientBundlesSync(aiBase);
    assert.ok(written && !Array.isArray(written), "同步写路径要返回写入证据对象，不是裸包名数组");
    assert.deepEqual(written.packages, ["@deepseek-ai/dsh-client-ui-conversation"], "写过的包名不对");
    assert.deepEqual(written.patchesWritten, ["56"], "写入清单没有带上这条补丁的 id");
    assert.deepEqual(written.filesWritten, [fp], "写入清单没有带上这个文件");
    assert.ok(fs.readFileSync(fp, "utf8").includes("[dsh-purge] rewind hides the cut turn"), "文件没有真写进去");
  });
});
