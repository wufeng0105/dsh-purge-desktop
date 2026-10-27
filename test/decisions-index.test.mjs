/**
 * test/decisions-index.test.mjs — 决策索引必须与 decisions 目录说同一件事。
 *
 * 为什么单独立一份：15 篇 ADR 各自写着状态与关联，但没有一处能一眼看出哪条还现行、
 * 哪条被后来的一篇更正。补一份索引最容易出的错是「索引写了一套、正文另一套」：
 * 删掉一篇 ADR、把状态写成自造词、或让「被取代」指向不存在的编号，都不会有人发现。
 *
 * 这里只判能机判的那一半：篇目数量与文件对得上、标题逐字一致、状态值取自固定四档、
 * 取代关系指向真实存在的篇目、现行指针里的路径在盘上。判「这段关系写得对不对」还得靠人。
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const DECISIONS = "docs/decisions";
const INDEX = "docs/decisions/README.md";
/** 新增一篇 ADR 必须同时加一行索引并改这个数——让「忘记登记」在测试里显形。 */
const EXPECTED_ADR_COUNT = 15;
const STATUSES = /^(现行|被取代|仅历史|未启动)(（[^（）]*）)?$/;
/** 现行指针里可能出现的仓库路径前缀；根目录文件另列，避免把 `verify.yml` 这类裸名当路径。 */
const REPO_PATH = /^(?:lib|test|scripts|docs|architecture|bin|rules|presets|skills|\.github)\//;
const ROOT_FILES = new Set([
  "package.json",
  "knip.json",
  "tsconfig.artifact.json",
  ".dependency-cruiser.mjs",
  ".gitattributes",
]);

/** 四位数编号 → 相对路径。索引自身（README.md）没有编号，不参与篇目表。 */
function adrFiles() {
  const out = new Map();
  for (const name of fs.readdirSync(path.join(ROOT, DECISIONS))) {
    const m = name.match(/^(\d{4})-.+\.md$/);
    if (m) out.set(m[1], `${DECISIONS}/${name}`);
  }
  return out;
}

/** 索引表的数据行：第一列是反引号编号，五列依次为 id / 标题 / 状态 / 取代关系 / 现行指针。 */
function indexRows() {
  return read(INDEX)
    .split("\n")
    .filter((line) => /^\|\s*`\d{4}`\s*\|/.test(line))
    .map((line) => {
      const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
      return {
        id: cells[0].replace(/`/g, ""),
        title: cells[1] ?? "",
        status: cells[2] ?? "",
        relation: cells[3] ?? "",
        pointer: cells[4] ?? "",
      };
    });
}

/** ADR 正文的 H1 标题去掉「# 0001. 」前缀，用来与索引表逐字比对。 */
function adrTitle(rel) {
  const h1 = read(rel).split("\n").find((line) => /^#\s/.test(line)) ?? "";
  return h1.replace(/^#\s*\d{4}\.\s*/, "").trim();
}

test("索引覆盖 decisions 目录的全部 ADR：篇数、编号、标题都不许漂", () => {
  const files = adrFiles();
  const rows = indexRows();
  assert.equal(files.size, EXPECTED_ADR_COUNT, `decisions 目录里有 ${files.size} 篇 ADR，期望 ${EXPECTED_ADR_COUNT}`);
  assert.equal(rows.length, files.size, `索引表有 ${rows.length} 行，decisions 目录有 ${files.size} 篇——删/漏一行都会让读者找不到某篇`);
  assert.deepEqual(
    [...new Set(rows.map((row) => row.id))].sort(),
    [...files.keys()].sort(),
    "索引的编号集合与 decisions 目录里的文件名不一致",
  );
  for (const row of rows) {
    assert.equal(row.title, adrTitle(files.get(row.id)), `${row.id} 的索引标题与正文 H1 不一致`);
  }
});

test("状态列只取四档之一，括号补充不改变档位", () => {
  for (const row of indexRows()) {
    assert.match(row.status, STATUSES, `${row.id} 的状态「${row.status}」不在 现行 / 被取代 / 仅历史 / 未启动 四档里`);
  }
});

test("取代关系只指向真实存在的 ADR，被取代必须有指向，且不许指向自己", () => {
  const files = adrFiles();
  for (const row of indexRows()) {
    assert.ok(row.relation, `${row.id} 没写取代关系——没有关系也要写「无取代」`);
    const refs = [...row.relation.matchAll(/(?<!\d)(\d{4})(?!\d)/g)].map((m) => m[1]);
    for (const ref of refs) {
      assert.ok(files.has(ref), `${row.id} 的取代关系指向不存在的 ${ref}`);
      assert.notEqual(ref, row.id, `${row.id} 的取代关系指向自己`);
    }
    if (row.status.startsWith("被取代")) {
      assert.ok(refs.length > 0, `${row.id} 标了被取代，却没指向取代它的那一篇`);
    }
  }
});

test("现行指针里的路径必须存在，且每行至少指到一个文件", () => {
  const missing = [];
  for (const row of indexRows()) {
    const refs = [...row.pointer.matchAll(/`([^`]+)`/g)]
      .map((m) => m[1])
      .filter((token) => REPO_PATH.test(token) || ROOT_FILES.has(token));
    assert.ok(refs.length > 0, `${row.id} 的现行指针没指向任何文件`);
    for (const ref of refs) {
      if (!fs.existsSync(path.join(ROOT, ref))) missing.push(`${row.id}: ${ref}`);
    }
  }
  assert.deepEqual(missing, [], `决策索引的现行指针指向不存在的文件：\n  ${missing.join("\n  ")}`);
});

test("每篇 ADR 顶部保留状态与关联（关系）行，且关联行指向具体对象", () => {
  for (const [id, rel] of adrFiles()) {
    const head = read(rel).split(/^## /m)[0];
    assert.match(head, /^- 状态：\S+/m, `${id} 顶部没有「- 状态：」行`);
    const relation = head.split("\n").find((line) => /^- (?:关联|关系)：/.test(line));
    assert.ok(relation, `${id} 顶部没有「- 关联：」或「- 关系：」行`);
    assert.ok(/`[^`]+`/.test(relation), `${id} 的关联行没指向任何具体对象`);
  }
});
