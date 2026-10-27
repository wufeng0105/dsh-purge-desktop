/**
 * test/preset-copy.test.mjs — 预设两件事：旧副本要迁到新形状，仓库与已装副本的差异要留痕。
 *
 * 为什么需要这条用例：`installPreset` 在目标已存在时只做定点自愈、不整份覆盖，
 * 所以仓库模板删掉宿主拒收的字段之后，机器上那份旧副本仍然带着它们 —— 升级后的
 * 模式下拉照样「加载失败」，而仓库里看不出任何异常。迁移与漂移是同一件事的两面：
 * 迁移动的是副本内容，漂移记的是「仓库那一份是什么、盘上那一份是什么」。
 *
 * 判据三条：
 *   一、仓库模板本身解析得动，且任何一行里都不再出现宿主硬抛的字段；
 *   二、旧副本里的字段在 `installPreset({force:false})` 之后消失，动作报 `repaired`；
 *   三、副本被动过一个字节之后，诊断轨出现 `preset.drift`，两侧 sha256 不相等；
 *      没动过则一条都不出现 —— 否则这一行永远在报警，等于没有这一行。
 */
import { test } from "node:test";
import assert from "node:assert";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as redteam from "../lib/redteam/index.js";
import { readPresetDefinition } from "../lib/redteam/preset-composition.js";

const ROOT = join(import.meta.dirname, "..");
/** 迁移后不许再出现的两个字段：前者宿主 `apply()` 直接抛，后者宿主 Config 里没有这个键。 */
const RETIRED_FIELDS = ["toolFilter", "backgroundMode"];

/**
 * 在临时 `DSH_HOME` 里跑一段，跑完恢复环境。
 *
 * `USERPROFILE` / `HOME` 一起指过去：`installBundledSkills` 会往「另一个 home」补一份技能，
 * 不换的话用例会写到开发机自己的 `~/.dsh` 上 —— 判据不该有这种副作用。
 *
 * @param {(home:string) => void} fn
 */
function withTempHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "dsh-purge-preset-"));
  const saved = {
    DSH_HOME: process.env.DSH_HOME,
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
  };
  process.env.DSH_HOME = home;
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    fn(home);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * 造一份「升级前装下的副本」：模板取冻结夹具，旁边两个随包文件取仓库现值。
 *
 * 锚点门脚本也一起放：少了它 `syncAnchorGate` 会先报 `updated`，迁移那次改动就
 * 混在别的自愈里，判据分不出是哪一个字段让它变成 `repaired` 的。
 *
 * @param {string} home 临时 `DSH_HOME`
 * @returns {string} 副本目录
 */
function seedOldCopy(home) {
  const dir = join(home, ".agent-presets", "redteam");
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(ROOT, "test", "fixtures", "preset", "agent.cordis.old.yml"), join(dir, "agent.cordis.yml"));
  copyFileSync(join(ROOT, "presets", "redteam", "preset.yml"), join(dir, "preset.yml"));
  copyFileSync(join(ROOT, "presets", "redteam", "anchor-gate.mjs"), join(dir, "anchor-gate.mjs"));
  return dir;
}

/** 诊断轨里某一类事件；文件不存在时给空数组，与「没写过」是同一件事。 */
function diagEvents(home, event) {
  const file = join(home, "dsh-purge", "logs", "diag.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((row) => row.event === event);
}

test("仓库模板：解析得出插件行，且没有宿主拒收的字段", () => {
  const definition = readPresetDefinition("redteam", join(ROOT, "presets", "redteam"));
  assert.ok(Array.isArray(definition.plugins) && definition.plugins.length > 0, "仓库模板解析不出插件行");
  const text = JSON.stringify(definition.plugins);
  for (const field of RETIRED_FIELDS) {
    assert.ok(!text.includes(field), `仓库模板里还有 ${field}：宿主会因为这一个键让整个预设挂不上`);
  }
});

test("迁移：旧副本里的 toolFilter / backgroundMode 被删掉，动作报 repaired", () => {
  withTempHome((home) => {
    const dir = seedOldCopy(home);
    const file = join(dir, "agent.cordis.yml");
    const before = readFileSync(file, "utf8");
    for (const field of RETIRED_FIELDS) {
      assert.ok(before.includes(field), `夹具不是升级前的形状：里面没有 ${field}`);
    }

    const result = redteam.installPreset({ force: false, log: () => {} });

    const after = readFileSync(file, "utf8");
    for (const field of RETIRED_FIELDS) {
      /* 判「键还在不在」，不要判「这个词还出不出现」：仓库模板现在有一行说明写着
         「宿主已不接受 toolFilter……」，子串判法会把那行注释当成残留字段（迁移之后
         副本会被整份重渲染成模板，注释也跟着来）。 */
      assert.ok(
        !new RegExp(`^\\s*${field}:`, "m").test(after),
        `迁移之后副本里还有 ${field} 键：用户升级后模式下拉照样加载失败`,
      );
    }
    assert.equal(result.action, "repaired", `已有副本被原地改写时必须报 repaired，实际 ${result.action}`);
    assert.ok(String(result.repaired || "").includes("preset-fields"), `repaired 里没有这次迁移：${result.repaired}`);
    // 迁移不许把副本改成解析不动的形状：宿主读的是这一份，不是仓库那一份。
    assert.ok(readPresetDefinition("redteam", dir).plugins.length > 0, "迁移后的副本解析不出插件行");
    assert.equal(diagEvents(home, "preset.migrated").length, 1, "迁移没有在诊断轨留下 preset.migrated 事件");
  });
});

test("重复行迁移：旧派活自愈留下的转义重复被删掉，副本回到仓库形状", () => {
  withTempHome((home) => {
    redteam.installPreset({ force: true, log: () => {} });
    const file = join(home, ".agent-presets", "redteam", "agent.cordis.yml");
    const lines = readFileSync(file, "utf8").split("\n");
    const at = lines.findIndex((line) => line.includes("必须用原生 `subagent` 工具派活"));
    assert.ok(at >= 0, "模板里没有那句派活约束：夹具取样点变了");
    /* 旧版自愈的行为：在原行下面再插一条带反斜杠的同一句。 */
    lines.splice(at + 1, 0, lines[at].replace(/`/g, "\\`"));
    writeFileSync(file, lines.join("\n"), "utf8");
    assert.ok(readFileSync(file, "utf8").includes("\\`subagent\\` 工具派活"), "夹具没造出转义重复");

    const result = redteam.installPreset({ force: false, log: () => {} });

    const after = readFileSync(file, "utf8");
    assert.ok(after.includes("必须用原生 `subagent` 工具派活"), "把正常那句也删了：判据该只删转义重复");
    assert.ok(!after.includes("\\`subagent\\` 工具派活"), "转义重复还在：副本与仓库永远差一行");
    assert.equal(result.action, "repaired", `删了行却报 ${result.action}`);
    assert.ok(String(result.repaired || "").includes("preset-fields"), `repaired 里没有这次迁移：${result.repaired}`);
    assert.equal(redteam.presetCopyReport().drifted, 0, "迁移之后副本仍与仓库不一致");
  })
});

test("漂移：改一个字节后出现 preset.drift，两侧 sha256 不同；不改则一条都没有", () => {
  withTempHome((home) => {
    redteam.installPreset({ force: true, log: () => {} });
    assert.equal(typeof redteam.presetCopyReport, "function", "lib/redteam/index.js 没有导出 presetCopyReport：健康块那一行没有数据源");
    assert.equal(redteam.presetCopyReport().drifted, 0, "全新安装后仓库与副本应当一致");
    assert.deepEqual(diagEvents(home, "preset.drift"), [], "一致的时候不写漂移事件，否则这一行永远在报警");

    const file = join(home, ".agent-presets", "redteam", "agent.cordis.yml");
    const text = readFileSync(file, "utf8");
    const edited = text.replace("（由 standard 复制改造）", "（由 standard 复制改造；这一份被改过）");
    assert.notEqual(edited, text, "夹具没被改到：漂移用例的取样点失效了");
    writeFileSync(file, edited, "utf8");

    redteam.installPreset({ force: false, log: () => {} });

    const rows = diagEvents(home, "preset.drift");
    const row = rows.find((item) => item.file === "agent.cordis.yml");
    assert.ok(row, `副本被改过却没有 preset.drift 事件：${JSON.stringify(rows)}`);
    assert.notEqual(row.installedSha, row.repoSha, "两侧 sha256 相同：记的不是副本那一版");
    assert.ok(row.repoSha && row.installedSha, "事件缺一侧的 sha256：读的人分不清是「没有这一份」还是「不一样」");
    assert.equal(redteam.presetCopyReport().drifted, 1, "健康块读到的漂移数与事件对不上");
  });
});
