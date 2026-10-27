/**
 * test/patch-skip-vs-work.test.mjs — 「跳过」与「还有活」不能各说一套：四种形态各判各的。
 *
 * 为什么单独立一份：远端 2.3.0 的 `--apply` 认为干净（`ensure ok`、`failed=0`），重启后
 * 逐补丁实检却说 2/3/50 待应用。诊断结论是这三条在**这一版宿主的官方原文里本来就有产物**
 * （把这版表的替换套到原文上，一个字节都不变），而账本里从来没有它们的写入记录 ——
 * 它们既不需要谁写过，也不该因为「没写过」而永远 pending。
 *
 * 判据四条（前三条是判据书要求的三种情形，第四条是 WP2 那条不许回退的红灯）：
 *   ① 产物已在原文 + marker 在 → applied；
 *   ② 产物不在 + marker 是别人写的（73 型）→ pending；
 *   ③ dry-run 会改文本且无认证 → pending（认证不许压过「还有活」）；
 *   ④ 没有官方原文快照 → 不认证（只写戳的一轮仍然 pending）。
 *
 * 官方原文用文件旁的 `.dshpurge.bak` 表达（`readOfficialSnapshot` 的第一顺位），
 * 因此夹具不需要碰真实主目录的保险柜。
 */
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "../lib/core.js";
import { patchFingerprints } from "../lib/patch/table-fingerprint.js";

const VENDOR_MARKER = "// VENDOR_BASELINE_HEADER";
const OLD_SENTENCE = "const OLD_INTRO = 'obsolete wording';";
const NEW_SENTENCE = `const NEW_INTRO = 'baseline wording'; ${VENDOR_MARKER}`;
const BORROWED_MARKER = "// BORROWED_FROM_ANOTHER_PATCH";
const MIRROR = "\t* MIRROR LINE.";

/** 现场自述：替换产物里带的是宿主原文本来就有的那句话。 */
function vendoredPatch(overrides = {}) {
  return {
    id: 912,
    name: "VENDORED_REPLACEMENT",
    layer: "提示词",
    desc: "产物随官方原文自带",
    file: "agent-loop",
    skipIfMarked: true,
    replacements: [{ pattern: OLD_SENTENCE, replace: NEW_SENTENCE }],
    markers: [VENDOR_MARKER],
    ...overrides,
  };
}

/** 73 型：marker 是别的补丁写的，自己的删除还没做。 */
function borrowedMarkerPatch() {
  return {
    id: 913,
    name: "BORROWED_MARKER_REMOVAL",
    layer: "提示词",
    desc: "marker 借来的删除型",
    file: "agent-loop",
    onMiss: "ignore",
    skipIfMarked: true,
    markers: [BORROWED_MARKER],
    replacements: [{ pattern: /\n[ \t]*\* MIRROR LINE\.\n/, replace: "\n" }],
  };
}

/**
 * 造一个最小宿主；`official` 给了就写一份「官方原文」旁车（`.dshpurge.bak`）。
 *
 * 旁车内容必须不含我们自己的标记词，否则 `isOfficialSnapshotBuf` 会把它当现场而不是原文。
 */
function makeHost({ field, official = null }) {
  const aiBase = join(mkdtempSync(join(tmpdir(), "wp26-skipwork-")), "node_modules", "@deepseek-ai");
  const dir = join(aiBase, "dsh-agent-loop", "lib");
  mkdirSync(dir, { recursive: true });
  const fp = join(dir, "index.js");
  writeFileSync(fp, field, "utf8");
  if (official != null) {
    writeFileSync(`${fp}.dshpurge.bak`, official, "utf8");
    /* 旁车要带来源标记才算「官方原文」（T52）：没有 meta 的快照不能拿去认证。 */
    writeFileSync(`${fp}.dshpurge.json`, `${JSON.stringify({ path: fp, at: new Date().toISOString(), source: "first-seen-clean" })}\n`, "utf8");
  }
  return { aiBase, fp };
}

/** 账本形状：指纹对得上、但这一版表没写过也没核对过它（远端 2/3/50 的处境）。 */
function stampedIdentity(patch) {
  return {
    version: "2.3.0",
    sha: "fixture-rev",
    patchShas: patchFingerprints([patch]),
    patchesWritten: [],
    patchesSettled: [],
    contentSha: {},
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

test("① 产物已在原文 + marker 在 → applied（远端 #2 / #3 的形态）", async () => {
  await withEnv(async () => {
    const patch = vendoredPatch();
    // 官方原文里本来就有产物（也带着 marker），现场文本与原文一致：这一版表无事可做。
    const official = `// official\n${NEW_SENTENCE}\nconst x = 1;\n`;
    const { aiBase } = makeHost({ field: official, official });
    const status = await core.patchStatus(aiBase, [patch], { identity: stampedIdentity(patch) });
    assert.equal(status[patch.id], "applied", "原文自带这段产物时不需要任何写入证据");
  });
});

test("② 产物不在 + marker 是别人写的（73 型）→ 仍必须 pending", async () => {
  await withEnv(async () => {
    const patch = borrowedMarkerPatch();
    // 现场：marker 在（别的补丁写的）、镜线还在（自己的活没干）；原文里没有这个 marker。
    const field = `${BORROWED_MARKER}\n${MIRROR}\nconst x = 1;\n`;
    const official = `// official\nconst x = 1;\n`;
    const { aiBase } = makeHost({ field, official });
    const status = await core.patchStatus(aiBase, [patch], { identity: stampedIdentity(patch) });
    assert.equal(status[patch.id], "pending", "借来的 marker 不许把未完成的删除算成已应用");
  });
});

test("②b 产物不在、marker 在原文里也没有 → pending（认证不能靠痕迹）", async () => {
  await withEnv(async () => {
    const patch = vendoredPatch();
    // 现场有 marker，但原文里既没有 marker 也没有产物：这是「只写了戳」的形态。
    const field = `${VENDOR_MARKER}\nconst x = 1;\n`;
    const official = `// official\nconst x = 1;\n`;
    const { aiBase } = makeHost({ field, official });
    const status = await core.patchStatus(aiBase, [patch], { identity: stampedIdentity(patch) });
    assert.equal(status[patch.id], "pending", "原文里没有产物就不是空操作，只能等真写入证据");
  });
});

test("③ dry-run 会改文本且无认证 → pending（认证压不过「还有活」）", async () => {
  await withEnv(async () => {
    const patch = vendoredPatch();
    // 原文自带产物（空操作成立），但现场文本里旧句子又回来了：还有活，必须 pending。
    const official = `// official\n${NEW_SENTENCE}\n`;
    const field = `// official\n${NEW_SENTENCE}\n${OLD_SENTENCE}\n`;
    const { aiBase } = makeHost({ field, official });
    const status = await core.patchStatus(aiBase, [patch], { identity: stampedIdentity(patch) });
    assert.equal(status[patch.id], "pending", "还有活就是 pending —— 空操作认证只回答「需不需要证据」");
  });
});

test("④ 没有官方原文快照 → 不认证（只写戳的一轮仍然 pending）", async () => {
  await withEnv(async () => {
    const patch = vendoredPatch();
    const { aiBase } = makeHost({ field: `${VENDOR_MARKER}\nconst x = 1;\n`, official: null });
    const status = await core.patchStatus(aiBase, [patch], { identity: stampedIdentity(patch) });
    assert.equal(status[patch.id], "pending", "没有原文快照就不可判，不许拿 marker 兜底");
  });
});

test("apply 侧同一口径：空操作的补丁在这一轮就记进核对清单", async () => {
  await withEnv(async () => {
    const patch = vendoredPatch();
    const official = `// official\n${NEW_SENTENCE}\nconst x = 1;\n`;
    const { aiBase } = makeHost({ field: official, official });
    const report = await core.applyPatches(aiBase, [patch], { identity: stampedIdentity(patch) });
    const row = report.find((item) => item.patch_id === patch.id);
    assert.equal(row.status, "already", "空操作的一轮不该写字节");
    assert.equal(row.settled, true, "空操作也是「核对过在目标态」的一种，必须进核对清单");
    const evidence = core.collectApplyEvidence([{ report }]);
    assert.deepEqual(evidence.patchesSettled, [String(patch.id)], "证据要能被收成清单");
  });
});
