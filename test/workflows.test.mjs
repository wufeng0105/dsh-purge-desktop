/**
 * CI 工作流契约（CI-3 的可执行载体）。
 *
 * 背景：`release.yml` 曾经因为两个写死的条件同时不成立，**从建仓起从未执行过**：
 *   1. `on.push.branches: [master]`，而实际默认分支是 `main`
 *   2. `if: github.repository == 'wufeng0105/dsh-purge'`，而实际仓库是 `dsh-purge-desktop`
 * 里面那三条 `node --check` 是当时唯一的语法门禁，也一起没跑过。
 * 0 测试能存在这么久，直接原因就是 CI 是死的。
 *
 * 本文件把「workflow 必须真的能跑」变成可断言的东西：
 *   - 触发条件必须覆盖实际默认分支
 *   - 守卫不许写死仓库名（fork / 私有镜像 / 改名都要能跑）
 *   - 门禁步骤必须存在，且不许被 `|| true` 吞掉
 *   - verify 集合一致性：package.json 的 verify 链与 verify.yml 的步骤集合满足
 *     声明式映射（本地有 = CI 有；CI 独有项只有 codegen drift 且在 AGENTS.md 登记）
 */
import { test } from "node:test";
import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS = join(ROOT, ".github", "workflows");

function readWorkflow(name) {
  return readFileSync(join(WORKFLOWS, name), "utf8");
}

/** 剥掉 YAML 注释行，只看生效内容。 */
function yamlBody(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

test("CI-3：verify.yml 的触发分支覆盖 main（实际默认分支）", () => {
  const body = yamlBody(readWorkflow("verify.yml"));
  assert.match(body, /branches:\s*\[[^\]]*main/, "verify.yml 必须触发 main");
  assert.match(body, /pull_request/, "verify.yml 必须跑 PR");
});

test("CI-3：verify.yml 的语法检查步骤存在且没被 || true 吞掉", () => {
  const body = yamlBody(readWorkflow("verify.yml"));
  assert.match(body, /node --check lib\/index\.js/, "缺 lib/index.js 语法检查");
  assert.match(body, /node --check lib\/core\.js/, "缺 lib/core.js 语法检查");
  assert.match(body, /node --check client\.js/, "缺 client.js 语法检查（生成物）");
  // 这些步骤不许带 `|| true`
  const checkLines = body
    .split(/\r?\n/)
    .filter((line) => /node --check/.test(line));
  assert.ok(checkLines.length > 0);
  for (const line of checkLines) {
    assert.equal(
      /\|\|\s*true/.test(line),
      false,
      `语法检查被 || true 吞掉了：${line.trim()}`,
    );
  }
});

test("CI-3：release.yml 的守卫不写死仓库名", () => {
  const body = yamlBody(readWorkflow("release.yml"));
  const ifLines = body.split(/\r?\n/).filter((line) => /^\s*if:/.test(line));
  assert.ok(ifLines.length > 0, "release.yml 缺 if 守卫");
  for (const line of ifLines) {
    assert.equal(
      /github\.repository\s*==/.test(line),
      false,
      `守卫写死了仓库名，改名/fork 后 workflow 会静默失效：${line.trim()}`,
    );
  }
});

test("CI-3：release.yml 的触发条件不再只有 master", () => {
  const body = yamlBody(readWorkflow("release.yml"));
  // 现在按 tag 触发，不依赖分支名 —— 分支名改来改去都不会让它静默失效
  assert.match(body, /tags:/, "release.yml 应按 tag 触发");
  const branchLines = body.split(/\r?\n/).filter((line) => /^\s*-\s*master\s*$/.test(line));
  assert.equal(
    branchLines.length,
    0,
    "不许再出现只列 master 的分支触发（实际默认分支是 main）",
  );
});

test("CI-4：release.yml 的发布门禁含 test 与 arch（子集，全量由 tag 前的 verify.yml 承担）", () => {
  const body = yamlBody(readWorkflow("release.yml"));
  assert.match(body, /npm test/, "发布前必须跑测试");
  assert.match(body, /npm run arch/, "发布前必须跑依赖规则");
});

test("UPDATE-1：release.yml 含更新通道检查（私有库不许打出指向公网的包）", () => {
  const body = yamlBody(readWorkflow("release.yml"));
  assert.match(body, /update channel/i, "缺 update channel 门禁步骤");
  assert.match(body, /preferred.*local|local.*preferred/, "门禁必须检查 preferred === local");
});

test("CI-3：workflow 文件不含 tab（YAML 语法硬要求）", () => {
  for (const name of ["verify.yml", "release.yml"]) {
    const text = readWorkflow(name);
    assert.equal(text.includes("\t"), false, `${name} 含 tab，YAML 会解析失败`);
  }
});

test("类型检查：verify.yml 有 tsc 步骤，且没被 || true 吞掉", () => {
  const body = yamlBody(readWorkflow("verify.yml"));
  assert.match(body, /npx tsc --noEmit/, "缺 checkJs 类型检查步骤");
  const tscLines = body.split(/\r?\n/).filter((line) => /tsc --noEmit/.test(line));
  assert.ok(tscLines.length > 0, "找不到 tsc --noEmit 那一行");
  for (const line of tscLines) {
    assert.equal(
      /\|\|\s*true/.test(line),
      false,
      `类型检查被 || true 吞掉了：${line.trim()}`,
    );
  }
});

test("类型检查：tsconfig.json 只覆盖新目录，且 table.js 被排除", () => {
  // tsconfig 是 JSONC（TypeScript 官方支持注释）。注释在这里是**说明**，
  // 不是装饰 —— 「为什么只覆盖新目录」「为什么排除 table.js」都写在里面。
  // 所以解析前剥注释，而不是把注释删掉。
  const raw = readFileSync(join(ROOT, "tsconfig.json"), "utf8");
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  const tsconfig = JSON.parse(stripped);
  const include = tsconfig.include || [];
  // 只覆盖补丁表 / 路径层 / 提示词层 / shim 这几个新目录。老代码
  // （core.js / index.js / redteam）一次性
  // 打开 checkJs 会得到几千条 implicit-any 噪音，最后必然被忽略。
  for (const dir of ["lib/patch/", "lib/host/", "lib/prompt/", "lib/shim/"]) {
    assert.ok(include.includes(dir), `tsconfig.include 缺 ${dir}`);
  }
  // include 里的目录必须**真实存在**。
  //
  // 原来这里写死过 "lib/hostfs/"（某个执行方案里的目标结构），但那个目录从未创建
  // ——实际产出的片段是 lib/client-src/，而它是被文本装配的、不是 ESM 模块，
  // 不适合 checkJs。tsc 对不存在的 include 目录静默容忍，于是这条死配置连同
  // 这句断言一起活了两轮。断言改成「存在性」之后，这类死配置会自己红。
  for (const dir of include) {
    assert.ok(
      existsSync(join(ROOT, dir)),
      `tsconfig.include 指向不存在的目录 ${dir}（死配置）`,
    );
  }
  assert.equal(include.includes("lib/"), false, "tsconfig 不许 include 整个 lib/");
  assert.ok(
    (tsconfig.exclude || []).includes("lib/patch/table.js"),
    "table.js 是数据字面量，必须排除在 checkJs 之外",
  );
  assert.equal(tsconfig.compilerOptions.checkJs, true);
  assert.equal(tsconfig.compilerOptions.noEmit, true);
  assert.equal(tsconfig.compilerOptions.allowJs, true);
  // 不设 strict：新代码还没到能扛住 strict 的程度，设了只会得到噪音。
  assert.equal(tsconfig.compilerOptions.strict, false);
  assert.equal(tsconfig.compilerOptions.noImplicitAny, false);
});

test("类型检查：typescript 在 devDependencies，不在 dependencies（CONTRACT-3）", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.dependencies, undefined, "运行时零依赖是硬红线");
  assert.ok(pkg.devDependencies?.typescript, "typescript 必须在 devDependencies");
});

// ── verify 集合一致性（本地 = CI − codegen drift） ────────────────────────────
//
// 为什么要有这组断言：本地 npm run verify 与 CI verify.yml 曾是两套集合，统一两侧时
// 实测发现 HEAD 上带着 3 处 JSDoc 注解错位——本地从未跑过 tsc 所以一直没暴露。统一时
// 拍板的映射是「本地 = CI − codegen drift」（codegen drift 要干净 git 树，本地常不可
// 满足），后来 CI 又单列过两个 bundle 步骤，映射实际上一直在漂。这组断言把映射变成
// 声明式表格：往任何一边加门禁必须两边同步加，并先改这里的表。

/** 本地 verify 链的每一步 → CI 步骤名 + 该步骤 run 块里必须出现的命令原文。 */
const LOCAL_TO_CI = [
  ["npm run test", "Unit + contract tests", "npm test"],
  ["npm run arch", "Dependency rules", "npm run arch"],
  ["npm run dead", "Dead code (knip)", "npm run dead"],
  ["npm run patch-guard", "Patch guard (ast-grep)", "npm run patch-guard"],
  ["npm run check:artifact", "Artifact undeclared names (CONTRACT-7)", "npm run check:artifact"],
  ["node scripts/check-ui-tree.mjs", "UI tree reverse check", "node scripts/check-ui-tree.mjs"],
  ["node scripts/check-style-tokens.mjs", "Style token purity", "node scripts/check-style-tokens.mjs"],
  ["node scripts/check-design-tokens.mjs", "Design token purity", "node scripts/check-design-tokens.mjs"],
  ["npm run check:lib-names", "Lib undeclared names (CONTRACT-8)", "npm run check:lib-names"],
  ["node scripts/check-file-roles.mjs", "Tidiness gates (file roles / layout / comments)", "node scripts/check-file-roles.mjs"],
  ["node scripts/check-layout.mjs", "Tidiness gates (file roles / layout / comments)", "node scripts/check-layout.mjs"],
  ["node scripts/check-comments.mjs", "Tidiness gates (file roles / layout / comments)", "node scripts/check-comments.mjs"],
  ["node scripts/check-terms.mjs", "Term purity (TERM-1)", "node scripts/check-terms.mjs"],
  ["node scripts/check-reader-follows.mjs", "Reader follows spec (READER-1)", "node scripts/check-reader-follows.mjs"],
  ["npx tsc --noEmit", "Type check (JSDoc / checkJs)", "npx tsc --noEmit"],
  ["node --check lib/index.js", "Syntax check", "node --check lib/index.js"],
  ["node --check lib/core.js", "Syntax check", "node --check lib/core.js"],
  ["node --check lib/stamp.js", "Syntax check", "node --check lib/stamp.js"],
  ["node --check client.js", "Syntax check", "node --check client.js"],
  ["node scripts/audit-smoke.mjs", "Audit log smoke", "node scripts/audit-smoke.mjs"],
  ["node scripts/check-audit-completeness.mjs", "Audit completeness probe (AUDIT-1)", "node scripts/check-audit-completeness.mjs"],
];

/**
 * CI 独有步骤 → 为什么本地没有。
 * 这一张表是「CI 独有项仅 codegen drift」的声明：新增独有步骤必须在这里登记理由，
 * 并在 AGENTS.md 写明，否则下面的集合断言会红。
 */
const CI_ONLY = new Map([
  ["Codegen drift (CONTRACT-5)", "要干净 git 树，本地工作区常不可满足"],
]);

/** verify.yml 里全部具名步骤的声明式全表。环境准备不是门禁，单列一行说明。 */
const EXPECTED_CI_STEPS = [
  "Install dev tooling",
  ...new Set(LOCAL_TO_CI.map(([, ci]) => ci)),
  ...CI_ONLY.keys(),
];

/** verify.yml 里只有 uses 没有 name 的步骤（checkout 与 setup-node）。 */
const EXPECTED_USES_ONLY = ["actions/checkout@v4", "actions/setup-node@v4"];

/** 剥掉 YAML 行首引号。 */
const unquote = (s) => s.replace(/^["']|["']$/g, "");

/**
 * 极简步骤解析：只要「步骤名 + run 块正文」两样。
 * run 块按块标量缩进收集（比 run: 键更深的行都是正文），`- name:` / `- uses:`
 * 开新步骤。不做完整 YAML 解析——verify.yml 的结构就这一种形状。
 */
function parseSteps(yaml) {
  const steps = [];
  let current = null;
  let runIndent = null;
  for (const line of yaml.split(/\r?\n/)) {
    const header = /^\s*-\s*(name|uses):\s*(.+)$/.exec(line);
    if (header) {
      current = {
        name: header[1] === "name" ? unquote(header[2].trim()) : null,
        uses: header[1] === "uses" ? unquote(header[2].trim()) : null,
        run: "",
      };
      steps.push(current);
      runIndent = null;
      continue;
    }
    if (!current) continue;
    const run = /^\s*run:\s*(.*)$/.exec(line);
    if (run) {
      runIndent = /^\s*/.exec(line)[0].length;
      const rest = run[1].trim();
      // 单行写法直接收；块标量（| 或 >）等后续缩进行
      if (rest && !rest.startsWith("|") && !rest.startsWith(">")) current.run += `${rest}\n`;
      continue;
    }
    if (runIndent !== null) {
      const indent = /^\s*/.exec(line)[0].length;
      if (line.trim() === "" || indent > runIndent) {
        current.run += `${line}\n`;
        continue;
      }
      runIndent = null;
    }
  }
  return steps;
}

test("verify 集合一致性：verify 链的每一步都在映射表里登记", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const chain = pkg.scripts.verify.split("&&").map((s) => s.trim());
  const mapped = new Set(LOCAL_TO_CI.map(([local]) => local));
  const missing = chain.filter((step) => !mapped.has(step));
  assert.deepEqual(
    missing,
    [],
    `verify 链有未登记步骤：${missing.join("、")}——加门禁必须两边同步加，`
    + "并先把本文件的 LOCAL_TO_CI 映射表补上（本地 = CI − codegen drift）",
  );
  const stale = [...mapped].filter((step) => !chain.includes(step));
  assert.deepEqual(
    stale,
    [],
    `映射表里有 verify 链已不含的步骤：${stale.join("、")}——本地链改了，映射表要同步删`,
  );
});

test("verify 集合一致性：每个本地步骤在 CI 有同名步骤且命令原文在场", () => {
  const steps = parseSteps(readWorkflow("verify.yml"));
  const byName = new Map(steps.filter((s) => s.name).map((s) => [s.name, s]));
  const problems = [];
  for (const [local, ciStep, ciCommand] of LOCAL_TO_CI) {
    const step = byName.get(ciStep);
    if (!step) {
      problems.push(`${local} → CI 缺步骤「${ciStep}」`);
      continue;
    }
    if (!step.run.includes(ciCommand)) {
      problems.push(`${local} → CI 步骤「${ciStep}」的 run 块里找不到 ${ciCommand}`);
    }
  }
  assert.deepEqual(problems, [], `CI 与本地集合漂移：\n  ${problems.join("\n  ")}`);
});

test("verify 集合一致性：CI 步骤集合等于声明式全表，独有项只有 codegen drift", () => {
  const steps = parseSteps(readWorkflow("verify.yml"));
  const named = steps.filter((s) => s.name).map((s) => s.name).sort();
  const usesOnly = steps.filter((s) => !s.name).map((s) => s.uses).sort();
  assert.deepEqual(named, [...EXPECTED_CI_STEPS].sort(), "verify.yml 的具名步骤与声明式全表不符");
  assert.deepEqual(usesOnly, [...EXPECTED_USES_ONLY].sort(), "verify.yml 的非门禁步骤（checkout / setup-node）与声明不符");

  const mapped = new Set(LOCAL_TO_CI.map(([, ci]) => ci));
  const unmapped = named.filter((name) => !mapped.has(name) && !CI_ONLY.has(name) && name !== "Install dev tooling");
  assert.deepEqual(
    unmapped,
    [],
    `CI 有未登记的步骤：${unmapped.join("、")}——CI 独有项只许 codegen drift（要干净 git 树），`
    + "其余必须两边同步；先改 LOCAL_TO_CI / CI_ONLY 两张表再改 workflow",
  );
});

test("verify 集合一致性：codegen drift 的 CI 独有地位在 AGENTS.md 登记", () => {
  const agents = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
  assert.match(agents, /codegen drift/, "AGENTS.md 必须写明 codegen drift");
  assert.match(agents, /CI 独有/, "AGENTS.md 必须写明 codegen drift 是 CI 独有");
});
