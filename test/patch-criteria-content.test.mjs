/**
 * test/patch-criteria-content.test.mjs — 「已生效」必须由内容与表指纹给出，marker 只是 fast path。
 *
 * 为什么单独立一份：同一个判据原先只看 marker。于是「替换正文换代、marker 没变」这条
 * 补丁永远判已生效，启动不重打，宿主文件停在旧内容上，而面板是绿的。这个失效没有症状，
 * 只有把「正文改了」这件事真的喂给判据一次，才看得见它原来没被判出来。
 *
 * 红灯就是本文件的主用例：
 *   只改某条补丁的 `replace` 正文、不动 marker → 判据必须给 pending；
 *   改回原正文 → 必须复原成 applied。
 *
 * 另外三条是它的边界：内容指纹否证 marker、新补丁不在账本里、旧账本没有指纹。
 * 全部走真实入口 `core.patchStatus()`，不测私有函数 —— 判据写在哪儿不重要，
 * 「状态报什么」才重要。
 */
import { test } from "node:test";
import assert from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "../lib/core.js";
import { fileContentKey, patchFingerprints, tableFingerprint } from "../lib/patch/table-fingerprint.js";

const PATCH_ID = 901;
const MARKER = "CONTENT_CRITERIA_MARKER";
const NEEDLE = "const BANNER_ORIGINAL = 1;";
const BODY_V2 = `const BANNER_V2 = 2; // ${MARKER}`;
const BODY_V3 = `const BANNER_V3 = 3; // ${MARKER}`;

/** marker 与正文分开：正文换代时 marker 不变，这正是旧判据抓不到的形态。 */
function patchOf(body) {
  return {
    id: PATCH_ID,
    name: "CONTENT_CRITERIA_FIXTURE",
    layer: "代码",
    desc: "判据夹具",
    file: "agent-loop",
    replacements: [{ pattern: NEEDLE, replace: body }],
    markers: [MARKER],
  };
}

/**
 * 造一个最小宿主：`<root>/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js`。
 * 键名与宿主目标表里的 `agent-loop` 一致，判据才会把它当目标文件。
 */
function makeHost(text) {
  const aiBase = join(mkdtempSync(join(tmpdir(), "wp2-content-")), "node_modules", "@deepseek-ai");
  const dir = join(aiBase, "dsh-agent-loop", "lib");
  mkdirSync(dir, { recursive: true });
  const fp = join(dir, "index.js");
  writeFileSync(fp, text, "utf8");
  return { aiBase, fp };
}

function sha256Of(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/** 账本：表指纹 + 逐补丁指纹 + 收尾时的内容指纹 + 写入清单，四者缺一不可。 */
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

/** 判据要经 patchAppliesHere 的宿主面门禁；夹具与宿主面无关，强制成桌面面。 */
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

test("红灯：只改 replace 正文、不动 marker → pending；改回正文 → 复原 applied", async () => {
  await withEnv(async () => {
    const applied = patchOf(BODY_V2);
    const { aiBase, fp } = makeHost(`// ${MARKER}\n${BODY_V2}\n`);
    const identity = stampFor(applied, `// ${MARKER}\n${BODY_V2}\n`, fp);

    const before = await core.patchStatus(aiBase, [applied], { identity });
    assert.equal(before[PATCH_ID], "applied", "夹具本身就是已应用态，判据必须先认它");

    // 改正文：marker 字面量与文件都没动，只有替换正文换代。
    const changed = patchOf(BODY_V3);
    const afterBodyChange = await core.patchStatus(aiBase, [changed], { identity });
    assert.equal(
      afterBodyChange[PATCH_ID],
      "pending",
      "替换正文换代、marker 未变时判据必须给 pending —— 这就是旧判据的漏网形态",
    );

    const restored = await core.patchStatus(aiBase, [applied], { identity });
    assert.equal(restored[PATCH_ID], "applied", "正文改回去必须复原 —— 否则判据是在乱报");
  });
});

test("内容指纹否证 marker：marker 在、字节不是收尾时那份 → pending", async () => {
  await withEnv(async () => {
    const patch = patchOf(BODY_V2);
    const { aiBase, fp } = makeHost(`// ${MARKER}\n${BODY_V2}\n`);
    const identity = stampFor(patch, `// ${MARKER}\n${BODY_V2}\n`, fp);
    // 把收尾时记下的字节指纹换成另一份：文件被动过，marker 却还在。
    identity.contentSha[fileContentKey(fp)] = sha256Of("something else entirely");

    const status = await core.patchStatus(aiBase, [patch], { identity });
    assert.equal(status[PATCH_ID], "pending", "marker 不是内容证据：字节对不上就不能自称已生效");
  });
});

test("账本里有指纹但没有这一条 → 不认 marker（新补丁不许靠痕量自证）", async () => {
  await withEnv(async () => {
    const patch = patchOf(BODY_V2);
    const { aiBase, fp } = makeHost(`// ${MARKER}\n${BODY_V2}\n`);
    const identity = stampFor(patch, `// ${MARKER}\n${BODY_V2}\n`, fp);
    // 换一条补丁的指纹占位：账本非空，但这一条不在里面（等价于「表里新加的补丁」）。
    identity.patchShas = { 902: "0".repeat(64) };

    const status = await core.patchStatus(aiBase, [patch], { identity });
    assert.equal(status[PATCH_ID], "pending", "新补丁的 marker 可能撞官方原文，不能单独当证据");
  });
});

test("旧账本没有指纹字段时按痕量放行一次，且不抛错（启动路径会补写指纹）", async () => {
  await withEnv(async () => {
    const patch = patchOf(BODY_V2);
    const { aiBase } = makeHost(`// ${MARKER}\n${BODY_V2}\n`);
    const legacy = { version: "2.1.0", sha: "fixture-rev" };

    const status = await core.patchStatus(aiBase, [patch], { identity: legacy });
    assert.equal(status[PATCH_ID], "applied", "旧账本只有痕量可读：放行一次，交给启动路径补指纹");
  });
});

test("未应用态与不适用态不受新判据影响：pattern 还在 → pending，文件缺 → na", async () => {
  await withEnv(async () => {
    const patch = patchOf(BODY_V2);
    const pendingHost = makeHost(NEEDLE);
    const noStamp = { version: "2.1.0", sha: "fixture-rev" };
    const pending = await core.patchStatus(pendingHost.aiBase, [patch], { identity: noStamp });
    assert.equal(pending[PATCH_ID], "pending", "原文还在就是还没打上，与账本有没有指纹无关");

    const missingHost = { aiBase: mkdtempSync(join(tmpdir(), "wp2-empty-")) };
    const optional = { ...patch, onMiss: "warn" };
    const missing = await core.patchStatus(missingHost.aiBase, [optional], { identity: noStamp });
    assert.equal(missing[PATCH_ID], "na", "可选补丁在缺件的宿主上记「这一版不需要」，不是失败");
  });
});

test("设置不改写状态：hooksDenyBypass 只进 reason，status 逐 id 不变", async () => {
  await withEnv(async () => {
    // 设置落在主目录里：指一个临时主目录，别碰本机上一次安装留下的开关。
    const home = mkdtempSync(join(tmpdir(), "wp2-settings-"));
    const previousHome = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    try {
      const patch = { ...patchOf(BODY_V2), id: 30, name: "HOOK_DENY_FIXTURE" };
      const { aiBase } = makeHost(`// ${MARKER}\n${BODY_V2}\n`);
      const identity = { version: "2.1.0", sha: "fixture-rev" };

      const reasonsOn = {};
      core.setHooksDenySettings({ hooksDenyBypass: true });
      const statusOn = await core.patchStatus(aiBase, [patch], { identity, reasons: reasonsOn });

      const reasonsOff = {};
      core.setHooksDenySettings({ hooksDenyBypass: false });
      const statusOff = await core.patchStatus(aiBase, [patch], { identity, reasons: reasonsOff });

      assert.deepEqual(statusOff, statusOn, "开关动了 status —— 状态里混进了与内容无关的变量");
      assert.deepEqual(Object.keys(reasonsOn), [], "开关为开时不该有说明");
      assert.deepEqual(
        Object.keys(reasonsOff).sort(),
        ["30", "31", "64", "65"],
        "开关为关时四条 hook 拦截补丁各有一条说明，读的人才知道它们这轮为什么没动",
      );
    } finally {
      core.setHooksDenySettings({ hooksDenyBypass: true });
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
    }
  });
});
