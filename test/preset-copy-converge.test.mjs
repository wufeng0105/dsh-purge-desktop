/**
 * test/preset-copy-converge.test.mjs — 迁移之后副本仍报「不一致」，用户得有一条能收敛的路。
 *
 * ## 现场
 *
 * `installPreset` 在目标已存在时只做**定点自愈**（换占位符 / 修包名 / 修派活 / 删宿主不收的
 * 字段），不整份覆盖 —— 这条本意是保住用户自己改过的注释与顺序。代价是：副本里若还留着
 * **旧注释、旧正文**，`presetCopyReport` 会一直报 `drifted > 0`，面板上就是「不一致（1 处）」
 * 长期挂着，而收敛的唯一开关是启动时的 `REDTEAM_PRESET_REFRESH=1`（面板上点不到）。
 *
 * ## 本文件锁什么（T22 选 (a)「迁移即重渲染」）
 *
 *   一、**确认是旧格式就整份重渲染**：副本里带宿主不再接受的字段 + 旧正文 → 跑一次迁移
 *      → 副本与仓库渲染逐字节一致（`drifted` 归零），且旧副本被备份到
 *      `$DSH_HOME/dsh-purge/backups/preset/<戳>/`；
 *   二、**不确认是旧格式就不动**：只有用户自己的改动（没有旧字段）时，迁移不触发刷新，
 *      用户改动原样保留、`drifted` 保持（那是「用户自己的副本」，不是缺陷）。
 *
 * 夹具全在临时 `$DSH_HOME` 里：`installBundledSkills` / `syncAnchorGate` 写的也是那棵临时树，
 * 真实 `~/.dsh` 一个字节不碰。诊断日志关掉（`DSH_PURGE_LOG=0`）。
 */
import { test } from "node:test";
import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DSH_PURGE_LOG = "0";

const { installPreset, presetCopyReport } = await import("../lib/redteam/index.js");

/** 临时 DSH_HOME 里跑一段，跑完恢复环境变量并删树。 */
async function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "dsh-purge-wp13-preset-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

const copyOf = (home) => join(home, ".agent-presets", "redteam", "agent.cordis.yml");

test("收敛：旧格式副本跑一次迁移后与仓库渲染一致，旧副本留了备份", async () => {
  await withHome((home) => {
    /* 先按仓库模板装一份（等价首次安装）。 */
    installPreset({ force: true, log: () => {} });
    const before = presetCopyReport();
    assert.equal(before.drifted, 0, "首次安装后副本就该与仓库一致");

    /* 造一份「旧格式」：加回宿主不再接受的字段 + 一行旧自愈插进来的转义重复行。 */
    const file = copyOf(home);
    const text = readFileSync(file, "utf8");
    writeFileSync(file, `${text}  toolFilter: {}\n<!-- old-body: 旧版本的注释与正文 -->\n`, "utf8");
    const drifted = presetCopyReport();
    assert.ok(drifted.drifted >= 1, "夹具没有造出漂移：后面的收敛判据就无从谈起");

    /* 跑迁移（不带 force：走的是「已存在 → 定点自愈」那条路径）。 */
    const result = installPreset({ log: () => {} });
    assert.equal(result.action, "repaired", `迁移没有触发修复（action=${result.action}）`);
    assert.match(String(result.repaired), /preset-refreshed/, "没有记录「整份刷新」这一步");

    const after = presetCopyReport();
    assert.equal(after.drifted, 0, "迁移之后副本仍与仓库不一致 —— 用户没有任何办法收敛");
    assert.equal(
      readFileSync(copyOf(home), "utf8"),
      readFileSync(join(import.meta.dirname, "..", "presets", "redteam", "agent.cordis.yml"), "utf8")
        .replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
      "副本没有回到仓库模板的字节",
    );

    const backupRoot = join(home, "dsh-purge", "backups", "preset");
    assert.ok(existsSync(backupRoot), "覆盖之前没有留备份目录");
    const stamps = readdirSync(backupRoot);
    assert.equal(stamps.length, 1, `备份目录应恰好一份，实得 ${stamps.join("、")}`);
    assert.ok(
      readFileSync(join(backupRoot, stamps[0], "agent.cordis.yml"), "utf8").includes("old-body"),
      "备份里没有旧副本的内容（备份等于没做）",
    );
  });
});

test("对照：只有用户自己的改动时不动副本（迁移不触发整份刷新）", async () => {
  await withHome((home) => {
    installPreset({ force: true, log: () => {} });
    const file = copyOf(home);
    const marker = "# 用户自己加的注释：别覆盖我";
    writeFileSync(file, `${readFileSync(file, "utf8")}\n${marker}\n`, "utf8");
    assert.ok(presetCopyReport().drifted >= 1, "用户改动本来就会让比对报差异");

    const result = installPreset({ log: () => {} });
    assert.equal(result.action, "kept", `没有旧格式信号时不该动副本（action=${result.action}）`);
    assert.ok(
      readFileSync(file, "utf8").includes(marker),
      "用户自己的注释被覆盖了：这条路径只该在「确认是旧格式」时触发",
    );
    assert.ok(presetCopyReport().drifted >= 1, "对照场景的漂移应保留（那是用户的副本，不是缺陷）");
  });
});
