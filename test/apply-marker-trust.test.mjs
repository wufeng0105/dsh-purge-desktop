/**
 * test/apply-marker-trust.test.mjs — apply 侧的痕量短路：表指纹不认时，marker 不许再替引擎决定「不用改」。
 *
 * 为什么单独立一份：状态侧改成内容派生以后，apply 侧仍按 `patch.skipIfMarked && patchApplied`
 * 直接返回原文。于是「状态说待应用、点应用却跳过、戳一写又变已生效」是同一个洞的两面。
 * 这里把三件事钉住：
 *   1. 账本里的表指纹与当前表不一致时，marker 不再短路，pattern 命中就必须真替换；
 *   2. 忽略 marker 之后 pattern 也没命中（旧正文里没有锚点），不许记成「本来就在目标态」，
 *      要落待应用并在报告里写清原因；
 *   3. 含插入片段的混合补丁（42、46）在忽略 marker 的路径上连打两次，第二次不得再插入。
 *
 * 文件内容全部按 LF 构造：引擎写盘前会把 CRLF 归一成 LF，夹具也按同一形态比对。
 */
import { test } from "node:test";
import assert from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "../lib/core.js";
import { fileContentKey, patchFingerprints } from "../lib/patch/table-fingerprint.js";

const PATCH_ID = 903;
const MARKER = "APPLY_TRUST_MARKER";
const OLD_BODY = "const TRUST_BODY = 'old';";
const NEW_BODY = "const TRUST_BODY = 'new'; // APPLY_TRUST_MARKER";

/** 合成补丁：marker 不变，替换正文换代。正文换代正是旧判据抓不到的形态。 */
function patchOf(replace) {
  return {
    id: PATCH_ID,
    name: "APPLY_TRUST_FIXTURE",
    layer: "代码",
    desc: "apply 侧指纹夹具",
    file: "agent-loop",
    skipIfMarked: true,
    replacements: [{ pattern: OLD_BODY, replace }],
    markers: [MARKER],
  };
}

/** 最小宿主：`<root>/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js`。 */
function makeHost(text) {
  const aiBase = join(mkdtempSync(join(tmpdir(), "wp3-apply-")), "node_modules", "@deepseek-ai");
  const dir = join(aiBase, "dsh-agent-loop", "lib");
  mkdirSync(dir, { recursive: true });
  const fp = join(dir, "index.js");
  writeFileSync(fp, text, "utf8");
  return { aiBase, fp };
}

function sha256Of(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/**
 * 账本：逐补丁指纹来自**上一版表**，于是当前表的指纹一定对不上。
 * `patchesWritten` 里放这条 id 是为了证明「写没写过」不是这轮要否证的东西 ——
 * 否证它的是表指纹本身。
 */
function staleIdentity(fp, text) {
  const previous = patchOf("const TRUST_BODY = 'older';");
  return {
    version: "2.1.0",
    sha: "fixture-rev",
    patchShas: patchFingerprints([previous]),
    patchesWritten: [String(PATCH_ID)],
    contentSha: { [fileContentKey(fp)]: sha256Of(text) },
  };
}

/** 判据要经 patchAppliesHere 的宿主面门禁；夹具与宿主面无关，强制成桌面面。 */
async function withFixtureHost(text, run) {
  const host = makeHost(text);
  const home = mkdtempSync(join(tmpdir(), "wp3-apply-home-"));
  const previous = {
    DSH_HOME: process.env.DSH_HOME,
    DSH_BASE: process.env.DSH_BASE,
    DSH_SURFACE: process.env.DSH_SURFACE,
  };
  process.env.DSH_HOME = home;
  process.env.DSH_BASE = host.aiBase;
  process.env.DSH_SURFACE = "desktop";
  try {
    return await run(host);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("红灯：表指纹不一致时，marker 在场也必须把旧正文改写成新正文", async () => {
  await withFixtureHost(`// ${MARKER}\n${OLD_BODY}\n`, async ({ aiBase, fp }) => {
    const identity = staleIdentity(fp, `// ${MARKER}\n${OLD_BODY}\n`);
    const report = await core.applyPatches(aiBase, [patchOf(NEW_BODY)], { identity });
    const text = readFileSync(fp, "utf8");
    assert.ok(text.includes(NEW_BODY), `换代载荷没有落盘：${JSON.stringify(text)}`);
    assert.ok(!text.includes(OLD_BODY), "旧正文仍在文件里，替换没有真的发生");
    const row = report.find((item) => item.patch_id === PATCH_ID);
    assert.equal(row.status, "applied", `apply 报告应记真替换，实际 ${row.status}`);
    assert.equal(row.applied, 1, "写过的文件数应为 1");
    assert.deepEqual(row.written_files, [fp], "报告要带上本轮真写过的文件，戳只按这份清单记账");
  });
});

test("红灯：忽略 marker 后 pattern 也没命中，不许记「本来就在目标态」", async () => {
  const other = "const SOMETHING_ELSE = 1;";
  await withFixtureHost(`// ${MARKER}\n${other}\n`, async ({ aiBase, fp }) => {
    const identity = staleIdentity(fp, `// ${MARKER}\n${other}\n`);
    const report = await core.applyPatches(aiBase, [patchOf(NEW_BODY)], { identity });
    const row = report.find((item) => item.patch_id === PATCH_ID);
    assert.equal(row.status, "pending", `没有锚点只能记待应用，实际 ${row.status}`);
    assert.match(String(row.reason || ""), /marker/, "报告要写清「marker 不可信、锚点也不在」这一档");
    assert.equal(readFileSync(fp, "utf8"), `// ${MARKER}\n${other}\n`, "没有锚点时文件不该被改动");
  });
});

test("混合补丁 42/46：忽略 marker 连打两次不重复插入，文件 sha256 不变", () => {
  const mixed = [42, 46].map((id) => {
    const patch = core.ALL_PATCHES.find((item) => item.id === id);
    assert.ok(patch, `补丁表里找不到混合型补丁 ${id}`);
    const replacement = (patch.replacements || []).find(
      (item) => typeof item.pattern === "string" && String(item.replace).includes(item.pattern),
    );
    assert.ok(replacement, `混合型补丁 ${id} 没有可构造的插入片段`);
    // 只保留这一条插入：另外几条的 pattern 不在夹具里，留着只会把失败归因搅混。
    return { id, patch: { ...patch, replacements: [replacement] }, replacement };
  });

  for (const { id, patch, replacement } of mixed) {
    const dir = mkdtempSync(join(tmpdir(), `wp3-idem-${id}-`));
    const fp = join(dir, "fixture.txt");
    const first = core.applyReplacementsToText(replacement.pattern, patch, "", { markerTrusted: false });
    assert.equal(first.changed, true, `补丁 ${id} 第一次没有插入，幂等判据失去对象`);
    writeFileSync(fp, first.text, "utf8");
    const shaAfterFirst = createHash("sha256").update(readFileSync(fp)).digest("hex");

    const second = core.applyReplacementsToText(first.text, patch, "", { markerTrusted: false });
    assert.equal(second.changed, false, `补丁 ${id} 第二次仍在插入：重复 apply 会把文件越叠越长`);
    assert.equal(second.text, first.text, `补丁 ${id} 第二次返回的文本变了`);
    writeFileSync(fp, second.text, "utf8");
    const shaAfterSecond = createHash("sha256").update(readFileSync(fp)).digest("hex");
    assert.equal(shaAfterSecond, shaAfterFirst, `补丁 ${id} 第二次写盘后文件字节变了`);
  }
});

test("同一轮里先插入 marker 的替换，不许把后面的插入片段误判成重复", () => {
  // 合成顺序：第一条插入把 marker 带进文本，第二条插入的 pattern 仍在。
  // 如果护栏按「循环中途的 marker」判断，第二条会被误判成已插入而跳过。
  const patch = {
    id: 942,
    name: "ORDER_FIXTURE",
    layer: "代码",
    desc: "同轮插入顺序夹具",
    file: "agent-loop",
    skipIfMarked: true,
    markers: ["ORDER_MARK"],
    replacements: [
      { pattern: "A_NEEDLE", replace: "A_NEEDLE // ORDER_MARK" },
      { pattern: "B_NEEDLE", replace: "/* inserted */ B_NEEDLE" },
    ],
  };
  const result = core.applyReplacementsToText("A_NEEDLE\nB_NEEDLE\n", patch, "", { markerTrusted: false });
  assert.equal(result.changed, true, "整条补丁没有改写");
  assert.ok(result.text.includes("ORDER_MARK"), "第一条插入没有落进去");
  assert.ok(result.text.includes("/* inserted */"), "第二条插入被同轮刚插入的 marker 误判成重复而跳过");

  const second = core.applyReplacementsToText(result.text, patch, "", { markerTrusted: false });
  assert.equal(second.changed, false, "第二次仍在改写：重复 apply 会越叠越长");
  assert.equal(second.text, result.text);
});

test("直调缺省仍按痕量护栏：不传可信标记时，marker 在场且 pattern 也在场按旧的保守路径走", () => {
  const patch = core.ALL_PATCHES.find((item) => item.id === 46);
  const replacement = (patch.replacements || []).find(
    (item) => typeof item.pattern === "string" && String(item.replace).includes(item.pattern),
  );
  const single = { ...patch, replacements: [replacement] };
  const once = core.applyReplacementsToText(replacement.pattern, single, "", { markerTrusted: false });
  const withResidual = `${once.text}\n${replacement.pattern}\n`;
  const guarded = core.applyReplacementsToText(withResidual, single);
  assert.equal(guarded.changed, false, "缺省必须沿用 marker 护栏，直调方否则会重复插入");
  const stripped = single.markers.reduce((text, marker) => text.split(marker).join(""), withResidual);
  assert.equal(
    core.applyReplacementsToText(stripped, single).changed,
    true,
    "marker 不在时护栏不该短路：那会把「还差这一步」冻住",
  );
});
