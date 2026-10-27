/**
 * test/log-criteria.test.mjs — 判据表要能被一条命令逐条跑出来，不是一张写着「已验」的表。
 *
 * 为什么单独立一份：判据原先散在读法、索引、世代表与几个测试里，同一条规则四处各说一套，
 * 改了一处另几处照旧。`docs/log-criteria.json` 把它们收成一张表，每条必须带 `fixture` 与
 * `expect`；这份用例逐条真跑 `audit check`，核对退出码与关键输出 —— 表里写「会红」的，
 * 跑出来就必须红。
 *
 * 另判两件事：① 表里的每条判据都指得到真实存在的载体与夹具（指着不存在的文件等于没载体）；
 * ② `02-q1` … `02-q6` 六个设计问句各有读法落点与载体，且那些读法问句在文档里真有对应章节。
 */
import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CRITERIA_PATH = path.join(ROOT, "docs", "log-criteria.json");
const DOC_PATH = path.join(ROOT, "docs", "readme-for-ai.md");

const criteria = () => JSON.parse(fs.readFileSync(CRITERIA_PATH, "utf8"));
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const asList = (value) => (Array.isArray(value) ? value : [value]);

/** 判据跑的是**真命令行**：退出码是判据的一部分，库函数的返回值不算。 */
function runCriteria(entry) {
  const run = spawnSync(process.execPath, ["bin/dsh-purge.js", "audit", "check", ...entry.args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, DSH_PURGE_LOG: "0" },
  });
  return { status: run.status, out: `${run.stdout}\n${run.stderr}`, stdout: run.stdout };
}

test("判据表的结构完备：每条都有 id / rule / anchor / carrier / fixture / expect", () => {
  const table = criteria();
  assert.ok(Array.isArray(table.criteria), "log-criteria.json 里没有 criteria 数组");
  assert.ok(
    table.criteria.length >= 9 && table.criteria.length <= 10,
    `判据条数是 ${table.criteria.length}：表要的是 9–10 条，少了覆盖不住，多了没人读`,
  );
  const ids = new Set();
  for (const entry of table.criteria) {
    for (const key of ["id", "rule", "anchor", "carrier", "fixture", "args", "expect"]) {
      assert.ok(entry[key] !== undefined && entry[key] !== "", `${entry.id ?? "（无 id）"} 缺 ${key}`);
    }
    assert.ok(!ids.has(entry.id), `判据 id 重复：${entry.id}`);
    ids.add(entry.id);
    assert.ok(Array.isArray(entry.carrier) && entry.carrier.length > 0, `${entry.id} 的 carrier 是空的`);
    assert.ok(Array.isArray(entry.args) && entry.args.length > 0, `${entry.id} 没有给 audit check 的参数`);
    assert.ok([0, 1].includes(entry.expect.exit), `${entry.id} 的 expect.exit 只许 0 或 1`);
    assert.ok(
      Array.isArray(entry.expect.contains) && entry.expect.contains.length > 0,
      `${entry.id} 的 expect.contains 是空的：那样的判据只会核对退出码，读的人看不出它判了什么`,
    );
  }
});

test("每条判据的夹具与载体都真实存在（指着不存在的文件等于没载体）", () => {
  const missing = [];
  for (const entry of criteria().criteria) {
    for (const rel of [...asList(entry.fixture), ...entry.carrier]) {
      if (!exists(rel)) missing.push(`${entry.id} → ${rel}`);
    }
    // 参数里的仓库内路径也要存在：写错一个字母，判据跑的就是另一个对象。
    for (const arg of entry.args) {
      if (/^(?:test|docs|lib|scripts)\//.test(arg) && !exists(arg)) missing.push(`${entry.id} → args:${arg}`);
    }
  }
  assert.deepEqual(missing, [], "这些夹具 / 载体 / 参数路径不存在");
});

test("逐条真跑：退出码与关键输出必须与表里写的一致", () => {
  for (const entry of criteria().criteria) {
    const result = runCriteria(entry);
    assert.equal(
      result.status,
      entry.expect.exit,
      `${entry.id} 的退出码是 ${result.status}，表里写的是 ${entry.expect.exit}：\n${result.out}`,
    );
    for (const needle of entry.expect.contains) {
      assert.ok(
        result.out.includes(needle),
        `${entry.id} 的输出里没有「${needle}」：\n${result.out}`,
      );
    }
  }
});

test("过滤 apply 两态：selected 是分母，合法过滤绿、selected 里缺条红", () => {
  // 这一对夹具锁 V2 的硬错：补丁表 3 条、report 只含 2 条（合法过滤），
  // 全表分母会把 recorded=2 判成「静默丢失」；反过来 selected 里点名了却缺文件行，必须红。
  const good = runCriteria({ args: ["--jsonl", "test/fixtures/log-criteria/filtered-v3.jsonl", "--json"] });
  assert.equal(good.status, 0, good.out);
  const goodReport = JSON.parse(good.stdout);
  const recordedProblems = goodReport.runs.problems
    .filter((line) => line.includes("recorded") || line.includes("补丁表里有") || line.includes("selected 里有"));
  assert.deepEqual(recordedProblems, [], `合法过滤轮不该有补丁表 / recorded 问题：\n${recordedProblems.join("\n")}`);

  const rows = fs.readFileSync(path.join(ROOT, "test", "fixtures", "log-criteria", "filtered-v3.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
  const table = rows.map((row) => row.detail && row.detail.table).find(Boolean);
  assert.deepEqual(table.selected, [1, 2], "写侧要落下这一轮选中的补丁号");
  assert.equal(table.recorded, 2);

  const bad = runCriteria({ args: ["--jsonl", "test/fixtures/log-criteria/filtered-missing.jsonl"] });
  assert.equal(bad.status, 1, bad.out);
  assert.match(bad.out, /补丁：3/, "selected 里缺的补丁 3 必须被点名");
});

test("设计问句映射：02-q1 … 02-q6 各有读法落点，且那些问句在文档里真有章节", () => {
  const table = criteria();
  assert.ok(Array.isArray(table.designQuestions), "log-criteria.json 里没有 designQuestions 映射");
  const expected = ["02-q1", "02-q2", "02-q3", "02-q4", "02-q5", "02-q6"];
  assert.deepEqual(
    table.designQuestions.map((row) => row.id).sort(),
    expected,
    "设计问句映射不是那六条：少一条就没有归宿，多一条就是没定义的问句",
  );
  const doc = fs.readFileSync(DOC_PATH, "utf8");
  const headings = doc.split("\n").filter((line) => /^#{2,3}\s+Q\d/.test(line)).map((line) => line.trim());
  for (const row of table.designQuestions) {
    assert.ok(row.question && row.question.trim() !== "", `${row.id} 没有问句原文`);
    assert.ok(Array.isArray(row.readme) && row.readme.length > 0, `${row.id} 没有读法落点`);
    assert.ok(Array.isArray(row.carrier) && row.carrier.length > 0, `${row.id} 没有载体 —— C8 要求每条都有`);
    for (const q of row.readme) {
      assert.ok(
        headings.some((line) => new RegExp(`^#{2,3}\\s+${q}\\b`).test(line)),
        `${row.id} 指向读法的 ${q}，但文档里没有这一问`,
      );
    }
    for (const rel of row.carrier) {
      assert.ok(exists(rel), `${row.id} 的载体 ${rel} 不存在`);
    }
  }
});

test("与约束索引互指：本表只镜像 AUDIT-3，索引的载体列点名本表", () => {
  const table = criteria();
  assert.equal(table.constraint, "AUDIT-3", "判据表没指向它所镜像的约束编号");
  const index = fs.readFileSync(path.join(ROOT, "docs", "约束索引.md"), "utf8");
  const row = index.split("\n").find((line) => line.startsWith("| `AUDIT-3`"));
  assert.ok(row, "约束索引里没有 AUDIT-3 这一行 —— 互指失去对象");
  assert.ok(row.includes("docs/log-criteria.json"), "AUDIT-3 的载体列没点名本表");
});
