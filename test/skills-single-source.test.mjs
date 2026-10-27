/**
 * test/skills-single-source.test.mjs — 技能目录只有一个枚举实现，两个读者给出同一集合。
 *
 * ## 为什么不许各读各的
 *
 * 同一份磁盘技能集原先被三处用不同规则枚举：设置页（`/dsh-purge/skills`）只扫
 * `$DSH_HOME/skills`；演练台（`/redteam/api` 的 `skillCatalog`）合并「官方目录 + 红队库」
 * 并按名去重；preset 的 `skill-filesystem` 又用两根 `customSkillDirs`。三处各自自洽，
 * 只是给出的集合可以不一样 —— 而「不一样」没有任何症状：两个页面都像是完整的。
 *
 * 收编之后枚举只有一处：`lib/state/skills-catalog.js`（目录清单 + 优先级 + 库归属）。
 * 两个读者只做两件事：把自己那套条目形状喂进去、把结果按自己的字段名摊出来。
 *
 * ## 三条判据
 *
 *   一、**根的顺序来自 preset**：`SKILL_ROOT_ORDER` 必须与
 *      `presets/redteam/agent.cordis.yml` 里 `customSkillDirs` 的书写顺序一致。同名取先
 *      出现者（遮蔽），不是重复项：`$DSH_HOME/skills` 排在前面，用户自己配好的那份才不会被
 *      随包模板（正文里是 `<你的VPS_IP>` 这类占位符）盖住。
 *   二、**两个读者同一集合**：同一份夹具喂给 `lib/skills.js` 与 `lib/redteam/ui.js` 的
 *      目录入口，名字集合与被保留的那一份库归属必须逐项相同。
 *   三、**遮蔽可见且可筛**：同名项只出现一次，落选的那份进 `shadowed`；`filterByLibrary`
 *      按库筛出一个子集，不是把条目复制两份。
 *
 * 夹具是临时目录里的真文件（`SKILL.md` 的 frontmatter 形状与宿主一致），不依赖任何
 * 已装环境：这条用例要在干净 clone 上也判得动。
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as catalog from "../lib/state/skills-catalog.js";
import { listSkillCatalog } from "../lib/skills.js";
import { skillCatalogOfHome } from "../lib/redteam/ui.js";

const ROOT = path.resolve(import.meta.dirname, "..");

/** 一份合法的 `SKILL.md`：frontmatter 只写宿主认的两个字段。 */
function skillDocument(name, description, body = "正文") {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

/**
 * 夹具：两个根各一份同名技能，外加各自独有的条目。
 *
 * 同名的那份在两个根里写**不同的 description**：只比名字集合的话，赢家的归属仍然
 * 可能反了，所以断言要能看出「留下的是哪一份」。
 */
function makeFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-skills-"));
  const officialDir = path.join(home, "skills");
  const redteamDir = path.join(home, "redteam", "skills");
  fs.mkdirSync(officialDir, { recursive: true });
  fs.mkdirSync(redteamDir, { recursive: true });
  fs.writeFileSync(path.join(officialDir, "alpha.md"), skillDocument("alpha", "用户自己的 alpha"), "utf8");
  fs.writeFileSync(path.join(officialDir, "dup.md"), skillDocument("dup", "用户改过的 dup"), "utf8");
  fs.writeFileSync(path.join(redteamDir, "beta.md"), skillDocument("beta", "随包的 beta"), "utf8");
  fs.writeFileSync(path.join(redteamDir, "dup.md"), skillDocument("dup", "随包模板的 dup"), "utf8");
  return { home, officialDir, redteamDir };
}

/** 条目名 → 库里留下的那一份的描述。两个读者都摊成这个形状再比。 */
function byName(items) {
  const out = {};
  for (const item of items || []) {
    const name = String(item && (item.name || item.id) || "");
    if (!name) continue;
    out[name] = { library: item.library || "", description: item.description || "" };
  }
  return out;
}

test("根的顺序与 preset 的 customSkillDirs 一致：同名取先出现者", () => {
  // 判据从 preset 原文取，不自带一份顺序：两处各写一次，「谁是先出现者」就会各说各话。
  const preset = fs.readFileSync(path.join(ROOT, "presets", "redteam", "agent.cordis.yml"), "utf8");
  const block = /customSkillDirs:\s*\n((?:\s*-\s*!!js[^\n]*\n)+)/.exec(preset);
  assert.ok(block, "presets/redteam/agent.cordis.yml 里找不到 customSkillDirs 的目录清单");
  const dirs = [...block[1].matchAll(/dshHomePath\('([^']+)'\)/g)].map((m) => m[1]);
  assert.deepEqual(dirs, ["skills", "redteam/skills"], "preset 的 customSkillDirs 顺序变了：契约里的优先级要跟着改");
  const expected = dirs.map((dir) => (dir === "skills" ? catalog.SKILL_LIBRARIES.official : catalog.SKILL_LIBRARIES.redteam));
  assert.deepEqual(
    [...catalog.SKILL_ROOT_ORDER],
    expected,
    "SKILL_ROOT_ORDER 与 preset 的 customSkillDirs 顺序不一致：同名技能会被错的那一份遮蔽",
  );
});

test("两个读者对同一夹具给出同一集合（设置页 / 演练台）", async () => {
  const { home } = makeFixture();
  try {
    const settings = await listSkillCatalog(home);
    const drill = skillCatalogOfHome(home);
    const a = byName(settings.items);
    const b = byName(drill.items);
    assert.deepEqual(Object.keys(a).sort(), ["alpha", "beta", "dup"], "设置页读到的集合不对");
    assert.deepEqual(
      b,
      a,
      "设置页与演练台给出的技能集合不一致 —— 两个读者又各自枚举了",
    );
    assert.equal(a.dup.library, "official", "$DSH_HOME/skills 必须排在前面：用户改过的那份才是可见的那份");
    assert.equal(a.dup.description, "用户改过的 dup");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("遮蔽不是重复：同名只出现一次，落选的那份进 shadowed", async () => {
  const { home } = makeFixture();
  try {
    const settings = await listSkillCatalog(home);
    assert.equal(settings.items.length, 3, "同名项被当成两条算了：那是重复，不是遮蔽");
    assert.equal(settings.shadowed.length, 1, "落选的那份没有记录，界面上就说不清「同名几项被遮蔽」");
    assert.equal(settings.shadowed[0].id, "dup");
    assert.equal(settings.shadowed[0].keptLibrary, "official");
    assert.equal(settings.shadowed[0].droppedLibrary, "redteam");
    assert.deepEqual(settings.byLibrary, { official: 2, redteam: 1 });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("可按库筛选：筛出的是同一个集合的子集，不是再造一份", async () => {
  const { home } = makeFixture();
  try {
    const settings = await listSkillCatalog(home);
    const redteamOnly = catalog.filterByLibrary(settings, "redteam");
    assert.deepEqual(redteamOnly.map((item) => item.id).sort(), ["beta"]);
    const officialOnly = catalog.filterByLibrary(settings, "official");
    assert.deepEqual(officialOnly.map((item) => item.id).sort(), ["alpha", "dup"]);
    assert.equal(redteamOnly.length + officialOnly.length, settings.items.length, "按库筛完两边加起来必须等于全集");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("两个读者都经目录模块取数：源码里不许再出现各自的枚举表", () => {
  const readers = {
    "lib/skills.js": fs.readFileSync(path.join(ROOT, "lib", "skills.js"), "utf8"),
    "lib/redteam/ui.js": fs.readFileSync(path.join(ROOT, "lib", "redteam", "ui.js"), "utf8"),
  };
  for (const [rel, source] of Object.entries(readers)) {
    // 引法两种都算（`lib/skills.js` 用双引号、演练台侧用单引号）：判的是「引没引这一份」。
    const imports = /from\s+['"]\.\.?\/(?:state\/)?skills-catalog\.js['"]/.test(source);
    assert.ok(imports, `${rel} 没有引目录模块：它会重新长出一份自己的枚举`);
  }
  // 结构判据的对照面：目录模块本身必须同时提供这三件事，否则「单一来源」只是句口号。
  for (const name of ["SKILL_ROOT_ORDER", "buildSkillsCatalog", "filterByLibrary"]) {
    assert.equal(typeof catalog[name] === "function" || Array.isArray(catalog[name]), true, `skills-catalog.js 缺 ${name}`);
  }
});

test("红灯夹具：集合不一致必须能被检出，别拿「两边都像完整」当结论", () => {
  const left = { items: [{ id: "alpha", library: "official" }, { id: "dup", library: "official" }] };
  const right = { items: [{ id: "alpha", library: "official" }, { id: "dup", library: "redteam" }] };
  assert.notDeepEqual(byName(left.items), byName(right.items), "探测器认不出两个读者的差异，本条用例的判据本身失效了");
});
