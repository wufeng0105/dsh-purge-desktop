/**
 * 读法文档的机器判据：文档里每个名字、路径、命令、入口都要对得上代码或真跑结果。
 *
 * 为什么存在：给 AI 的日志读法最容易烂的地方不是文笔，而是「文档说了一个代码里不存在的
 * 事件名」或「示例输出是手写的」。那种错读者看不出来，只会照着一条假线索找下去。
 * 所以这里把能机判的部分全部判掉：名字对词表与代码发射点、入口对代码字面量、
 * 路径对文件系统、示例输出对真跑 stdout、真机样本对既有门禁脚本。
 *
 * 判据只读文档与代码，不写任何文件；样例日志目录不在仓库里，缺了就跳过那一条，
 * 不拿「目录不存在」当通过。
 */
import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { EVENT_NAMES } from "../lib/audit/vocabulary.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const DOC_PATH = path.join(ROOT, "docs", "readme-for-ai.md");

/** 真机样例日志目录：优先环境变量，其次仓库旁的取回目录；都没有就跳过那一条。 */
const SAMPLE_DIR = process.env.DSH_PURGE_REAL_LOG_DIR
  || path.resolve(ROOT, "..", "..", "..", "dsh-purge-remote", "20261025-1818-V0");

const EVENT_SHAPE = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$/;
/** 带点但不是事件名的词：文件名与占位符。 */
const NOT_EVENT_SUFFIX = /\.(?:jsonl|js|mjs|md|log|json|yml|yaml|html|txt|csv|asar)$/;
/**
 * 字段路径不是事件名。只有这两个前缀算字段容器：`detail` 与 `evidence` 是审计事件里
 * 两个具名字段，文档用它们指「那条事件里的某个字段」，与事件名不会混。
 * 别的前缀一律按事件名判 —— 那正是要拦的东西（写了不存在的事件名，读者会顺着找）。
 */
const FIELD_PREFIX = /^(?:detail|evidence)\./;

/**
 * 事件名后接字段名的写法（`cli.apply.done.pending`、`startup.ready.version`）也是字段路径。
 * 判法：去掉最后一段，剩下的若是合法事件名，这条写得再长也不是「编出来的事件」。
 * 这样仍能拦住 `apply.foo.bar` 这类整条前缀都不存在的名字。
 */
function isFieldPath(span, known) {
  if (FIELD_PREFIX.test(span)) return true;
  const cut = span.lastIndexOf(".");
  return cut > 0 && known.has(span.slice(0, cut));
}

function docText() {
  return fs.readFileSync(DOC_PATH, "utf8");
}

/** 按标题切段：二级与三级标题都算，返回 标题 → 段内正文。 */
function splitSections(text) {
  const out = new Map();
  let key = "";
  for (const line of text.split("\n")) {
    const heading = line.match(/^#{2,3}\s+(.+)$/);
    if (heading) {
      key = heading[1].trim();
      out.set(key, []);
      continue;
    }
    if (key) out.get(key).push(line);
  }
  return new Map([...out].map(([k, lines]) => [k, lines.join("\n")]));
}

/** 段内所有 Markdown 表格的数据行，按单元格取出；表头与分隔行丢掉。 */
function tableRows(sectionText) {
  const rows = [];
  for (const line of sectionText.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 2) continue;
    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) {
      rows.pop();
      continue;
    }
    rows.push(cells);
  }
  return rows;
}

/** 反引号里的内容，去掉反引号。 */
function codeSpans(text) {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim());
}

function sectionMatching(sections, ...needles) {
  for (const [title, body] of sections) {
    if (needles.every((needle) => title.includes(needle))) return { title, body };
  }
  assert.fail(`文档里没有同时含「${needles.join("」「")}」的标题`);
}

/** 代码侧的诊断轨事件名：所有 diagLog / diagError / note / noteError 的首个字面量。 */
function codeDiagEventNames() {
  const found = new Set();
  const dirs = ["lib", "bin"];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.name.endsWith(".js")) continue;
      const text = fs.readFileSync(abs, "utf8");
      // 单双引号都要认：演练台（lib/redteam/**）按自己的风格写单引号，
      // 只认双引号会让它的发射点在扫描里消失，文档登记了反而报「代码里没有」。
      for (const m of text.matchAll(/(?:diagLog|diagError|note|noteError)\(\s*["']([a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+)["']/g)) {
        found.add(m[1]);
      }
    }
  };
  for (const dir of dirs) walk(path.join(ROOT, dir));
  return found;
}

/** 代码侧的入口取值：身份声明里的 entry 字面量。 */
function codeEntryValues() {
  const found = new Set();
  for (const dir of ["lib", "bin"]) {
    const walk = (abs) => {
      for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        const next = path.join(abs, entry.name);
        if (entry.isDirectory()) {
          walk(next);
          continue;
        }
        if (!entry.name.endsWith(".js")) continue;
        for (const m of fs.readFileSync(next, "utf8").matchAll(/entry:\s*"([a-z][a-z0-9-]*)"/g)) {
          found.add(m[1]);
        }
      }
    };
    walk(path.join(ROOT, dir));
  }
  return found;
}

test("文档标题后三行内有一句话，且不超过 40 字", () => {
  const lines = docText().split("\n");
  const title = lines.findIndex((line) => /^#\s/.test(line));
  assert.ok(title >= 0, "文档没有一级标题");
  const quote = lines.slice(title + 1, title + 4).find((line) => line.trim().startsWith("> 一句话："));
  assert.ok(quote, "标题后三行内没有「> 一句话：」");
  const sentence = quote.trim().slice("> 一句话：".length).trim();
  assert.ok(sentence.length > 0, "一句话是空的");
  assert.ok([...sentence].length <= 40, `一句话 ${[...sentence].length} 字，超过 40`);
});

test("审计轨事件名与 lib/audit/vocabulary.js 的 EVENT_NAMES 逐字相同", () => {
  const sections = splitSections(docText());
  const { body } = sectionMatching(sections, "审计轨的事件名");
  const listed = tableRows(body)
    .map((cells) => cells[0].replace(/`/g, "").trim())
    .filter((name) => EVENT_SHAPE.test(name));
  assert.deepEqual(
    [...new Set(listed)].sort(),
    [...EVENT_NAMES].sort(),
    "文档的审计轨事件名表与词表不一致：多了词表外的名字，或漏了词表里的名字",
  );
});

test("诊断轨事件名与代码里的发射点集合相同", () => {
  const sections = splitSections(docText());
  const timeline = sectionMatching(sections, "诊断轨里长什么样").body;
  const rest = sectionMatching(sections, "诊断轨的事件名").body;
  const listed = new Set();
  for (const body of [timeline, rest]) {
    for (const cells of tableRows(body)) {
      const name = cells[0].replace(/`/g, "").trim();
      if (EVENT_SHAPE.test(name)) listed.add(name);
    }
  }
  const code = codeDiagEventNames();
  const onlyDoc = [...listed].filter((name) => !code.has(name));
  const onlyCode = [...code].filter((name) => !listed.has(name));
  assert.deepEqual(onlyDoc, [], "文档写了代码里没有发射点的事件名");
  assert.deepEqual(onlyCode.sort(), [], "代码里有发射点、文档没有登记的事件名");
});

test("文档里出现的每个事件名都在两条轨的合法集合里", () => {
  const code = codeDiagEventNames();
  const known = new Set([...EVENT_NAMES, ...code]);
  const offenders = codeSpans(docText())
    .filter((span) => EVENT_SHAPE.test(span))
    .filter((span) => !NOT_EVENT_SUFFIX.test(span))
    .filter((span) => !isFieldPath(span, known))
    .filter((span) => !known.has(span));
  assert.deepEqual([...new Set(offenders)].sort(), [], "文档用了词表与代码都不认的事件名");
});

test("入口表就是代码里的那八个 entry 值", () => {
  const sections = splitSections(docText());
  const { body } = sectionMatching(sections, "入口");
  const listed = tableRows(body)
    .map((cells) => cells[0].replace(/`/g, "").trim())
    .filter((value) => /^[a-z][a-z0-9-]*$/.test(value));
  const code = codeEntryValues();
  assert.deepEqual([...new Set(listed)].sort(), [...code].sort(), "入口表与代码里的 entry 字面量不一致");
  assert.equal(code.size, 8, `代码里的 entry 值应为 8 个，实测 ${code.size} 个`);
});

test("文档里提到的仓库路径全部真实存在", () => {
  const refs = [...new Set(codeSpans(docText()).filter((span) => /^(?:lib|bin|test|docs|scripts)\//.test(span)))];
  assert.ok(refs.length >= 8, `只找到 ${refs.length} 个仓库路径引用，判据跑空了`);
  const missing = refs.filter((ref) => !fs.existsSync(path.join(ROOT, ref)));
  assert.deepEqual(missing, [], "文档引用了不存在的仓库路径");
});

test("audit check 的示例输出与真跑逐行一致，且退出码三档都写进文档", () => {
  const lines = docText().split("\n");
  const marker = "$ node bin/dsh-purge.js audit check --jsonl test/fixtures/audit-f6.jsonl";
  // 示例命令与它的输出写在同一个围栏里：`$ 命令` 之后到收尾围栏之间就是「示例输出」。
  const start = lines.findIndex((line) => line.trim() === marker);
  assert.ok(start >= 0, "文档里没有那条 audit check 示例命令");
  const close = lines.findIndex((line, index) => index > start && line.trim() === "```");
  assert.ok(close > start, "示例命令所在代码块没有收尾围栏");
  const documented = lines.slice(start + 1, close).map((line) => line.replace(/\r$/, ""));

  const run = spawnSync(process.execPath, ["bin/dsh-purge.js", "audit", "check", "--jsonl", "test/fixtures/audit-f6.jsonl"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(run.status, 0, `示例命令真跑退出码是 ${run.status}：${run.stderr}`);
  const actual = run.stdout.split(/\r?\n/).filter((line) => line !== "").map((line) => line.split(ROOT).join("<仓库根>"));
  assert.deepEqual(documented, actual, "文档里的示例输出与真跑 stdout 不一致");

  const sections = splitSections(docText());
  const { body } = sectionMatching(sections, "audit check");
  for (const [code, meaning] of [["0", "全过"], ["1", "有判据不过"], ["2", "用法或环境错误"]]) {
    assert.ok(body.includes(`\`${code}\``) && body.includes(meaning), `退出码 ${code}（${meaning}）没有写进文档`);
  }
});

test("退出码 1 与 2 是真跑出来的，不是文档自己说的", () => {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || ROOT, "dsh-purge-readme-"));
  try {
    const gap = path.join(dir, "2026-01-01.jsonl");
    fs.writeFileSync(gap, [
      JSON.stringify({ ts: "2026-01-01T00:00:00.000+08:00", seq: 0, event: "code.probe", result: "ok" }),
      JSON.stringify({ ts: "2026-01-01T00:00:01.000+08:00", seq: 2, event: "code.probe", result: "ok" }),
      "",
    ].join("\n"), "utf8");
    const broken = spawnSync(process.execPath, ["bin/dsh-purge.js", "audit", "check", "--jsonl", gap], { cwd: ROOT, encoding: "utf8" });
    assert.equal(broken.status, 1, `断号文件应判 1，实测 ${broken.status}`);

    const empty = spawnSync(process.execPath, ["bin/dsh-purge.js", "audit", "check", "--dir", path.join(dir, "nope")], { cwd: ROOT, encoding: "utf8" });
    assert.equal(empty.status, 2, `目录不存在应判 2，实测 ${empty.status}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("卡住清单至少六条，且每条都给了一条能直接跑的命令", () => {
  const sections = splitSections(docText());
  const { body } = sectionMatching(sections, "卡住");
  const rows = tableRows(body).filter((cells) => cells.length >= 3);
  assert.ok(rows.length >= 6, `清单只有 ${rows.length} 条`);
  const runnable = /^`(?:node |node_modules\/\.bin\/|Select-String |Get-|curl |Invoke-|GET )/;
  const without = rows.filter((cells) => !cells[2].split(/`/).some((part, index) => index % 2 === 1 && runnable.test(`\`${part}\``)));
  assert.deepEqual(without.map((cells) => cells[0]), [], "这些症状只写了结论，没给能跑的命令");
});

test("审计轨只有一个写盘函数，四个 apply 入口共用统一落账", () => {
  const calls = [];
  for (const dir of ["lib", "bin"]) {
    const walk = (abs) => {
      for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        const next = path.join(abs, entry.name);
        if (entry.isDirectory()) {
          walk(next);
          continue;
        }
        if (!entry.name.endsWith(".js")) continue;
        fs.readFileSync(next, "utf8").split("\n").forEach((line, index) => {
          if (line.includes("recordApply(") && !line.includes("export function")) {
            calls.push(`${path.relative(ROOT, next).split(path.sep).join("/")}:${index + 1}`);
          }
        });
      }
    };
    walk(path.join(ROOT, dir));
  }
  // 写盘函数只许在审计模块内部出现一次：入口各自调它，就会有人漏传 before / runId。
  assert.equal(calls.length, 1, `recordApply 有多个直接调用点：${calls.join(", ")}`);
  assert.equal(calls[0].split(":")[0], "lib/audit/index.js", `写盘调用点跑到审计模块外了：${calls[0]}`);
  for (const rel of ["lib/index.js"]) {
    const source = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.ok(source.includes('from "./audit/index.js"'), `${rel} 没有从审计模块的唯一出口取能力`);
    assert.ok(source.includes("recordApplyRun"), `${rel} 没有调用统一落账`);
  }
  const bin = fs.readFileSync(path.join(ROOT, "bin", "dsh-purge.js"), "utf8");
  assert.ok(bin.includes('from "../lib/audit/index.js"'), "CLI 没有从审计模块的唯一出口取能力");
  assert.ok(bin.includes("recordApplyRun"), "CLI 没有调用统一落账");
  assert.ok(docText().includes("recordApply"), "文档没有点名审计轨的写盘函数，读者没法自己复核");
  assert.ok(docText().includes("recordApplyRun"), "文档没有点名四个入口的统一落账段");
  assert.ok(docText().includes("四个 apply 入口"), "文档没有写清哪些入口写审计轨");
});

test("文档不许把某台机器的绝对路径抄进来", () => {
  const text = docText();
  const offenders = [/[A-Za-z]:\\/, /\/home\//, /\/Users\//].filter((pattern) => pattern.test(text));
  assert.deepEqual(offenders.map(String), [], "文档里出现了绝对路径，换成 <DSH_HOME> 这类占位符");
});

test("读法纪律那一条在文档里写死了", () => {
  assert.ok(docText().includes("日志里没有这个信息"), "文档没有「不确定就写日志里没有这个信息」这条纪律");
});

test("§3 写清 partial 的两个来源，且 exempt 不是缺口", () => {
  const { body } = sectionMatching(splitSections(docText()), "审计轨里长什么样");
  // 只写「completeness 有假」会把实测里最常见的 partial 读成记录缺口 ——
  // 真机上 completeness 三项全真照样有 partial（层内部分成功）。
  assert.ok(body.includes("层内部分成功"), "§3 缺 partial 的来源①：层内部分成功（applied>0 且有 skipped 让 applied<total）");
  assert.ok(body.includes("记录不完整"), "§3 缺 partial 的来源②：记录不完整（completeness 有假项）");
  assert.ok(body.includes("seq=29") && body.includes("seq=82"), "§3 没给来源①的实测例子，读者没有可核对的现场");
  assert.ok(body.includes("detail.exempt"), "§3 字段表漏了 detail.exempt");
  assert.ok(/exempt[^\n]*不是缺口/.test(body), "§3 没写清 exempt 是 auditExempt、不是缺口");
});

test("§2 的 status 口径与状态表一致：缺件与关闭不算失败，读写失败算", () => {
  const { body } = sectionMatching(splitSections(docText()), "诊断轨里长什么样");
  // 缺件与「设置关掉」都是「这一版不需要」，不是失败：文档必须这么写，
  // 否则读日志的人会去修一批本来就不该生效的补丁。
  assert.ok(/`missing_file`[^\n]*\*\*正常\*\*/.test(body), "§2 没写清 missing_file 算正常");
  assert.ok(/`off`[^\n]*不算失败/.test(body), "§2 没写清 off 不算失败");
  // 读写失败必须写成异常，且三处同一口径。
  assert.ok(/`read_error` \/ `write_error:…`[^\n]*\*\*异常\*\*/.test(body), "§2 没把读写失败写成异常");
  assert.ok(body.includes("设置页：**色调是 `error`"), "§2 没写清设置页的色调口径");
  // 三轨同一口径必须写清：软硬由补丁声明定，不是「审计一律失败」。
  assert.ok(body.includes("三轨对 `pattern_not_found` 是同一个口径"), "§2 没写 pattern_not_found 的三轨同一口径");
  assert.ok(body.includes("isSoftOk"), "§2 没点名三轨共用的判定函数");
  assert.ok(body.includes("旧日志"), "§2 没说明旧日志里的历史口径，读者会把旧行当成本轮矛盾");
  // apply.end 的新计数与「失败是同一判据」都要在文档里，且不许再写「恒为 0」的现口径。
  assert.ok(body.includes("`apply.end` 的 `failed` 与 `apply.host` 的 `failed` 是同一个判据"), "§2 没写 apply.end 与 apply.host 的 failed 同口径");
  assert.ok(body.includes("`readError`") && body.includes("`writeError`"), "§2 没写 apply.end 新增的两个计数");
  assert.ok(body.includes("是旧口径，不是「没有失败」"), "§2 没说明旧日志里 failed 恒 0 是旧口径");

  const core = fs.readFileSync(path.join(ROOT, "lib", "core.js"), "utf8");
  for (const field of ["readError", "writeError", "applyEndCounts("]) {
    assert.ok(core.includes(field), `核心代码里找不到 ${field}，文档里那一段跟着失效`);
  }
});

test("§2 的 method 取值表与代码一致：今天恒为 unknown，且全仓无人设置那个变量", () => {
  const core = fs.readFileSync(path.join(ROOT, "lib", "core.js"), "utf8");
  assert.ok(
    core.includes('process.env.DSH_PURGE_INSTALL_METHOD || "unknown"'),
    "install.record 的 method 默认值变了，文档的取值表跟着失效",
  );
  const writers = [];
  const scan = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(abs);
        continue;
      }
      if (!entry.name.endsWith(".js") && !entry.name.endsWith(".mjs")) continue;
      const text = fs.readFileSync(abs, "utf8");
      // 「设置」的判据是赋值或进程环境写入：只读这个变量不算写入方。
      if (/DSH_PURGE_INSTALL_METHOD\s*=[^=]|DSH_PURGE_INSTALL_METHOD\s*:/.test(text)) {
        writers.push(path.relative(ROOT, abs).split(path.sep).join("/"));
      }
    }
  };
  for (const dir of ["lib", "bin", "scripts"]) scan(path.join(ROOT, dir));
  assert.deepEqual(writers, [], "有人开始设置 DSH_PURGE_INSTALL_METHOD 了，文档「全仓没有地方设置它」这句失效");

  const { body } = sectionMatching(splitSections(docText()), "诊断轨里长什么样");
  assert.ok(body.includes("`unknown`") && body.includes("恒为"), "§2 没给 method 的取值表，或没写「今天恒为 unknown」");
  assert.ok(body.includes("`DSH_PURGE_INSTALL_METHOD`"), "§2 没写 method 的取值来源，读者没法自己复核");
});

test("§8.1 的 --dir 该填哪一层、默认值不读 DSH_HOME：与实现一致", () => {
  const impl = fs.readFileSync(path.join(ROOT, "lib", "audit", "check.js"), "utf8");
  assert.ok(
    impl.includes('path.join(os.homedir(), ".dsh", "dsh-purge", "audit")'),
    "check.js 的默认审计目录变了，文档那条默认值跟着失效",
  );
  assert.ok(!impl.includes("process.env.DSH_HOME"), "check.js 开始读 DSH_HOME 了，文档「默认值不读 DSH_HOME」这句失效");

  const { body } = sectionMatching(splitSections(docText()), "audit check");
  assert.ok(body.includes("含 `*.jsonl` 的那层目录本身"), "§8.1 没写死 --dir 该填到哪一层（填上一级会判不到文件）");
  assert.ok(/不读\s*`DSH_HOME`/.test(body), "§8.1 没写默认值与 DSH_HOME 的关系");
  assert.ok(body.includes("`--jsonl <文件>`") && body.includes("只有一份日志时用它"), "§8.1 没说单个文件该用 --jsonl");
});

test("§7 的中断判据写明了不带 runId 的两条 CLI 事件", () => {
  const { body } = sectionMatching(splitSections(docText()), "卡住");
  assert.ok(body.includes("`cli.apply.ensure`") && body.includes("`cli.apply.done`"), "§7 没点名那两条不带 runId 的 CLI 事件");
  assert.ok(/不带\s*`runId`/.test(body), "§7 没写清这两条不带 runId —— 读者会按文件顺序把成功的 apply 判成中断");
  assert.ok(body.includes("不算中断"), "§7 没明说按文件顺序读到的 cli.apply.done 不算中断");
});

test("§2.1 标明了样例就是「日志 A」的同一次 apply", () => {
  const sections = splitSections(docText());
  const key = [...sections.keys()].find((title) => title.startsWith("2.1"));
  assert.ok(key, "文档里没有 2.1 那一节");
  const body = sections.get(key);
  assert.ok(body.includes("apply-20261025T101548Z-10fe"), "§2.1 没写那次 apply 的 runId，重合无从核对");
  assert.ok(
    body.includes("日志 A") && body.includes("同一次 apply"),
    "§2.1 没标明与「日志 A」是同一次 apply，读者会把同一份证据当两份独立材料",
  );
});

test("生效判据那一节与代码同名同义：pendingRestart / asarSealed / startup.ready", () => {
  const { body } = sectionMatching(splitSections(docText()), "生效判据");
  for (const field of ["pendingRestart", "asarSealed", "patchesMatch", "appliedStamp"]) {
    assert.ok(body.includes(`\`${field}\``), `生效判据那一节没写 ${field}，读者找不到证据字段`);
  }
  // 两条推论必须都在：只写「看 pendingRestart」等于让人自己猜结论怎么下。
  assert.ok(body.includes("**生效**"), "那一节没写「什么算生效」");
  assert.ok(body.includes("**没生效**"), "那一节没写「什么算没生效」");
  assert.ok(body.includes("`startup.ready`") && body.includes("不带 `entry`"), "那一节没写清 startup.ready 不是 apply");

  const core = fs.readFileSync(path.join(ROOT, "lib", "core.js"), "utf8");
  assert.ok(core.includes("pendingRestart: pendingRestartOf(merged)"), "core 的 apply.end 没有 pendingRestart，文档那段跟着失效");
  assert.ok(core.includes("asarSealed: asarSealedForLog()"), "core 的 apply.end 没有 asarSealed");
  const startup = fs.readFileSync(path.join(ROOT, "lib", "audit", "startup.js"), "utf8");
  assert.ok(startup.includes('diagLog("startup.ready"'), "startup.ready 的发射点不见了");
  for (const field of ["version", "patchesMatch", "appliedStamp"]) {
    assert.ok(startup.includes(field), `startup.ready 少了字段 ${field}`);
  }
});

test("轮边界那一节写了四条判据与一条判不了的，且判据真接在 audit check 上", () => {
  const { body } = sectionMatching(splitSections(docText()), "轮边界");
  for (const phrase of ["末行是层结论", "都有自己的结论", "detail.completeness.layers", "prompt → code → tool"]) {
    assert.ok(body.includes(phrase), `轮边界那一节缺判据：${phrase}`);
  }
  assert.ok(body.includes("判不了"), "轮边界那一节没写清哪一类残缺判不了 —— 读者会以为判据是全的");
  assert.ok(
    body.includes("没有逐补丁判定"),
    "轮边界那一节的「不该判红的边界」漏了 aborted / 0 补丁轮 —— 读者会把 0 行读成丢账",
  );
  const check = fs.readFileSync(path.join(ROOT, "lib", "audit", "check.js"), "utf8");
  assert.ok(check.includes("--diag"), "audit check 没有 --diag，文档那条跨轨命令跑不起来");
});

test("读法与代码同源：Q1 的标记、10.1 的三条、§10 的反向边界", () => {
  // 这四条是「照字面读会读反」的地方：每条都曾经与代码相反，或由两处各说一套。
  // 断言只锁能机判的那一半 —— 句子怎么写不管，锚在哪个字段、判成什么档必须一致。
  const sections = splitSections(docText());
  const q1 = sectionMatching(sections, "Q1").body;
  assert.ok(/标记是[^。]*`runEnd`/.test(q1), "Q1 没把诊断轨的标记写成「结束事件上的 runEnd」");
  assert.ok(
    !/诊断轨的标记是\s*`apply\.end`/.test(q1),
    "Q1 又把 apply.end 这个事件写成标记了 —— 3.1 节明说它只是那一档标记的载体",
  );

  const boundary = sectionMatching(sections, "10.1").body;
  assert.ok(
    boundary.includes("judgeable=false") && boundary.includes("不能算截断"),
    "10.1 第一条没写清过渡世代是 judgeable=false、不是截断",
  );
  assert.ok(
    boundary.includes("有文件行的补丁号个数"),
    "10.1 第三条没按 log-generations.json 的定义写 recorded",
  );
  assert.ok(
    boundary.includes("selected"),
    "10.1 第三条没写过滤 apply 的 selected 分母 —— 合法过滤轮的 recorded 会被读成漏算",
  );
  assert.ok(
    boundary.includes("无 selected，按全表判"),
    "10.1 第三条没写没有 selected 的过渡日志按全表判",
  );
  assert.ok(
    !boundary.includes("该落账的（补丁表非 `auditExempt`）− `unmapped`"),
    "10.1 第三条又写回了「该落账的减 unmapped」—— 那个公式把 unresolved 也数成落了账",
  );

  const join = sectionMatching(sections, "runId").body;
  assert.ok(join.includes("已经把它删掉"), "§4 没说 schema 里 session 已删");
  assert.ok(
    !join.includes("刻意留着这个空位"),
    "§4 又写回「schema 刻意留着 session 空位」—— schema 里没有这个键",
  );

  const honest = sectionMatching(sections, "没覆盖到").body;
  assert.ok(honest.includes("反向只对 v3 判红"), "§10 没写「反向只对 v3 判红」这条边界");
  assert.ok(
    honest.includes("没有逐补丁判定"),
    "§10 没写「没有逐补丁判定的轮不判审计缺」—— aborted 轮的 0 行会被读成丢账",
  );
  // E8/E9：版本账本由四个 apply 入口在成功收尾时写，启动刷戳沿用 run_id 与 audit 摘要。
  const effect = sectionMatching(sections, "生效判据").body;
  assert.ok(effect.includes("版本账本"), "§2.2 没写版本账本由哪几个入口写 —— 读者会以为只有 HTTP 那条路");
  assert.ok(
    effect.includes("沿用旧戳"),
    "§2.2 没写启动刷戳沿用 run_id 与 audit 摘要 —— 重启后 appliedRunId 会被读成空",
  );
});

test("十个宿主 logger 直调点：文档逐条写了理由，且条数与代码里的点一致", () => {
  // 为什么锁这一条：这十个点要么带「有没有走宿主日志」的记录，要么在文档里逐条写明
  // 为什么不需要。少了理由，「为什么这里不用记」就只剩下一句口头约定 ——
  // 下一个加直调点的人会照着它再抄一个。
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (entry.name.endsWith(".js")) files.push(abs);
    }
  };
  walk(path.join(ROOT, "lib"));
  const sites = [];
  for (const abs of files) {
    const text = fs.readFileSync(abs, "utf8");
    const count = [...text.matchAll(/ctx\.logger\?\./g)].length;
    if (count > 0) sites.push({ rel: path.relative(ROOT, abs).split(path.sep).join("/"), count });
  }
  const total = sites.reduce((sum, site) => sum + site.count, 0);
  assert.equal(total, 10, `直调点数变了（实测 ${total}：${sites.map((s) => `${s.rel}×${s.count}`).join(", ")}）—— 文档里那十条理由要跟着改`);

  const { body } = sectionMatching(splitSections(docText()), "没覆盖到");
  // 每条理由都以「第 N 条」开头，编号必须连续到 10。
  for (let index = 1; index <= 10; index += 1) {
    assert.ok(body.includes(`${index}. `), `读法的诚实边界里缺第 ${index} 条理由`);
  }
  // 静态消息原文必须在文档里出现：读者能据此在宿主日志里认领那条消息。
  const messages = [];
  for (const abs of files) {
    for (const m of fs.readFileSync(abs, "utf8").matchAll(/ctx\.logger\?\.[a-z]+\?\.\(\s*'([^']+)'/g)) {
      messages.push(m[1]);
    }
  }
  assert.ok(messages.length >= 8, `只抽到 ${messages.length} 条静态消息，判据跑空了`);
  const missing = messages.filter((text) => !body.includes(text));
  assert.deepEqual(missing, [], "这些直调点的消息原文没有写进读法：读者认不出是哪一条");
});

test("真机样本自检：check-real-host-log 的六条判据里只许 C5 因设计边界而红", (t) => {
  if (!fs.existsSync(SAMPLE_DIR)) {
    t.skip(`样例目录不存在：${SAMPLE_DIR}`);
    return;
  }
  const run = spawnSync(process.execPath, ["scripts/check-real-host-log.mjs", SAMPLE_DIR], { cwd: ROOT, encoding: "utf8" });
  const out = `${run.stdout}\n${run.stderr}`;
  for (const label of ["C1 通过", "C2 通过", "C3 通过", "C4 通过", "C6 通过"]) {
    assert.ok(out.includes(label), `真机样本缺「${label}」：\n${out}`);
  }
  if (run.status !== 0) {
    assert.equal(run.status, 1, `门禁退出码 ${run.status} 不是「有判据不过」`);
    assert.ok(out.includes("C5 失败"), `只允许 C5 红（两轨 join 今天必然红），实际输出：\n${out}`);
    assert.ok(docText().includes("审计轨里永远找不到它们的"), "C5 必红这件事文档没写清，读者会把设计边界读成日志丢失");
  }
});

test("读法补齐：取最新一轮、同名不同义、启动侧盲区、join 不上、手算步骤都在", () => {
  const sections = splitSections(docText());
  const all = docText();

  // 前提：文档不许再教「找第一行」—— 多轮日志里第一轮可能是旧口径。
  assert.ok(!all.includes("找第一行含"), "§0 又写回「找第一行 apply.start」了：多轮会取错轮");
  assert.ok(all.includes("找**最后一条**"), "§0 没写「取最后一条 apply.start」");
  assert.ok(all.includes("旧口径"), "§0 没说明第一轮可能是加字段之前的旧口径");

  // 同名不同义：cli.apply.done.pending 与 apply.end.pendingRestart。
  assert.ok(all.includes("`cli.apply.done.pending` 不是 `apply.end.pendingRestart`"), "没警告这对同名不同义的字段");
  assert.ok(all.includes("0 条待清洗"), "没说清 pending 是「还有几条待清洗」");

  // 启动侧三个盲区。
  for (const phrase of [
    "`appliedStamp` 指向的那次 apply 可能不在这份日志里",
    "`appliedStamp` 的 `at` 是上一次启动留下的",
    "日志里没有「当次启动的宿主版本」",
    "诊断轨没有等价的机械完整性判据",
  ]) {
    assert.ok(all.includes(phrase), `缺一条启动侧口径：${phrase}`);
  }

  // 轮边界：次序不比 + 审计轨只记 apply。
  const runs = sectionMatching(sections, "轮边界").body;
  assert.ok(runs.includes("补丁号的次序不比"), "轮边界没写「次序不比」—— 读者会把信息项当判红");
  assert.ok(all.includes("审计轨只记 apply，不记 revert"), "没写「审计轨只记 apply」");

  // join 边界：两条 CLI 事件永远捞不到。
  const join = sectionMatching(sections, "runId").body;
  assert.ok(join.includes("`cli.apply.ensure`"), "§4 没点名 cli.apply.ensure");
  assert.ok(join.includes("永远") && join.includes("时间相邻"), "§4 没写「按 runId 永远捞不到，只能按时间相邻」");

  // 字段取值语义：unseal 三档、flash、install.record.files、appliedStamp 的 sha 段。
  const diag = sectionMatching(sections, "诊断轨的事件名").body;
  assert.ok(diag.includes('renamed="true"') && diag.includes('busy="true"') && diag.includes('pending="true"'), "cli.unseal 三字段没有取值语义");
  assert.ok(diag.includes("`install.record.files`"), "没解释 install.record.files 为什么会变");
  assert.ok(diag.includes("apply:2.0.0"), "没说 appliedStamp 的 sha 段实际长什么样");
  assert.ok(all.includes("`flash` 是「命令框闪一下」的静默链结果"), "flash 没有解释");

  // 手算步骤与「诊断轨没有 check」。
  assert.ok(all.includes("手算步骤"), "§8.1 没给「跑不了命令时」的手算步骤");
  assert.ok(all.includes("手算不了断号"), "没写诊断轨手算不了断号");

  // 失败卡：文档与代码都要有。
  assert.ok(fs.existsSync(path.join(ROOT, "lib", "audit", "remedy.js")), "remedy.js 不存在");
  assert.ok(all.includes("lib/audit/remedy.js"), "§10 没点名 remedy.js，读者找不到卡片表");
  assert.ok(all.includes("audit remedy"), "文档没写 audit remedy 命令");
});
