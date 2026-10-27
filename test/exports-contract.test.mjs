/**
 * 导出面契约（CONTRACT-1 的可执行载体）。
 *
 * 私有库也要有内部契约：`package.json` 的 6 条 exports 是「别人怎么用这个插件」
 * 的唯一官方说法。此前它没有任何断言 —— 改错一个路径，宿主静默加载失败。
 *
 * 四类断言：
 *   1. exports 表冻结：路径集合只许增不许改
 *   2. 每条 exports 都能被解析（tools.js 需要宿主，单独登记豁免）
 *   3. 顶层包的具名导出集合冻结（快照）
 *   4. `engines.node` 不低于 lib/ 与 bin/ 真正用到的内置模块下限
 *
 * 第 4 类为什么存在：`engines.node` 曾长期写着 `>=18`，而代码在加载期就静态
 * import 了 `node:sqlite`。声明低于代码地板时，低版本装得上、宿主一加载就抛，
 * 且没有任何门禁会红 —— 声明本身成了唯一会骗人的那份文档。断言双向：
 * 扫到地板模块就要求 engines 够高；一处都扫不到则红，逼人把下限放宽。
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

/** 2026-10-21 基线：6 条 exports（含 package.json 自身）。 */
const BASELINE_EXPORTS = {
  ".": "./lib/index.js",
  "./client": "./client.js",
  "./redteam": "./lib/redteam/index.js",
  "./redteam/store": "./lib/redteam/store.js",
  "./redteam/ui": "./lib/redteam/ui.js",
  "./redteam/tools": "./lib/redteam/tools.js",
  "./package.json": "./package.json",
};

/**
 * 需要宿主才能 import 的入口。
 * lib/redteam/tools.js:73 用 createRequire(profile)('@deepseek-ai/dsh-tools')，
 * 没有宿主就抛错 —— 这是设计（零外部依赖 + 从宿主解析），不是缺陷。
 */
const HOST_REQUIRED = new Set(["./redteam/tools"]);

/** 浏览器 bundle，Node 里 import 会 `window is not defined`。 */
const BROWSER_ONLY = new Set(["./client"]);

test("exports 表冻结：路径集合与基线完全一致（CONTRACT-1）", () => {
  const actual = {};
  for (const [key, value] of Object.entries(pkg.exports)) {
    actual[key] = typeof value === "string" ? value : value.default;
  }
  assert.deepEqual(
    actual,
    BASELINE_EXPORTS,
    "exports 变了。新增走 minor，改路径/删条目走 major（私有库也照此办理）",
  );
});

test("exports 的每个目标文件都真实存在", () => {
  const missing = [];
  for (const [key, value] of Object.entries(pkg.exports)) {
    const target = typeof value === "string" ? value : value.default;
    if (!existsSync(resolve(ROOT, target))) missing.push(`${key} -> ${target}`);
  }
  assert.deepEqual(missing, [], `exports 指向不存在的文件：${missing.join(", ")}`);
});

/**
 * 装机需要的 docs（白名单）。
 *
 * 为什么要有这条：`files[]` 原来整目录收 `docs`，只手写排除了两个文件。好处是新增文档自动进包，
 * 坏处是**内部文档默认外流** —— ADR、决策索引、治理审计（含删除回执与批次返工记录）
 * 都在里面。分发包是给装机用户的，那些是给维护者的，两者边界必须显式写成白名单。
 *
 * 白名单只收四类，每一类都有明确的运行时或展示用途：
 *   - `banner.svg`：两份 README 顶部引用；
 *   - `preview/`：`screenshots.json` → `lib/update.js` 的 `COPY_NAMES` 要复制它；
 *   - `readme-for-ai.md`：`lib/audit/handout.js` 把它投递到装机现场的 `audit/` 下；
 *   - 第三方声明两件：README 的第三方声明章节引用。
 */
const PACK_DOCS_ALLOW = [
  "docs/banner.svg",
  "docs/preview",
  "docs/readme-for-ai.md",
  "docs/redteam-upstream-DISCLOSURE",
  "docs/redteam-upstream-LICENSE",
];

test("files[] 的 docs 项只在装机白名单里：内部文档不许进分发包", () => {
  assert.equal(
    pkg.files.includes("docs"),
    false,
    "files[] 不许整目录收 docs —— 那会让手写的排除项变成唯一防线，新增一篇内部文档就静默外流",
  );
  const docsEntries = pkg.files.filter((entry) => entry.startsWith("docs"));
  const outside = docsEntries.filter((entry) => !PACK_DOCS_ALLOW.includes(entry));
  assert.deepEqual(
    outside,
    [],
    `files[] 里的 docs 项超出装机白名单：${outside.join("、")}——`
    + "ADR / 决策索引 / 治理审计 / 布局约定 / 术语账本 / 约束索引 都是内部文档，不进分发包",
  );
  const missing = PACK_DOCS_ALLOW.filter((entry) => !docsEntries.includes(entry));
  assert.deepEqual(
    missing,
    [],
    `装机需要的 docs 不在 files[]：${missing.join("、")}——少一项会让 README 缺图、更新器复制失败，`
    + "或装机现场拿不到日志读法",
  );
});
test("files[] 里列的路径必须真实存在（CONTRACT-2）", () => {
  const missing = [];
  for (const entry of pkg.files) {
    if (entry.startsWith("!")) continue;
    if (!existsSync(resolve(ROOT, entry))) missing.push(entry);
  }
 // CONTRACT-2 已清账：README.en.md 于 UPDATE-1 补齐（此前 files[] 列了但磁盘没有）。
  // 这条断言现在是硬红线：再出现任何缺件都会红。
  assert.deepEqual(
    missing,
    [],
    `files[] 列了不存在的路径（发布物会缺件）：${missing.join(", ")}`,
  );
});

test("bin 目标存在且可执行入口可被 node 解析", () => {
  for (const [name, target] of Object.entries(pkg.bin || {})) {
    assert.ok(existsSync(resolve(ROOT, target)), `bin ${name} -> ${target} 不存在`);
  }
});

test("peerDependencies 只允许 cordis（运行时零依赖约束）", () => {
  assert.deepEqual(Object.keys(pkg.peerDependencies || {}), ["@deepseek-ai/cordis"]);
  assert.equal(pkg.dependencies, undefined, "不允许有运行时 dependencies");
});

test("顶层包可 import，且具名导出集合冻结", async () => {
  const mod = await import("../lib/index.js");
  const names = Object.keys(mod).sort();
  assert.deepEqual(names, BASELINE_INDEX_EXPORTS);
});

/** lib/index.js 的具名导出基线（2026-10-21 实测 5 个）。 */
const BASELINE_INDEX_EXPORTS = [
  "apply",
  "default",
  "inject",
  "name",
  "registerPromptSections",
];

/**
 * ：每个导出面的符号数量基线。
 *
 * 为什么锁「数量区间」而不是「精确集合」：
 * redteam 那三个入口的导出面还会在后续迭代里增减（比如 PATCH-6 的三态工具可能外露）。
 * 精确集合会让每次合理增减都红，最后被 `|| true` 绕过 —— 那等于没锁。
 *
 * 锁区间能抓住两类真实退化：
 *   - 某个入口突然只剩 0~1 个导出 → 模块被截断 / 依赖解析失败
 *   - 某个入口导出数暴涨 → 意外 re-export 了整个依赖树
 */
const EXPORT_COUNT_RANGE = {
  "./redteam": [5, 30],
  "./redteam/store": [1, 20],
  "./redteam/ui": [1, 20],
};

test("CONTRACT-1：各导出面的符号数量在登记区间内", async () => {
  for (const [key, [min, max]] of Object.entries(EXPORT_COUNT_RANGE)) {
    const target = pkg.exports[key];
    const spec = typeof target === "string" ? target : target.default;
    const mod = await import(pathToFileURL(resolve(ROOT, spec)).href);
    const count = Object.keys(mod).length;
    assert.ok(
      count >= min && count <= max,
      `${key} 导出了 ${count} 个符号，超出登记区间 [${min}, ${max}]`,
    );
  }
});

test("每个 exports 目标都可 import（宿主依赖项单独登记）", async () => {
  for (const key of Object.keys(pkg.exports)) {
    if (key === "./package.json") continue;
    if (BROWSER_ONLY.has(key)) continue;
    const target = pkg.exports[key];
    const spec = typeof target === "string" ? target : target.default;
    const url = pathToFileURL(resolve(ROOT, spec)).href;
    if (HOST_REQUIRED.has(key)) {
      // 断言「失败原因必须是缺宿主」，而不是语法错误或路径错误。
      await assert.rejects(
        () => import(url),
        (error) => {
          assert.match(
            String(error.message),
            /cannot resolve @deepseek-ai\/dsh-tools from host/,
            `${key} 的失败原因不是「缺宿主」，说明模块本身坏了：${error.message}`,
          );
          return true;
        },
      );
      continue;
    }
    const mod = await import(url);
    assert.ok(mod && typeof mod === "object", `${key} 没有导出对象`);
  }
});

/**
 * `node:` 内置模块「裸 import 就能加载」的最低版本（实测口径）。
 *
 * 只有地板高于当前声明的模块才需要登记：它们才是 engines 的依据。
 *
 * node:sqlite 记 22.13 而不是 22.5，因为「模块第一次出现」不等于「能加载」：
 * 22.5.0 实测裸 import 直接 `ERR_UNKNOWN_BUILTIN_MODULE`，22.5–22.12 都要先带
 * `--experimental-sqlite` 才认这个模块，22.13.0 起才允许不带标志。插件是被宿主
 * 进程静态 import 的，加不了命令行标志，地板只能取「去掉标志的那一版」。
 *
 * 这张表是 API 的要求，不是 engines 的抄件：engines 的现值一律从 package.json 读，
 * 测试里不再抄一份版本号，否则两边一起错时断言照样绿。
 */
const API_FLOOR = { "node:sqlite": [22, 13] };

/** 插件自己会被加载的那两棵目录；`test/`、`scripts/` 不进宿主，不参与判定。 */
const RUNTIME_DIRS = ["lib", "bin"];

const SOURCE_EXTS = [".js", ".mjs", ".cjs"];

/** 递归收集运行时目录下的源码文件（读不到目录就当空，交给断言说清楚）。 */
function runtimeSources(dir, out = []) {
  const abs = resolve(ROOT, dir);
  if (!existsSync(abs)) return out;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const full = join(abs, entry.name);
    if (entry.isDirectory()) runtimeSources(full, out);
    else if (SOURCE_EXTS.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

/** 源码里出现过的 `node:` 模块名：静态 import、require()、动态 import() 三种写法都算。 */
function nodeBuiltinsUsed() {
  const used = new Set();
  const pattern = /(?:from|require\(|import\()\s*["'](node:[a-z0-9_./-]+)["']/g;
  for (const file of RUNTIME_DIRS.flatMap((dir) => runtimeSources(dir))) {
    for (const match of readFileSync(file, "utf8").matchAll(pattern)) used.add(match[1]);
  }
  return used;
}

/** "X[.Y[.Z]]" → 可比较的整数元组；形态不对返回 null。 */
function versionTuple(text) {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(text);
  return m === null ? null : [Number(m[1]), Number(m[2] ?? "0"), Number(m[3] ?? "0")];
}

/** actual ≥ floor（逐段比较，缺位补 0）。 */
function atLeast(actual, floor) {
  for (let i = 0; i < floor.length; i += 1) {
    if (actual[i] !== floor[i]) return actual[i] > floor[i];
  }
  return true;
}

test("engines.node 不低于代码真正用到的 Node 内置模块下限", () => {
  const declared = String(pkg.engines?.node ?? "").trim();
  // 只认单向下限：`^22.13` 与 `>=22.13 <23` 都表达不出「这段代码要的最低版本」。
  // `>=22` 这种只给 major 的写法能解析，但下限会落在 22.0，方向一自然判它太低。
  const form = /^>=(\d+(?:\.\d+){0,2})$/.exec(declared);
  assert.ok(
    form !== null,
    `engines.node 必须写成单向下限 ">=X.Y"（不要 ^，不要区间），现在是 ${JSON.stringify(declared)}`,
  );
  const enginesFloor = versionTuple(form[1]);
  const used = nodeBuiltinsUsed();
  const relevant = Object.entries(API_FLOOR).filter(([spec]) => used.has(spec));

  // 方向一：代码用了就要求声明够高。低了正是「装得上、首屏崩」那一类，必须红。
  for (const [spec, floor] of relevant) {
    assert.ok(
      atLeast(enginesFloor, floor),
      `lib/ 或 bin/ 里 import 了 ${spec}，它要求 Node ≥${floor.join(".")}，` +
        `而 engines.node 写着 ${declared}：下限偏低，低版本装完首屏即崩。`,
    );
  }

  // 方向二：一处都不用了还挂着旧地板，等于继续骗人 —— 红一下，逼人重新确认下限。
  assert.ok(
    relevant.length > 0,
    `lib/ 与 bin/ 里已经没有任何一处用到 ${Object.keys(API_FLOOR).join(" / ")}，` +
      `engines.node 可以放宽了（现在写的是 ${declared}）；` +
      `放宽后把地板表换成真正要求最高的内置 API，别直接删这条断言。`,
  );
});
