/**
 * test/revert-content-parity.test.mjs — 「已还原」要拿字节比，不是拿四个计数暗示。
 *
 * 为什么单独立一份：`/revert` 与 `/uninstall` 原先只返回 `reverted` / `skipped` /
 * `preservedUser` / `dropped` 四个计数。一个文件被还原、被跳过、被占用、或者清洗痕迹
 * 没拆干净，计数照样好看 —— 「宿主文件回到原版了吗」这个问题没有任何一层在回答。
 *
 * 判据三档，全部要可见：
 *   与官方快照逐字节相同   → 还原成立
 *   有快照但对不上 / 没有快照却仍带本插件写的痕迹 → 判红（那种文件不可能是官方原文）
 *   没有快照也不带痕迹     → 不可判（**不算通过**）
 *
 * 红灯：手工改一个目标文件后再判，必须点出这个文件「与官方快照不一致」。
 */
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "../lib/core.js";

const KEYS = {
  agentLoop: ["dsh-agent-loop", "lib", "index.js"],
  settings: ["dsh-settings", "lib", "index.js"],
  fsSandbox: ["dsh-fs-sandbox", "lib", "index.js"],
  hooks: ["dsh-hooks-claude-code", "lib", "index.js"],
};

const OFFICIAL = "// official host file\nexport const answer = 42;\n";
const TAMPERED = `${OFFICIAL}// [dsh-purge] 手工塞进去的痕迹\n`;

/** 造宿主并指一个临时主目录：快照库落在临时目录里，绝不碰本机真实保险柜。 */
function makeHost() {
  const root = mkdtempSync(join(tmpdir(), "wp2-revert-"));
  const aiBase = join(root, "node_modules", "@deepseek-ai");
  return { root, aiBase, home: join(root, ".dsh") };
}

function fileOf({ aiBase }, key, text) {
  const fp = join(aiBase, ...KEYS[key]);
  mkdirSync(join(fp, ".."), { recursive: true });
  writeFileSync(fp, text, "utf8");
  return fp;
}

async function withHome(home, run) {
  const previousHome = process.env.DSH_HOME;
  const previousSurface = process.env.DSH_SURFACE;
  process.env.DSH_HOME = home;
  process.env.DSH_SURFACE = "desktop";
  try {
    return await run();
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    if (previousSurface === undefined) delete process.env.DSH_SURFACE;
    else process.env.DSH_SURFACE = previousSurface;
  }
}

test("还原后判据成立：有快照的文件逐字节回到官方，判据给 ok", async () => {
  const host = makeHost();
  await withHome(host.home, async () => {
    const a = fileOf(host, "agentLoop", OFFICIAL);
    const b = fileOf(host, "settings", OFFICIAL);
    await core.backupAll(host.aiBase, { dshHome: host.home });
    // 打上痕迹（模拟插件写过），再还原。
    writeFileSync(a, TAMPERED, "utf8");
    writeFileSync(b, TAMPERED, "utf8");

    const result = await core.revertAll(host.aiBase, {});
    assert.deepEqual(result.errors, [], "还原不该报错");
    assert.ok(result.reverted.includes(a), "有快照的文件必须被还原，计数里漏了它就是没还原");
    assert.equal(readFileSync(a, "utf8"), OFFICIAL, "还原必须逐字节写回官方快照");
    assert.ok(result.parity, "revertAll 必须带内容判据 —— 只有计数等于没人回答「回到原版没有」");
    assert.equal(result.parity.ok, true, `还原后不该有判红文件：${JSON.stringify(result.parity.mismatched)}`);
    assert.ok(result.parity.matched.includes(a), "判据要能点名「核对过」的文件");
    assert.ok(result.parity.matched.includes(b));
  });
});

test("红灯：手工改一个目标文件后再判，必须点出它与官方快照不一致", async () => {
  const host = makeHost();
  await withHome(host.home, async () => {
    const a = fileOf(host, "agentLoop", OFFICIAL);
    await core.backupAll(host.aiBase, { dshHome: host.home });
    await core.revertAll(host.aiBase, {});

    // 还原之后又被人改了一笔：这正是「已还原」这句话最容易被说错的时候。
    writeFileSync(a, `${OFFICIAL}// 手工改动\n`, "utf8");
    const parity = core.revertContentParity(host.aiBase);
    assert.equal(parity.ok, false, "文件与官方快照不一致时必须判红");
    const hit = parity.mismatched.find((row) => row[0] === a);
    assert.ok(hit, `判据没有点名这个文件：${JSON.stringify(parity.mismatched)}`);
    assert.equal(hit[1], "differs-from-snapshot", "判红的原因要写成「与快照不一致」，不是含糊的一句话");
  });
});

test("不可判与判红分开：没有快照又不带痕迹 → 不可判；带痕迹 → 判红", async () => {
  const host = makeHost();
  await withHome(host.home, async () => {
    fileOf(host, "agentLoop", OFFICIAL);
    await core.backupAll(host.aiBase, { dshHome: host.home });
    // 两个文件在快照之后才出现：一个干净、一个带本插件写的痕迹。
    const clean = fileOf(host, "fsSandbox", OFFICIAL);
    const dirty = fileOf(host, "hooks", TAMPERED);

    const parity = core.revertContentParity(host.aiBase);
    assert.ok(parity.unscanned.includes(clean), "没有快照也没有痕迹的文件只能记「不可判」");
    assert.equal(parity.complete, false, "存在不可判的文件时不许说「全量核对通过」");
    assert.equal(parity.ok, false, "带清洗痕迹又没有快照的文件必须判红 —— 它不可能是官方原文");
    assert.ok(
      parity.mismatched.some((row) => row[0] === dirty && row[1] === "leftover-purge-marker"),
      `判红原因要能读出「痕迹还在」：${JSON.stringify(parity.mismatched)}`,
    );
  });
});
