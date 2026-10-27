/**
 * test/patch-rollup-parity.test.mjs — 状态侧与 apply 侧必须是同一套汇总，pending 不许被 applied 盖住。
 *
 * 为什么单独立一份：逐文件事实只有一份，但汇总原先各算一遍，优先级还相反 ——
 * 状态侧 pending 优先，apply 侧 applied 优先。于是「同一个补丁的一个文件已打上、
 * 另一个文件还有活」在设置页是 pending、在本轮汇总里是 applied。读日志的人
 * 不可能判断该信哪一个，而这种偏差不会让任何一条已有用例变红。
 *
 * 红灯：构造 `pending > 0` 且 `applied > 0` 的文件对，两侧必须都给 pending。
 */
import { test } from "node:test";
import assert from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import * as core from "../lib/core.js";
import { rollupPatchStatus } from "../lib/patch/rollup.js";
import { fileContentKey, patchFingerprints } from "../lib/patch/table-fingerprint.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PATCH_ID = 902;

/**
 * 一条补丁两个文件的夹具。
 *
 * 「还有活」按「再跑一次替换会不会改文本」算（`patchHasRemainingWork` 的现行判据），
 * 所以 pending 一侧必须是**真会被改写**的原文：占位式的空替换（`replace: "$&"`）
 * 改写结果与原文逐字相同，那不算活 —— 拿它当 pending 就是在用旧判据的漏洞造红。
 * 另一侧只放 marker，代表已打上。
 */
function patchOf() {
  return {
    id: PATCH_ID,
    name: "ROLLUP_PARITY_FIXTURE",
    layer: "代码",
    desc: "汇总一致性夹具",
    file: ["agent-loop", "settings"],
    // 产物带 marker：被打上的文件同时进入「已生效」态，第二轮才判得出 already。
    replacements: [{ pattern: /PARITY_NEEDLE/, replace: "PARITY_PATCHED // PARITY_MARKER" }],
    markers: ["PARITY_MARKER"],
  };
}

function makeHost() {
  const aiBase = join(mkdtempSync(join(tmpdir(), "wp2-parity-")), "node_modules", "@deepseek-ai");
  const applied = join(aiBase, "dsh-agent-loop", "lib", "index.js");
  const pending = join(aiBase, "dsh-settings", "lib", "index.js");
  mkdirSync(dirname(applied), { recursive: true });
  mkdirSync(dirname(pending), { recursive: true });
  writeFileSync(applied, "// PARITY_MARKER\nconst done = true;\n", "utf8");
  writeFileSync(pending, "const PARITY_NEEDLE = 1;\n", "utf8");
  return { aiBase, applied, pending };
}

function sha256OfFile(fp) {
  return createHash("sha256").update(readFileSync(fp)).digest("hex");
}

async function withDesktop(run) {
  const previousSurface = process.env.DSH_SURFACE;
  process.env.DSH_SURFACE = "desktop";
  try {
    return await run();
  } finally {
    if (previousSurface === undefined) delete process.env.DSH_SURFACE;
    else process.env.DSH_SURFACE = previousSurface;
  }
}

test("红灯：pending 与 applied 各一个文件时，汇总只能是 pending", () => {
  const mixed = rollupPatchStatus({ outcomes: ["applied", "pending"], keyCount: 2 });
  assert.equal(mixed, "pending", "applied 先于 pending 就是这条判据原来的错");
  // 反过来排也一样：结论不许随文件顺序变化。
  assert.equal(rollupPatchStatus({ outcomes: ["pending", "applied"], keyCount: 2 }), "pending");
});

test("两侧的输入形状走同一个函数：状态侧（无写入）与 apply 侧（有写入）都给 pending", () => {
  const statusSide = rollupPatchStatus({ outcomes: ["applied", "pending"], keyCount: 2, onMiss: "fail" });
  const applySide = rollupPatchStatus({ outcomes: ["applied", "pending"], keyCount: 2, written: 0, onMiss: "fail" });
  assert.equal(statusSide, "pending");
  assert.equal(applySide, statusSide, "同一份逐文件事实在两处算出了不同结论");
  // 真写过文件时 applied 才允许出现：写入是「这一轮改过字节」的证据，不能靠逐文件兜底冒充。
  assert.equal(rollupPatchStatus({ outcomes: ["applied"], written: 1, keyCount: 1 }), "applied");
  assert.equal(rollupPatchStatus({ outcomes: ["applied"], written: 0, keyCount: 1 }), "already");
});

test("端到端：一个文件已打上、一个还有活 → 状态侧 pending，apply 侧真去干活", async () => {
  await withDesktop(async () => {
    const patch = patchOf();
    const { aiBase, applied, pending } = makeHost();
    // 账本只登记已打上那个文件的字节；另一个文件没有内容指纹，按痕量判成「还有活」。
    const identity = {
      version: "2.1.0",
      sha: "fixture-rev",
      patchShas: patchFingerprints([patch]),
      contentSha: { [fileContentKey(applied)]: sha256OfFile(applied) },
      patchesWritten: [String(PATCH_ID)],
    };
    const status = await core.patchStatus(aiBase, [patch], { identity });
    assert.equal(status[PATCH_ID], "pending", "状态侧：一个文件已打上、一个还有活 → pending");

    // apply 侧：同一份逐文件事实下，这一轮必须真写那个还有活的文件，而不是报 already。
    const report = await core.applyPatches(aiBase, [patch], { identity });
    const row = report.find((item) => item.patch_id === PATCH_ID);
    assert.ok(row, "apply 报告里没有这条补丁");
    assert.equal(row.status, "applied", "apply 侧把「还有活」读成「已打上」就会漏写文件");
    assert.equal(row.applied, 1, "只该写那一个还有活的文件");
    assert.equal(
      readFileSync(pending, "utf8"),
      "const PARITY_PATCHED // PARITY_MARKER = 1;\n",
      "还有活的那个文件必须被打上",
    );
    assert.equal(readFileSync(applied, "utf8"), "// PARITY_MARKER\nconst done = true;\n", "已打上的文件不许被再写");

    // 第二轮两侧都必须收敛到「没活」：状态侧 applied，apply 侧 already。
    const second = await core.patchStatus(aiBase, [patch], { identity });
    assert.equal(second[PATCH_ID], "applied", "打完之后状态侧必须收敛到 applied");
    const again = (await core.applyPatches(aiBase, [patch], { identity })).find((i) => i.patch_id === PATCH_ID);
    assert.equal(again.status, "already", "没有活的一轮不许再写字节");
  });
});

test("汇总只有一份实现：core.js 里不许再长出第二套优先级", () => {
  const source = readFileSync(join(ROOT, "lib", "core.js"), "utf8");
  assert.ok(!/function\s+rollupPatchStatus\s*\(/.test(source), "core.js 里又出现了一份本地汇总函数");
  const callSites = [...source.matchAll(/rollupPatchStatus\s*\(\s*\{/g)].length;
  assert.ok(callSites >= 2, `状态侧与 apply 侧都要调同一个汇总函数，实际调用点 ${callSites} 个`);
});
