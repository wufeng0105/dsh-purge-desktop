/**
 * test/patch-selfmatch-work.test.mjs — 「还有活」= 再跑一次替换会不会改文本，不是「pattern 还能匹配」。
 *
 * 为什么单独立这份：自匹配型替换（替换产物仍以原 pattern 开头，如 #42 的
 * `configure(presentation, owner = this.ctx.fiber) {` 尾巴）在宿主上打完之后 pattern 依旧命中，
 * 「pattern 能匹配」因此恒真，`contentFileOutcome` 的第一条规则把已打补丁的宿主钉成 pending。
 * 真机后果不是显示问题：每一轮 apply 都不 clean、版本账本永远不落、每次启动全量 revert+reapply。
 *
 * 三条用例各钉一件事：
 *   1. 红灯（本文件的主用例）：已应用的自匹配夹具必须判 applied —— 改判据前它是 pending；
 *   2. 对照：原文还在必须仍判 pending；锚点没了必须不许再判 pending（按 onMiss 落 applied/skipped）；
 *   3. 反假绿：marker 在、替换正文还没落到文本里（#73 的形态）时，dry-run 必须按「会不会改
 *      文本」算。若有人把 dry-run 改成信 marker（`markerTrusted` 缺省 true），marker 会短路
 *      替换、把 changed 误判成 false，这一条立刻变红。
 *
 * 全部走真实入口 `core.patchStatus()` / `core.applyPatches()`，不测私有函数 ——
 * 「状态报什么」才是判据。
 */
import { test } from "node:test";
import assert from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "../lib/core.js";
import { fileContentKey, patchFingerprints, tableFingerprint } from "../lib/patch/table-fingerprint.js";

const PATCH_ID = 903;
const MARKER = "// SELFMATCH_TAIL_MARKER";
/** 自匹配的原文：替换产物以它为前缀，所以打完 pattern 仍然命中。 */
const NEEDLE = "\tserve(presentation, owner = this.ctx.fiber) {";
const PATCHED = `${NEEDLE} ${MARKER}`;

/** 一条「替换产物包含 pattern」的补丁，形状与 #42 的第三条替换同构。 */
function selfMatchPatch(overrides = {}) {
  return {
    id: PATCH_ID,
    name: "SELFMATCH_TAIL_FIXTURE",
    layer: "代码",
    desc: "自匹配夹具：替换产物仍以原 pattern 开头",
    file: "agent-loop",
    skipIfMarked: true,
    replacements: [{ pattern: NEEDLE, replace: PATCHED }],
    markers: [MARKER],
    ...overrides,
  };
}

/** 最小宿主：`<root>/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js`（键名与目标表一致）。 */
function makeHost(text) {
  const aiBase = join(mkdtempSync(join(tmpdir(), "wp9-selfmatch-")), "node_modules", "@deepseek-ai");
  const dir = join(aiBase, "dsh-agent-loop", "lib");
  mkdirSync(dir, { recursive: true });
  const fp = join(dir, "index.js");
  writeFileSync(fp, text, "utf8");
  return { aiBase, fp };
}

function sha256Of(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/** 账本四项齐全：逐补丁指纹、表指纹、内容指纹、写入清单 —— 让 pending 只能来自 `worked`。 */
function stampFor(patch, contentText, fp) {
  return {
    version: "2.1.0",
    sha: "fixture-rev",
    tableSha: tableFingerprint([patch]),
    patchShas: patchFingerprints([patch]),
    contentSha: { [fileContentKey(fp)]: sha256Of(contentText) },
    patchesWritten: [String(patch.id)],
  };
}

/** 判据要过宿主面门禁；夹具与宿主面无关，强制成桌面面。 */
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

test("红灯：已应用的自匹配补丁必须判 applied（旧判据把它钉成 pending）", async () => {
  await withEnv(async () => {
    const patch = selfMatchPatch();
    const text = `${PATCHED}\n`;
    const { aiBase, fp } = makeHost(text);
    const status = await core.patchStatus(aiBase, [patch], { identity: stampFor(patch, text, fp) });
    assert.equal(
      status[PATCH_ID],
      "applied",
      "替换产物仍含原 pattern，但再跑一次不会改文本 —— 判 pending 就是假红（真机后果是永不 clean）",
    );
  });
});

test("对照：原文还在仍判 pending，锚点没了不许再判 pending", async () => {
  await withEnv(async () => {
    const patch = selfMatchPatch();
    const identity = { version: "2.1.0", sha: "fixture-rev" };

    const pendingHost = makeHost(`${NEEDLE}\n`);
    const pending = await core.patchStatus(pendingHost.aiBase, [patch], { identity });
    assert.equal(pending[PATCH_ID], "pending", "原文还在就是还有活，dry-run 必须看得见它");

    const goneHost = makeHost("// unrelated\n");
    const gone = await core.patchStatus(goneHost.aiBase, [patch], { identity });
    assert.equal(gone[PATCH_ID], "skipped", "锚点与 marker 都不在：这一版不需要它，不是待清洗");

    // 同一份「锚点没了」的文本，marker 在 → 已生效（而不是 pending）。
    const markedHost = makeHost(`${MARKER}\n`);
    const marked = await core.patchStatus(markedHost.aiBase, [patch], { identity });
    assert.equal(marked[PATCH_ID], "applied", "锚点没了、marker 在：已生效，不许挂在待清洗上");
  });
});

test("反假绿：marker 在但替换正文没落进文本 → 仍判 pending（dry-run 不许信 marker）", async () => {
  await withEnv(async () => {
    // #73 的形态：删除型正则替换，marker 由**另一条**补丁写进同一个文件。
    const mirrorMarker = "// MIRROR_BLOCK_MARKER";
    const patch = {
      id: 904,
      name: "MIRROR_LINE_FIXTURE",
      layer: "提示词",
      desc: "删除型替换：marker 在，正文还在",
      file: "agent-loop",
      onMiss: "ignore",
      skipIfMarked: true,
      markers: [mirrorMarker],
      replacements: [
        {
          pattern: /\n[ \t]*\* MIRROR HINT LINE\.\n/,
          replace: "\n",
        },
      ],
    };
    const text = `${mirrorMarker}\n\t* MIRROR HINT LINE.\n`;
    const { aiBase, fp } = makeHost(text);
    // 账本认证这条补丁（指纹 + 写入清单 + 内容指纹）→ pending 只能来自「还有活」。
    const status = await core.patchStatus(aiBase, [patch], { identity: stampFor(patch, text, fp) });
    assert.equal(
      status[904],
      "pending",
      "marker 在场不等于正文到位：dry-run 必须传 markerTrusted:false，否则这条会假绿",
    );
    // dry-run 本身也必须看得见这条替换：改文本 = 还有活。
    const dry = core.applyReplacementsToText(text, patch, fp, { markerTrusted: false });
    assert.equal(dry.changed, true, "markerTrusted:false 下这条替换确实会改文本，判据必须据此判 pending");
  });
});

test("apply 侧与状态侧同一口径：自匹配已应用的文件，apply 报 already、状态报 applied", async () => {
  await withEnv(async () => {
    const patch = selfMatchPatch();
    const text = `${PATCHED}\n`;
    const { aiBase } = makeHost(text);
    const identity = { version: "2.1.0", sha: "fixture-rev" };

    const report = await core.applyPatches(aiBase, [patch], { identity });
    const row = report.find((r) => r.patch_id === PATCH_ID);
    assert.ok(row, "applyPatches 必须为这条补丁出一行");
    assert.equal(row.status, "already", `apply 侧把它当成「还有活」就会每轮重写：${JSON.stringify(row)}`);
    assert.equal(row.applied, 0, "自匹配已应用的文件不该被再写一次");

    const status = await core.patchStatus(aiBase, [patch], { identity });
    assert.equal(status[PATCH_ID], "applied", "两处必须同一结论，不许一边 applied 一边 pending");
  });
});

test("两处只有一个实现：core.js 里「还有活」只由 patchHasRemainingWork 一处给出", () => {
  const source = readFileSync(new URL("../lib/core.js", import.meta.url), "utf8");
  assert.equal(
    /function patchHasRemainingWork\(/.test(source),
    true,
    "「还有活」必须只有一个具名实现",
  );
  // apply 侧与状态侧都必须调它；任何一处改成自己算，这条立刻红。
  const callers = source.match(/patchHasRemainingWork\(/g) || [];
  assert.ok(
    callers.length >= 3,
    `apply 侧与状态侧都必须调同一个函数（当前 ${callers.length} 处：含定义 1 处）`,
  );
  assert.equal(
    /matchesPattern\(hay, pattern\)\) return true;/.test(source),
    false,
    "旧判据（pattern 能匹配即算还有活）不许留在任何地方",
  );
});
