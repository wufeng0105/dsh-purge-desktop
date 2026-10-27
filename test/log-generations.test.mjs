/**
 * test/log-generations.test.mjs — 读法按「问题」组织，字段按「世代」登记，三者双向锁住。
 *
 * 为什么单独立一份：上一版读法是「字段表 + 事件表」的实现说明，于是每改一次代码就漏一处 ——
 * 十四条缺陷里十二条是这个结构的直接后果。这里换三条判据，缺一条就会退回旧形态：
 *
 *   一、**问题形态**：读法正文的章节标题必须是「这一轮完整吗」这种问句，不是「字段表」；
 *   二、**双向字段**：代码里发射的字段 ⊆ `docs/log-generations.json` ⊆ 读法里写到的字段。
 *       只锁一个方向不够 —— 代码新增字段而表与读法不动，就是旧病复发；
 *   三、**世代**：老口径与新口径的差异必须有一张机器可读的表，且每个世代都能只读日志认出来。
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOC_PATH = path.join(ROOT, "docs", "readme-for-ai.md");
const TABLE_PATH = path.join(ROOT, "docs", "log-generations.json");

const docText = () => fs.readFileSync(DOC_PATH, "utf8");
const table = () => JSON.parse(fs.readFileSync(TABLE_PATH, "utf8"));
const registered = () => new Set(table().fields.map((row) => row.name));

/** 递归列出某个目录下的 .js 文件。 */
function jsFiles(dir) {
  const out = [];
  const walk = (abs) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const next = path.join(abs, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) out.push(next);
    }
  };
  walk(dir);
  return out;
}

/**
 * 取出 `marker(` 之后第一个平衡花括号里的**顶层**键名。
 *
 * 只取第一层：嵌在里面的键（例如 `completeness` 里的 `patches`）属于另一张表，
 * 混进来会让「字段清单」变成一团，判据也就没用了。
 */
function topLevelKeysOf(text, marker) {
  const at = text.indexOf(marker);
  if (at < 0) return [];
  // marker 自带那个 `{`：从它的位置开始数，别从它后面再找一个（那会跳到下一个对象上，
  // 键名就来自别处了 —— 这条判据会被自己的取样错误骗过）。
  const open = at + marker.length - 1;
  if (text[open] !== "{") return [];
  const keys = [];
  let depth = 0;
  let lineStart = open + 1;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\n") {
      lineStart = i + 1;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) break;
      continue;
    }
    if (depth === 1 && ch === ":" && !/^\s*\.\.\./.test(text.slice(lineStart, i))) {
      const before = text.slice(lineStart, i);
      const found = before.match(/(?:^|[{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*$/);
      if (found) keys.push(found[1]);
      lineStart = i + 1;
    }
  }
  return keys;
}

/** 代码里发射的字段：审计事件的形状表 + 各发射点的对象字面量。 */
function codeFields() {
  const out = new Set();
  const events = fs.readFileSync(path.join(ROOT, "lib", "audit", "events.js"), "utf8");
  for (const block of ["TOP_LEVEL_KEYS", "FILE_EVIDENCE_KEYS", "REF_EVIDENCE_KEYS"]) {
    const at = events.indexOf(`${block} = new Set([`);
    assert.ok(at > 0, `events.js 里找不到 ${block}，字段清单的源头没了`);
    const body = events.slice(at, events.indexOf("]);", at));
    for (const m of body.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/g)) out.add(m[1]);
  }
  // 层结论的 detail：report.js 里那一个 detail 字面量就是它的全部形状。
  const report = fs.readFileSync(path.join(ROOT, "lib", "audit", "report.js"), "utf8");
  for (const key of topLevelKeysOf(report, "detail: {")) out.add(key);
  // 诊断轨：所有 note / noteError / diagLog / diagError 的对象实参。
  for (const file of [...jsFiles(path.join(ROOT, "lib")), ...jsFiles(path.join(ROOT, "bin"))]) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/\b(?:note|noteError|diagLog|diagError)\(\s*(?:"[^"]*"|`[^`]*`)?\s*,?\s*\{/g)) {
      const marker = m[0];
      for (const key of topLevelKeysOf(text, marker)) out.add(key);
    }
  }
  return out;
}

test("读法正文的章节标题是问题形态", () => {
  const headings = docText().split("\n").filter((line) => /^#{2,3}\s+Q\d/.test(line));
  assert.ok(headings.length >= 10, `问题形态的章节只有 ${headings.length} 个，正文又退回字段清单了`);
  const notQuestions = headings.filter((line) => !/(吗|哪|什么|多久|怎么|要不要)/.test(line));
  assert.deepEqual(notQuestions, [], "这些标题不是问题形态");
  // 每一问都要有四段：看这几样 / 例外 / 缺什么。少一段，读者就会卡在「然后呢」。
  const text = docText();
  for (const line of headings) {
    const title = line.replace(/^#{2,3}\s+/, "").trim();
    const at = text.indexOf(line);
    const next = text.indexOf("\n### Q", at + line.length);
    const body = text.slice(at, next < 0 ? text.length : next);
    for (const part of ["看这几样", "什么算例外", "答不出来时缺什么"]) {
      assert.ok(body.includes(part), `「${title}」缺一段：${part}`);
    }
  }
});

test("双向：代码里发射的字段都在表里，表里的字段都在读法里", () => {
  const names = registered();
  const missingInTable = [...codeFields()].filter((key) => !names.has(key)).sort();
  assert.deepEqual(
    missingInTable,
    [],
    "这些字段是代码发射的、但没在 docs/log-generations.json 里登记 —— 加字段的人只改了一处",
  );

  const doc = docText();
  const missingInDoc = table().fields
    .map((row) => row.name)
    .filter((name) => !doc.includes(name));
  assert.deepEqual(missingInDoc, [], "这些字段登记了，但读法里找不到它 —— 读者不会知道去哪里看");
});

test("表里的每个字段在代码里真有一处发射点，不是凭空写的", () => {
  const sources = [...jsFiles(path.join(ROOT, "lib")), ...jsFiles(path.join(ROOT, "bin"))]
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
  const ghosts = table().fields
    .map((row) => row.name)
    .filter((name) => !new RegExp(`\\b${name}\\b`).test(sources));
  assert.deepEqual(ghosts, [], "表里有、代码里一个发射点都没有的字段");
});

test("世代表能只读日志认出每一代，且每一代都说清了差异", () => {
  const generations = table().generations;
  assert.ok(generations.length >= 4, `世代只有 ${generations.length} 代，老口径与新口径没分全`);
  const fields = registered();
  for (const generation of generations) {
    assert.ok(typeof generation.detect === "string" && generation.detect.length > 0, `${generation.id} 没写怎么认出来`);
    assert.ok(typeof generation.note === "string" && generation.note.length > 0, `${generation.id} 没写差异的后果`);
    // 「怎么认出来」必须落在具体字段上：只写「老一代」是没法执行的判据。
    assert.ok(
      [...fields].some((name) => generation.detect.includes(name)),
      `${generation.id} 的 detect 没有点到任何登记过的字段`,
    );
  }
  // 本包这一代必须点名结束标记：判收尾的锚点就在它上面。
  const latest = generations[generations.length - 1];
  assert.ok(latest.detect.includes("runEnd"), "最新一代的 detect 没提 runEnd —— 收尾判据没有锚点");
});

test("空值形态登记齐：数组与空串两种形态都写死在表里", () => {
  const byName = new Map(table().fields.map((row) => [row.name, row]));
  assert.equal(byName.get("unresolved").empty, "[] / \"\"", "unresolved 的两种形态没有登记");
  assert.equal(byName.get("runEnd").since, "v3", "runEnd 的世代没有登记");
  assert.equal(byName.get("table").since, "v3", "detail.table 的世代没有登记");
});

test("每个字段都要么有读侧命中、要么显式 writeOnly（没有第三档）", () => {
  // 为什么判这一条：一个字段只写不读时，它长得和「以后会读」一模一样 —— 加字段的人
  // 以为有人用，改读法的人以为不用写。要么点名谁在读，要么写清只给谁看。
  const fields = table().fields;
  const bad = [];
  for (const field of fields) {
    const hasReaders = Array.isArray(field.readBy) && field.readBy.length > 0;
    const writeOnly = field.writeOnly === true;
    if (hasReaders === writeOnly) {
      bad.push(`${field.name}：readBy 与 writeOnly 必须二选一（实测 readBy=${JSON.stringify(field.readBy)} writeOnly=${JSON.stringify(field.writeOnly)}）`);
      continue;
    }
    if (writeOnly) {
      if (typeof field.reason !== "string" || field.reason.trim() === "") {
        bad.push(`${field.name}：writeOnly 没有 reason —— 等于没人解释为什么只写不读`);
      }
      continue;
    }
    const missing = field.readBy.filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
    if (missing.length > 0) bad.push(`${field.name}：readBy 指向不存在的文件 ${missing.join(", ")}`);
    const hits = field.readBy.some((rel) => {
      const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
      return new RegExp(`\\b${field.name}\\b`).test(text);
    });
    if (!hits) bad.push(`${field.name}：readBy 里没有一个文件真的提到这个名字`);
  }
  assert.deepEqual(bad, [], "这些字段的读侧登记不成立");
});

test("口径：顶层表 + 三个嵌套组按组登记，成员两边都点名（断言强度只升不降）", () => {
  /*
   * 为什么单列这一条：表登记的是**顶层字段**，而 `evidence` / `detail.completeness` /
   * `detail.table` 是嵌套组 —— 把组成员逐条混进 `fields` 会让同名键（`patches` / `files` /
   * `total`）在三处各占一行、含义还对不上。口径改了，判据也得跟着锁：三组必须同时出现在
   * 表的 `$comment` 与读法的「组说明」里，且成员逐条列在读法里。
   *
   * 这一条是**加锁**，不是放宽：原来那两条双向断言原样保留，谁都没删。
   */
  const groups = {
    evidence: ["file", "marker", "hits", "bytes", "offset", "refSeq", "quote"],
    "detail.completeness": ["patches", "files", "layers"],
    "detail.table": ["total", "exempt", "unmapped", "selected", "recorded"],
  };
  const comment = String(table().$comment || "");
  const doc = docText();
  for (const [group, members] of Object.entries(groups)) {
    assert.ok(comment.includes(group), `docs/log-generations.json 的 $comment 没点名嵌套组 ${group}：口径写了、表没跟上`);
    assert.ok(doc.includes(group), `读法里没有 ${group} 的组说明：加字段的人不知道去哪看成员`);
    for (const member of members) {
      assert.ok(doc.includes(member), `组 ${group} 的成员 ${member} 在读法里找不到 —— 组说明不是成员清单`);
    }
  }
  // 顶层表里不许出现「带点的组名当字段」（`detail.completeness` / `detail.table`）：
  // 那会让「一行日志的形状」被拆散。`evidence` 本身既是顶层字段又是组名，允许它在表里。
  const names = registered();
  for (const group of Object.keys(groups)) {
    if (!group.includes(".")) continue;
    assert.ok(!names.has(group), `${group} 是组名，不该以字段身份进表（成员见组说明）`);
  }
});

test("验证清单里的每一条缺陷，信息都落在某一问的答案里", () => {
  // 这一条不是「逐条补文档」，是**归属检查**：每条缺陷的答案必须挂在某一问下。
  // 找不到 ⇒ 那条信息没有归宿，下次改字段还会漏。
  const doc = docText();
  const cases = [
    ["D2 五个入口不带 runId/entry", "都不带 `runId` / `entry`"],
    ["D2 只能按时间相邻认领", "时间相邻"],
    ["D3 有些轮本来就只在一轨", "只在一轨"],
    ["D3 五个入口只写诊断轨", "只写诊断轨"],
    ["D4 老行的 actor 会把答案带反", "712 行旧审计"],
    ["D5 老轮没有 audit.recorded", "老轮"],
    ["D7 observedTs 是落账开始时刻", "落账开始时刻"],
    ["D7 实测晚 11.6 秒", "11.6"],
    ["D8 全库没有一行带 partialReason", "没有一行"],
    ["D9 apply.host 也带 hostVersion", "apply.host.hostVersion"],
    ["D10 appliedStamp 指向的启动找不到", "找不到对应行"],
    ["D11 unresolved 两种形态", "逗号串"],
    ["D12 摘要的形状", "{sha256, bytes}"],
    ["D13 cards/ 什么时候才有", "只在「有问题」的轮次"],
    ["D14 文件名的钟是本地日期", "本地日期"],
  ];
  const missing = cases.filter(([, needle]) => !doc.includes(needle)).map(([label]) => label);
  assert.deepEqual(missing, [], "这些缺陷的信息在读法里找不到归宿");
});

test("验收程序落进了 docs/，而且是可复跑的清单", () => {
  const file = path.join(ROOT, "docs", "日志验收程序.md");
  assert.ok(fs.existsSync(file), "验收程序没有落盘 —— 下一次验收只能再从对话里捡");
  const text = fs.readFileSync(file, "utf8");
  for (const needle of ["先引读法的一节", "路径正确", "绕过点为零", "新鲜上下文", "未完成"]) {
    assert.ok(text.includes(needle), `验收程序缺一条判据：${needle}`);
  }
  // 索引完备由 check-layout 守；这里只确认真有这一行，免得索引写着、文件改名了。
  const index = fs.readFileSync(path.join(ROOT, "docs", "文档索引.md"), "utf8");
  assert.ok(index.includes("docs/日志验收程序.md"), "文档索引里没有登记验收程序");
});
