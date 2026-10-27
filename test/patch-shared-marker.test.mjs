/**
 * test/patch-shared-marker.test.mjs — marker 只证明「某个痕量在」，不证明「这条补丁的活干完了」。
 *
 * 为什么单独立一份：#73（`PRESET_BASH_MIRROR_LINE`）是删除型补丁，它的 marker 却是 #70
 * 写进同一个文件的。旧短路条件只问「marker 在不在」，于是 73 看到别人写的 marker 就跳过
 * 自己的删除，镜线留在文件里，`patchStatus` 永远判 pending —— 真机后果是 apply 永不 clean。
 *
 * 判据（三条）：
 *   1. 共享 marker + 待删文本仍在 → apply 必须真删（而不是报 already），删完状态判 applied；
 *   2. 删完之后再 apply 一遍：字节不变、状态仍是 applied（幂等不许破）；
 *   3. 写 marker 的那条补丁自己是自匹配型：marker 在、活也干完了 → 护栏照旧短路（不许重叠）。
 */
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "../lib/core.js";

/** 由补丁 A 写进文件、被补丁 B 共享的 marker（#70 与 #73 的关系）。 */
const MARKER = "// SHELL_NETWORK_MARKER";
const PWSH_LINE = "- id: persistent-pwsh";
const MIRROR = "\t* MIRROR HINT LINE.";
const MIRROR_PATTERN = /\n[ \t]*\* MIRROR HINT LINE\.\n/;

/** 写 marker 的那条：#70 的角色（自匹配型：产物以原文为前缀）。 */
function writerPatch() {
  return {
    id: 905,
    name: "SHARED_MARKER_WRITER",
    layer: "代码",
    desc: "写 marker 的补丁（自匹配）",
    file: "agent-loop",
    skipIfMarked: true,
    replacements: [{ pattern: PWSH_LINE, replace: `${PWSH_LINE} ${MARKER}` }],
    markers: [MARKER],
  };
}

/** 删除型、共享别人 marker 的那条：#73 的角色。 */
function removalPatch() {
  return {
    id: 906,
    name: "SHARED_MARKER_REMOVAL",
    layer: "提示词",
    desc: "删除型替换，marker 由别的补丁写",
    file: "agent-loop",
    onMiss: "ignore",
    skipIfMarked: true,
    markers: [MARKER],
    replacements: [{ pattern: MIRROR_PATTERN, replace: "\n" }],
  };
}

/** 现场：A 已打上（marker 在）、B 的待删文本还在 —— 真机上 73 就是这样。 */
const HOST_TEXT = `${PWSH_LINE} ${MARKER}\nconst x = 1;\n${MIRROR}\nconst y = 2;\n`;

function makeHost(text) {
  const aiBase = join(mkdtempSync(join(tmpdir(), "wp10-shared-marker-")), "node_modules", "@deepseek-ai");
  const dir = join(aiBase, "dsh-agent-loop", "lib");
  mkdirSync(dir, { recursive: true });
  const fp = join(dir, "index.js");
  writeFileSync(fp, text, "utf8");
  return { aiBase, fp };
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

/** 旧账本：没有逐补丁指纹 → `patchTableTrusted` 放行一次，marker 会被当成可信。 */
const LEGACY = { version: "2.1.0", sha: "fixture-rev" };

test("红灯：共享 marker 不许短路删除型补丁 —— apply 必须真删，删完判 applied", async () => {
  await withEnv(async () => {
    const patches = [writerPatch(), removalPatch()];
    const { aiBase, fp } = makeHost(HOST_TEXT);

    const before = await core.patchStatus(aiBase, patches, { identity: LEGACY });
    assert.equal(before[906], "pending", "待删文本还在，状态必须是 pending（这一条修前也成立）");

    const report = await core.applyPatches(aiBase, patches, { identity: LEGACY });
    const row = report.find((item) => item.patch_id === 906);
    assert.ok(row, "apply 报告里没有这条补丁");
    assert.equal(row.applied, 1, "marker 在、活没干完：这一轮必须真写那个文件");
    assert.equal(
      readFileSync(fp, "utf8").includes(MIRROR),
      false,
      "镜线还在文件里 —— marker 短路了删除型补丁的替换（真机上 73 永远 pending 就是这个）",
    );

    const after = await core.patchStatus(aiBase, patches, { identity: LEGACY });
    assert.equal(after[906], "applied", "删完之后必须判 applied，否则下一轮 apply 还会重打");
  });
});

test("幂等：删完之后再 apply，字节不变、状态仍是 applied", async () => {
  await withEnv(async () => {
    const patches = [writerPatch(), removalPatch()];
    const { aiBase, fp } = makeHost(HOST_TEXT);
    await core.applyPatches(aiBase, patches, { identity: LEGACY });
    const once = readFileSync(fp, "utf8");

    const second = await core.applyPatches(aiBase, patches, { identity: LEGACY });
    const row = second.find((item) => item.patch_id === 906);
    assert.equal(row.applied, 0, "第二轮不该再写这个文件");
    assert.equal(readFileSync(fp, "utf8"), once, "第二轮改了字节 —— 幂等破了");

    const status = await core.patchStatus(aiBase, patches, { identity: LEGACY });
    assert.equal(status[906], "applied", "第二轮之后状态必须还是 applied");
  });
});

test("护栏保留：写 marker 的那条是自匹配型，活干完了就必须短路（不许重叠）", async () => {
  await withEnv(async () => {
    const writer = writerPatch();
    const { aiBase, fp } = makeHost(`${PWSH_LINE}\n`);
    await core.applyPatches(aiBase, [writer], { identity: LEGACY });
    const once = readFileSync(fp, "utf8");
    assert.ok(once.includes(MARKER), "第一轮应当把 marker 写进去");

    const second = await core.applyPatches(aiBase, [writer], { identity: LEGACY });
    assert.equal(readFileSync(fp, "utf8"), once, "自匹配型 + marker 在：第二轮不许再叠一层");
    assert.equal(second.find((item) => item.patch_id === 905).applied, 0, "第二轮不该有写入");
  });
});
