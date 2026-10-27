/**
 * test/drill-skills-empty.test.mjs — 技能库的两种空态（T40）。
 *
 * 「一个技能都没有」和「有技能但都被筛掉」是两件事：前者要告诉人去哪儿放技能，
 * 后者要给人一个「清除筛选」的出口。用同一句话糊住两种状态，用户会以为技能没装上。
 *
 * 判据：两套词各有一条键（文案不同）、技能库按 `filtered.length` 分流、被筛掉那一支有清筛选动作。
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const CLIENT = readFileSync(join(ROOT, "client.js"), "utf8");
const I18N = readFileSync(join(ROOT, "lib", "client-src", "i18n.js"), "utf8");

function pageSource(name) {
  const at = CLIENT.indexOf(`function ${name}(`);
  assert.ok(at > 0, `产物里没有 ${name}`);
  const rest = CLIENT.slice(at + 1);
  const next = rest.search(/\n {4}(?:function |\/\* -+)/);
  return next < 0 ? rest : rest.slice(0, next);
}

test("两种空态各有一条键，且文案不同", () => {
  for (const key of ["drill.t40skillsEmpty", "drill.t40skillsFiltered"]) {
    assert.ok(I18N.includes(`"${key}"`), `词典里没有 ${key}`);
  }
  const empty = /"drill\.t40skillsEmpty":\s*"([^"]*)"/.exec(I18N);
  const filtered = /"drill\.t40skillsFiltered":\s*"([^"]*)"/.exec(I18N);
  assert.ok(empty && filtered, "两条空态键没有同时写在中文词典里");
  assert.notEqual(empty[1], filtered[1], "两种空态用了同一句话：用户分不出「没装上」和「被筛掉」");
});

test("技能库按「有没有被筛掉」分流，不是一句写死", () => {
  const source = pageSource("SkillsTab");
  assert.match(source, /filtered\.length \? dt\('drill\.t40skillsFiltered'\) : dt\('drill\.t40skillsEmpty'\)/, "技能库没有按 filtered.length 分流");
  assert.match(source, /drill\.t40clearFilter/, "被筛掉那一支没有「清除筛选」动作");
  assert.match(source, /h\(EmptyState, \{/, "两种空态没有走 EmptyState 原语");
});

test("知识库空态接上了「打开知识库目录」", () => {
  const source = pageSource("KnowledgeTab");
  assert.match(source, /openDir\('knowledge'\)/, "知识库空态的按钮没有接到 openDir('knowledge')");
  assert.match(source, /drill\.t40open/, "知识库空态没有用「打开知识库目录」这条文案");
  assert.match(CLIENT, /const openDir = \(kind\) => fetch\('\/dsh-purge\/open'/, "drill 侧没有 openDir 助手");
});
