/**
 * test/stamp-written-evidence.test.mjs — 版本账本只认证「这一版表真写过的字节」。
 *
 * 为什么单独立一份：账本原先把目标文件的**当时字节**无条件记进 `contentSha`，于是同一份
 * 旧正文只要重写一次戳，下一次状态查询就会因为「字节与账本相等」判成已生效 —— 戳本身
 * 变成了新的 marker。这里把三件事钉住：
 *   1. 只写戳、不做 apply 的一轮，不能把当前字节认证成这一版表的产物；
 *   2. `contentSha` 只收本轮真写过的文件，没写过的文件不进表；
 *   3. 旧账本（没有指纹）只放行一次：迁移写会留下 `migratedAt`，之后再判就必须有写入证据。
 */
import { test } from "node:test";
import assert from "node:assert";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "../lib/core.js";
import * as reapply from "../lib/reapply.js";
import { fileContentKey } from "../lib/patch/table-fingerprint.js";

const PATCH_ID = 89; // SYSTEM_FIELD_EXTRACT：marker 明确、目标文件单一，适合做账本夹具

function sha256OfFile(fp) {
  return createHash("sha256").update(readFileSync(fp)).digest("hex");
}

/** 最小宿主：agent-loop（判据对象）+ settings（用来证明「没写过的文件不进表」）。 */
function makeHost() {
  const aiBase = join(mkdtempSync(join(tmpdir(), "wp3-stamp-")), "node_modules", "@deepseek-ai");
  const agentLoop = join(aiBase, "dsh-agent-loop", "lib", "index.js");
  const settings = join(aiBase, "dsh-settings", "lib", "index.js");
  mkdirSync(join(aiBase, "dsh-agent-loop", "lib"), { recursive: true });
  mkdirSync(join(aiBase, "dsh-settings", "lib"), { recursive: true });
  writeFileSync(agentLoop, "// [dsh-purge-89] system field extract\n", "utf8");
  writeFileSync(settings, "const untouched = true;\n", "utf8");
  return { aiBase, agentLoop, settings };
}

function patch89() {
  const patch = core.ALL_PATCHES.find((item) => item.id === PATCH_ID);
  assert.ok(patch, "补丁表里找不到判据对象 89");
  return patch;
}

/** 判据要经 patchAppliesHere 的宿主面门禁；夹具与宿主面无关，强制成桌面面。 */
async function withEnv(run) {
  const home = mkdtempSync(join(tmpdir(), "wp3-stamp-home-"));
  const previous = {
    DSH_HOME: process.env.DSH_HOME,
    DSH_BASE: process.env.DSH_BASE,
    DSH_SURFACE: process.env.DSH_SURFACE,
  };
  process.env.DSH_HOME = home;
  process.env.DSH_SURFACE = "desktop";
  process.env.DSH_BASE = "";
  try {
    return await run(home);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function stampPath(home) {
  return join(home, "dsh-purge", "applied.json");
}

function readStamp(home) {
  return JSON.parse(readFileSync(stampPath(home), "utf8"));
}

test("apply 报告 → 证据：多宿主按补丁号与路径去重，没写过的行不进清单", () => {
  const evidence = core.collectApplyEvidence([
    {
      report: [
        { patch_id: PATCH_ID, applied: 1, written_files: ["C:/host/a.js"] },
        { patch_id: 90, applied: 0, written_files: [] },
      ],
    },
    {
      report: [
        { patch_id: PATCH_ID, applied: 1, written_files: ["C:/host/a.js", "C:/host/b.js"] },
      ],
    },
  ]);
  assert.deepEqual(evidence.patchesWritten, [String(PATCH_ID)], "applied=0 的补丁与重复补丁号不许进清单");
  assert.deepEqual(evidence.filesWritten, ["C:/host/a.js", "C:/host/b.js"], "文件按路径去重");
});

test("红灯：只写戳一轮（同一份旧字节、同一 marker）之后，状态必须是 pending", async () => {
  await withEnv(async () => {
    const { aiBase } = makeHost();
    // 只写戳：没有补丁写入清单，也没有内容指纹可用 —— 这一轮什么都没认证。
    reapply.markPatchesApplied(undefined, { runId: "apply-20261026T000000Z-stmp", bases: [aiBase] });
    const status = await core.patchStatus(aiBase, [patch89()]);
    assert.equal(status[PATCH_ID], "pending", "戳不能被当成新的 marker：没写过就不能认证这些字节");
  });
});

test("红灯：contentSha 只收本轮写过的文件，没写过的文件不许进表", async () => {
  await withEnv(async (home) => {
    const { aiBase, agentLoop, settings } = makeHost();
    reapply.markPatchesApplied(undefined, {
      runId: "apply-20261026T000001Z-wr1t",
      bases: [aiBase],
      patchesWritten: [PATCH_ID],
      filesWritten: [agentLoop],
    });
    const stamp = readStamp(home);
    assert.deepEqual(stamp.patchesWritten, [String(PATCH_ID)], "戳里要记「本轮写过哪些补丁」");
    assert.deepEqual(
      stamp.filesWritten,
      [fileContentKey(agentLoop)],
      `戳里要记「本轮写过哪些文件」：${JSON.stringify(stamp.filesWritten)}`,
    );
    assert.deepEqual(
      Object.keys(stamp.contentSha || {}),
      [fileContentKey(agentLoop)],
      `contentSha 混进了没写过的文件：${JSON.stringify(Object.keys(stamp.contentSha || {}))}`,
    );
    assert.equal(
      stamp.contentSha[fileContentKey(settings)],
      undefined,
      "没写过的 settings 文件不许进内容指纹表 —— 否则下一轮自然相等",
    );
    const status = await core.patchStatus(aiBase, [patch89()]);
    assert.equal(status[PATCH_ID], "applied", "有写入证据的一轮必须能判 applied");
    assert.equal(sha256OfFile(agentLoop), stamp.contentSha[fileContentKey(agentLoop)]);
  });
});

test("旧账本放行一轮：迁移写留下 migratedAt，第二轮走真判据", async () => {
  await withEnv(async (home) => {
    const { aiBase } = makeHost();
    mkdirSync(join(home, "dsh-purge"), { recursive: true });
    writeFileSync(
      stampPath(home),
      `${JSON.stringify({ version: "2.1.0", sha: "fixture-rev" }, null, 2)}\n`,
      "utf8",
    );
    const first = await core.patchStatus(aiBase, [patch89()]);
    assert.equal(first[PATCH_ID], "applied", "旧账本只有痕量可读：第一轮必须放行，否则升级首启全报待应用");

    reapply.markPatchesApplied(undefined, { runId: "apply-20261026T000002Z-migr", bases: [aiBase] });
    const stamp = readStamp(home);
    assert.ok(String(stamp.migratedAt || "").length > 0, "迁移写必须留下可见的迁移时间");
    assert.deepEqual(stamp.patchesWritten, [], "迁移轮没有真写过补丁，清单必须是空数组");
    const second = await core.patchStatus(aiBase, [patch89()]);
    assert.equal(second[PATCH_ID], "pending", "迁移放行只许一轮：第二轮必须要求写入证据");
  });
});
