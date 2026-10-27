/**
 * test/settings-page-nav.test.mjs — 页签与面板一一对应：多一个页签就是一块点不动的面板。
 *
 * 为什么单独立一份：左栏是**宿主导航**（通用设置 / 模型 / 内置插件 / 规则设定 / Agent 预设），
 * 本插件只占一个 section，改不了它。于是「十块内容挤成一条长滚动」这件事只能在页内解决：
 * 改成五页签之后，一次只露一块。判据不看「有没有页签」，看**页签与面板是不是同一组** ——
 * 少一块面板就有页签点不动，多一块就是永远轮不到的面板，而这两种都没有症状（页面照样能切）。
 *
 * 数量与键位都取页面自己的事实：`settingsTabItems()` 是唯一清单，`settingsTabId` /
 * `settingsPanelId` 是两处 id 的唯一拼法。判据分五条：
 *   一、五个页签、五个键、键不重复；
 *   二、页签的 `aria-controls` 指向面板 id，面板的 `aria-labelledby` 指回页签 id；
 *   三、id 不重复，且两处 id 只由那两个纯函数拼（字面量各出现一次）；
 *   四、键盘齐：方向键 / Home / End 与 `role` 三件套都在源码里；
 *   五、页签标题键在两份词典里都在（拼错的键只会把键名印到界面上）。
 *
 * 清单是纯函数，所以在 VM 里直接取（不用 DOM、不用宿主）；渲染路径只在源码层判。
 */
import { test } from "node:test";
import assert from "node:assert";

import { dictionaryTexts, loadFragmentHelpers, readRepo, textOfKey } from "./helpers/settings-fragment.mjs";

const PAGE = "lib/client-src/settings/page.js";

/** 四个页签片段：分节文件按页签合并之后的落点。 */
const TAB_FILES = [
  "lib/client-src/settings/patches-tab.js",
  "lib/client-src/settings/config-tab.js",
  "lib/client-src/settings/skills-tab.js",
  "lib/client-src/settings/diagnostics-tab.js",
];

/** 五页签的键与顺序：状态 / 补丁 / 配置 / 技能 / 诊断。 */
const KEYS = ["status", "patches", "config", "skills", "diagnostics"];

const { settingsTabItems, settingsTabId, settingsPanelId } = loadFragmentHelpers(PAGE, [
  "settingsTabItems",
  "settingsTabId",
  "settingsPanelId",
]);

/**
 * 页签与面板的配对违规：缺一块、重一块、少一个页签。
 *
 * @param {Array<{key:string, id:string}>} tabs 页签（键 + 按钮 id）
 * @param {Array<{key:string, id:string}>} panels 面板（键 + 面板 id）
 * @returns {string[]}
 */
function pairingProblems(tabs, panels) {
  const problems = [];
  const tabIds = tabs.map((item) => item.id);
  const panelIds = panels.map((item) => item.id);
  for (const id of new Set(tabIds)) {
    if (tabIds.filter((found) => found === id).length > 1) problems.push(`页签 id ${id} 出现了不止一次`);
  }
  for (const id of new Set(panelIds)) {
    if (panelIds.filter((found) => found === id).length > 1) problems.push(`面板 id ${id} 出现了不止一次`);
  }
  for (const tab of tabs) {
    const hits = panels.filter((panel) => panel.key === tab.key);
    if (hits.length === 0) problems.push(`页签 ${tab.key} 没有对应的面板（点开是空的）`);
    if (hits.length > 1) problems.push(`页签 ${tab.key} 对应 ${hits.length} 块面板（会露错内容）`);
  }
  for (const panel of panels) {
    if (!tabs.some((tab) => tab.key === panel.key)) problems.push(`面板 ${panel.key} 没有对应的页签（永远轮不到）`);
  }
  return problems;
}

/** 从清单派生两侧的 id：页签与面板本来就是同一份清单的两个投影。 */
const tabs = () => settingsTabItems().map((item) => ({ key: item.key, id: settingsTabId(item.key) }));
const panels = () => settingsTabItems().map((item) => ({ key: item.key, id: settingsPanelId(item.key) }));

test("红灯夹具：少一块、重一块、多一个页签都要被检出", () => {
  assert.deepEqual(pairingProblems(tabs(), panels()), [], "页签与面板本来就对不上");
  assert.ok(pairingProblems(tabs(), panels().slice(1)).length > 0, "少一块面板没被检出");
  assert.ok(pairingProblems(tabs(), [...panels(), panels()[0]]).length > 0, "面板重复没被检出");
  assert.ok(pairingProblems([...tabs(), tabs()[0]], panels()).length > 0, "页签重复没被检出");
  const renamed = panels().map((panel) => ({ ...panel, key: panel.key }));
  renamed[0] = { ...renamed[0], key: "ghost-panel" };
  assert.ok(pairingProblems(tabs(), renamed).length > 0, "面板少一个键没被检出");
});

test("五个页签、五块面板一一对应：键与顺序都是状态 / 补丁 / 配置 / 技能 / 诊断", () => {
  const list = settingsTabItems();
  assert.equal(list.length, 5, `页签不是 5 个而是 ${list.length} 个`);
  assert.deepEqual(list.map((item) => item.key), KEYS, "页签的键或顺序变了");
  const derivedTabs = tabs();
  const derivedPanels = panels();
  assert.equal(derivedTabs.length, 5, `只取到 ${derivedTabs.length} 个页签 id`);
  assert.deepEqual(pairingProblems(derivedTabs, derivedPanels), [], "页签与面板对不上");
  // id 只有一种拼法：键前缀 + 键，两侧不许撞名。
  for (const item of list) {
    assert.equal(settingsTabId(item.key), `dshp-tab-${item.key}`, `页签 id 拼法变了：${item.key}`);
    assert.equal(settingsPanelId(item.key), `dshp-panel-${item.key}`, `面板 id 拼法变了：${item.key}`);
  }
});

test("id 只在两个纯函数里拼，页签与面板都从同一份清单派生", () => {
  const page = readRepo(PAGE);
  assert.equal((page.match(/"dshp-tab-"/g) || []).length, 1, "页签 id 前缀不该在别处再写一遍");
  assert.equal((page.match(/"dshp-panel-"/g) || []).length, 1, "面板 id 前缀不该在别处再写一遍");
  assert.equal(
    (page.match(/settingsTabId\(item\.key\)/g) || []).length,
    2,
    "页签 id 该恰好用两次：按钮自己的 id 与面板的 aria-labelledby",
  );
  assert.equal(
    (page.match(/settingsPanelId\(item\.key\)/g) || []).length,
    2,
    "面板 id 该恰好用两次：面板自己的 id 与页签的 aria-controls",
  );
  assert.equal((page.match(/role: "tabpanel"/g) || []).length, 1, "面板不是一处渲染的（手写的第二块会绕过清单）");
  for (const rel of TAB_FILES) {
    const source = readRepo(rel);
    assert.ok(!source.includes("dshp-tab-"), `${rel} 自己拼了页签 id：页签壳在 page.js`);
    assert.ok(!source.includes("dshp-panel-"), `${rel} 自己拼了面板 id：页签壳在 page.js`);
  }
});

test("无障碍三件套与键盘：role / aria-selected / aria-controls / aria-labelledby、方向键与 Home/End", () => {
  const page = readRepo(PAGE);
  assert.ok(page.includes('role: "tablist"'), "页签栏没有 tablist");
  assert.ok(page.includes('role: "tab"'), "页签按钮没有 role=tab");
  assert.ok(page.includes('role: "tabpanel"'), "内容块没有 role=tabpanel");
  assert.ok(page.includes('"aria-selected"'), "页签缺 aria-selected");
  assert.ok(page.includes('"aria-controls": settingsPanelId(item.key)'), "页签没有指到面板 id");
  assert.ok(page.includes('"aria-labelledby": settingsTabId(item.key)'), "面板没有指回页签 id");
  assert.ok(page.includes("id: settingsTabId(item.key)"), "页签按钮没有挂 id");
  assert.ok(page.includes("id: settingsPanelId(item.key)"), "面板没有挂 id");
  assert.ok(page.includes("tabIndex: on ? 0 : -1"), "页签没有 roving tabindex（Tab 键会逐个停在页签上）");
  assert.ok(page.includes("onKeyDown: onTabKey"), "页签栏没有键盘处理");
  for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) {
    assert.ok(page.includes(`event.key === "${key}"`), `缺 ${key} 的键位处理`);
  }
});

test("锚点导航不回来：settingsNavItems 与 dshp-sec-* 在设置页片段里零命中", () => {
  const page = readRepo(PAGE);
  assert.ok(!page.includes("settingsNavItems"), "锚点导航的清单还在");
  assert.ok(!page.includes('href: "#"'), "页内还有锚点链接");
  const leftovers = [];
  for (const rel of [PAGE, ...TAB_FILES]) {
    if (readRepo(rel).includes("dshp-sec-")) leftovers.push(rel);
  }
  assert.deepEqual(leftovers, [], `这些片段还挂着分节锚点 id：${leftovers.join("、")}`);
});

test("页签标题键在两份词典里都在", () => {
  const dict = dictionaryTexts();
  const missing = [];
  for (const item of settingsTabItems()) {
    if (textOfKey(dict.zh, item.label) === null) missing.push(`${item.key} <- zh 缺 ${item.label}`);
    if (textOfKey(dict.en, item.label) === null) missing.push(`${item.key} <- en 缺 ${item.label}`);
  }
  for (const lang of ["zh", "en"]) {
    if (textOfKey(dict[lang], "tab.list.label") === null) missing.push(`页签栏 <- ${lang} 缺 tab.list.label`);
  }
  assert.deepEqual(missing, [], `页签文案在词典里缺键：${missing.join("、")}`);
});
