/**
 * test/constraint-index.test.mjs — 约束索引里的文本必须与它的判定载体说同一件事。
 *
 * 为什么单独立一份：判据被降级、而文档还写着旧数字，这种「文档与门禁互相说谎」没有
 * 任何人拦得住 —— 门禁照绿、文档照旧，读的人按文档去信一个已经不成立的断言。实测过
 * 一次：性能墙钟断言从「< 1500 ms」降级成信息项之后，索引里那行仍写着 1500，而载体
 * 文件里连这个数字都不存在。
 *
 * 这里只判「能机判的那一半」：数字必须等于载体里的常量、说法必须与载体的判据同形、
 * 登记过的缺口必须真的写在风险地图里。判「这句话有没有说清」还得靠人，别指望它。
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** 索引里某条编号所在的那一行；找不到直接红 —— 缺行比写错更容易被漏看。 */
function constraintRow(id) {
  const line = read("docs/约束索引.md").split("\n").find((row) => row.startsWith(`| \`${id}\``));
  assert.ok(line, `约束索引里没有 ${id} 这一行`);
  return line;
}

test("PERF-1 与载体同形：墙钟只剩挂死上限，那个数字必须等于测试里的常量", () => {
  const row = constraintRow("PERF-1");
  const carrier = read("test/diagnostics-perf.test.mjs");
  assert.ok(!row.includes("1500"), "PERF-1 还写着已降级的 1500 ms 墙钟断言：文档与门禁互相说谎");
  const ceiling = carrier.match(/const HANG_CEILING_MS = (\d+);/);
  assert.ok(ceiling, "载体里找不到挂死上限常量，PERF-1 的文本失去对象");
  assert.ok(
    row.includes(`${ceiling[1]} ms`),
    `PERF-1 没写挂死上限 ${ceiling[1]} ms —— 读者会以为还有一条墙钟预算`,
  );
  assert.ok(row.includes("test/diagnostics-perf.test.mjs"), "PERF-1 的载体列指错文件");
  // 降级之后真正扛事的是结构判据：文本里必须提到它，否则「不挂死」会被读成「性能达标」。
  assert.ok(row.includes("结构性"), "PERF-1 没把结构性判据写成真正的判据");
  assert.ok(carrier.includes("MIN_CEILING_MS"), "载体里没有防回退的下限判据，PERF-1 的描述跟着失效");
});

test("风险地图登记了「真实变慢没有自动化载体」这一缺口", () => {
  const text = read("docs/约束索引.md");
  const risk = text.slice(text.indexOf("## 风险地图"));
  assert.ok(risk.length > 0, "约束索引里没有风险地图那一节");
  const rows = risk.split("\n").filter((line) => line.startsWith("|"));
  const hit = rows.find((line) => line.includes("真实变慢") || line.includes("整体变慢"));
  assert.ok(hit, "风险地图没登记「真实变慢今天没有自动化载体」");
  assert.ok(/没有(任何)?自动化载体|没有\.{0,3}载体/.test(hit), "那一行没说清「没有载体」这件事");
});

test("AUDIT-3 的载体存在，且判据真的接在 audit check 上（不是只写在索引里）", () => {
  const row = constraintRow("AUDIT-3");
  for (const rel of [
    "lib/audit/runs.js",
    "lib/audit/generation.js",
    "test/audit-runs.test.mjs",
    "test/log-criteria.test.mjs",
  ]) {
    assert.ok(row.includes(rel), `AUDIT-3 的载体列漏了 ${rel}`);
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `AUDIT-3 的载体 ${rel} 不存在`);
  }
  const check = read("lib/audit/check.js");
  assert.ok(
    /import\s*\{[^}]*summarizeRuns[^}]*\}\s*from\s*"\.\/runs\.js"/.test(check),
    "audit check 没有接上轮边界判据 —— 索引里那条就只是纸面约束",
  );
  // 判据必须真的能让退出码变红：报告里 ok 的计算要含轮边界与跨轨两项。
  assert.ok(check.includes("runs.truncated === 0"), "audit check 的 ok 没含轮边界");
  assert.ok(check.includes("cross.unmatched === 0"), "audit check 的 ok 没含跨轨对账");
});

test("AUDIT-3 的条文与代码同源：收尾只认 runEnd、次序不比，两条已废弃的写法不许回来", () => {
  const row = constraintRow("AUDIT-3");
  // 判据的锚点：没有它，「收尾」只剩一句口号。
  assert.ok(row.includes("detail.runEnd"), "AUDIT-3 没写收尾只认 detail.runEnd");
  assert.ok(row.includes("generation.js"), "AUDIT-3 没写世代从哪个模块认");
  assert.ok(row.includes("judgeable=false"), "AUDIT-3 没写 v2-entry 完整轮判不了收尾");
  assert.ok(row.includes("次序不比"), "AUDIT-3 没写「次序不比」—— 读者会把信息项当判红");
  assert.ok(row.includes("recorded"), "AUDIT-3 没写 recorded 的复算判据");
  // 反向对账的两条「不判红」边界各有一个缺口曾经被判成丢账：上一代没有约定，
  // aborted / 0 补丁的轮没有可落账的判定。少写一条，读者就会把 0 行读成缺记录。
  assert.ok(row.includes("没有逐补丁判定"), "AUDIT-3 没写「没有逐补丁判定的轮不判审计缺」—— aborted 轮的 0 行会被读成丢账");
  // 这两条是 runs.js 与 test/audit-runs.test.mjs 都废弃过的写法：
  // 留着它们，索引就在教人按排列判收尾、按次序判一致。
  assert.ok(!row.includes("末行是"), "AUDIT-3 又写回了「末行是层结论」这条按位置判的废弃判据");
  assert.ok(!row.includes("补丁号次序是"), "AUDIT-3 又写回了「补丁号次序是……子序列」这条被废弃的判据");
});

test("AUDIT-4 只留一句话 + 0014 指针：门槛函数在，三档全文不在", () => {
  const row = constraintRow("AUDIT-4");
  for (const rel of [
    "lib/stamp.js",
    "test/audit-apply-entries.test.mjs",
    "docs/decisions/0014-版本账本成功口径.md",
  ]) {
    assert.ok(row.includes(rel), `AUDIT-4 的载体列漏了 ${rel}`);
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `AUDIT-4 的载体 ${rel} 不存在`);
  }
  // 一句话只留门槛函数与指针；三档判据的正文在 0014，索引里再抄一遍就是第三份权威。
  // 只看「约束」列：载体列本来就有 0014 的路径，拿整行判会让「指针被删」也绿。
  const rule = row.split("|")[2] ?? "";
  assert.ok(rule.includes("isCleanApplyRound"), "AUDIT-4 的约束列没写门槛函数 isCleanApplyRound");
  assert.ok(rule.includes("0014-版本账本成功口径.md"), "AUDIT-4 的约束列没指向 0014 决策正文");
  for (const copied of ["failed=0", "hostWritten", "hookDenyRestoreFailed", "flash.ok"]) {
    assert.ok(
      !rule.includes(copied),
      `AUDIT-4 复制了 0014 的三档细节「${copied}」—— 决策正文只在 0014，这里只留指针`,
    );
  }
  // 载体里的判据真的存在，而不是只被引用：门槛函数与跑它的用例。
  assert.ok(
    read("lib/stamp.js").includes("export function isCleanApplyRound"),
    "stamp.js 里没有 isCleanApplyRound —— AUDIT-4 失去对象",
  );
  assert.ok(
    read("test/audit-apply-entries.test.mjs").includes("isCleanApplyRound"),
    "audit-apply-entries.test.mjs 没跑这个门槛",
  );
  // 口径文档要自陈剩下两档（无改动轮、密封缺口），只写「三档」会让读者以为没有已知缺口。
  const doc = read("docs/decisions/0014-版本账本成功口径.md");
  for (const needle of ["missing_file", "hookDenyRestoreFailed", "appliedRunId"]) {
    assert.ok(doc.includes(needle), `0014 没写「${needle}」—— 口径文档漏了它要定的事`);
  }
});

/** 载体列里不是文件的对象：补丁字段名、命令与 CI 步骤名。出现新形态必须在这里显式登记，不许静默跳过。 */
const NON_FILE_CARRIERS = new Set([
  "surfaces",
  "file",
  "desc",
  "npm run dead",
  "npm test",
  "npm run check:lib-names",
  "Artifact undeclared names",
  "Lib undeclared names",
  "Reader follows spec",
  "人工评审",
]);
/** 根目录文件：不带目录前缀，按完整文件名认。 */
const ROOT_FILES = new Set([
  "package.json",
  "knip.json",
  "tsconfig.artifact.json",
  ".dependency-cruiser.mjs",
  ".gitattributes",
]);
/** workflow 在正文里常写裸文件名，落到仓库里的真实位置只有一处。 */
const WORKFLOW_ALIASES = new Map([
  ["verify.yml", ".github/workflows/verify.yml"],
  ["release.yml", ".github/workflows/release.yml"],
]);
const REPO_PATH = /^(?:lib|test|scripts|docs|architecture|bin|rules|presets|skills|\.github)\//;

/** 「约束」表的数据行。中途的 `\|` 转义会让朴素 split 错位，故按行正则取最后一列。 */
function carrierRows() {
  const text = read("docs/约束索引.md");
  const start = text.indexOf("\n## 约束");
  const end = text.indexOf("\n## 风险地图");
  assert.ok(start > 0 && end > start, "约束索引里找不到「约束 / 风险地图」两节，载体遍历失去范围");
  const lines = text
    .slice(start, end)
    .split("\n")
    .filter((line) => /^\|\s*`[A-Z]+-\d+`\s*\|/.test(line));
  return lines.map((line) => {
    const m = line.match(/^\|\s*`([A-Z]+-\d+)`\s*\|(.*)\|(.*)\|\s*$/);
    assert.ok(m, `载体行无法解析：${line.slice(0, 60)}`);
    return { id: m[1], carrier: m[3] };
  });
}

test("约束索引全表：每行载体列都指到盘上的文件，未分类的写法一律红", () => {
  const rows = carrierRows();
  const declared = read("docs/约束索引.md")
    .split("\n")
    .filter((line) => /^\|\s*`[A-Z]+-\d+`\s*\|/.test(line));
  assert.ok(rows.length > 0, "没有解析到任何约束行");
  assert.equal(rows.length, declared.length, `载体遍历漏行：解析 ${rows.length} 行，表里有 ${declared.length} 个编号`);

  const missing = [];
  const unclassified = [];
  for (const { id, carrier } of rows) {
    const tokens = [...carrier.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    if (tokens.length === 0) {
      // 人工评审这类没有文件对象的载体必须整格登记；否则「载体列是空的」会被当成通过。
      if (!NON_FILE_CARRIERS.has(carrier.trim())) unclassified.push(`${id}: 载体列没有任何反引号对象`);
      continue;
    }
    for (const token of tokens) {
      const rel = WORKFLOW_ALIASES.get(token) ?? token;
      if (REPO_PATH.test(rel) || ROOT_FILES.has(rel)) {
        if (!fs.existsSync(path.join(ROOT, rel))) missing.push(`${id}: ${token}`);
        continue;
      }
      if (!NON_FILE_CARRIERS.has(token)) unclassified.push(`${id}: ${token}`);
    }
  }
  assert.deepEqual(
    unclassified,
    [],
    `载体列出现未登记的非文件对象（新形态要显式登记，否则漏检会静默通过）：\n  ${unclassified.join("\n  ")}`,
  );
  assert.deepEqual(missing, [], `约束索引的载体路径不存在：\n  ${missing.join("\n  ")}`);
});
