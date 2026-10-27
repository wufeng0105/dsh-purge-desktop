/**
 * 回归：`system_field_extracted` 必须反映 patch 89 的真实生效状态。
 *
 * ## 这条测试守的 bug
 *
 * 面板的 status / apply / override 三个端点都返回 `system_field_extracted`。
 * 原实现自己在 `index.js` 里用**裸 `require()`** 拼 agent-loop 的路径再读文件：
 *
 *     require("path").join(require("@deepseek-ai/dsh-agent-loop")?.__dirname || "", "lib", "index.js")
 *
 * `package.json` 是 `"type": "module"`，全文件 0 处 `createRequire` →
 * `ReferenceError: require is not defined` → 被 `catch { return false }` 吞掉 →
 * **该字段恒为 false**，而 patch 89 其实好好的。用户会以为清洗失败。
 *
 * ## 为什么修法不是「把 require 换成 createRequire」
 *
 * 实测三件事（本机 + 宿主机上的真实包）：
 *   1. `require` 在 ESM 下确实未定义 —— 这是第一层。
 *   2. `createRequire(import.meta.url)("@deepseek-ai/dsh-agent-loop")` → MODULE_NOT_FOUND。
 *      宿主依赖不在插件的 node_modules 里，从插件位置解析不到。
 *   3. 即便从宿主包位置 createRequire 解析成功，`require(pkg).__dirname` 仍是 `undefined`
 *      —— `dsh-agent-loop` 自己也是 `"type": "module"`，CJS 包装器不给 `__dirname`。
 *
 * 所以「拼路径 + 读文件」这条路本身是错的。现在判定收口到 `core.systemFieldExtracted()`，
 * 复用 `patchStatus()` / `applyPatches()` 已有的结论（它们已经处理了嵌套 npm 布局、
 * 桌面解包布局、宿主面门禁、targetFiles 键映射和 pattern/marker 判定）。
 *
 * ## 本文件锁什么
 *
 *   1. 字段为**真正的布尔**，且 patch 89 生效时为 `true`（不是「没抛错」）
 *   2. 反证：patch 89 未生效 / 无宿主 / 补丁表里没有它时必须是 `false`
 *   3. 判定用的是 `patchStatus` 的真实产物，不是硬编码 —— 用真实宿主跑一遍
 *   4. `lib/` 里不许再出现裸 `require(`（这正是那个 bug 的形态）
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIB = join(ROOT, "lib");

/** patch 89 的 name（与 core.js 里的 SYSTEM_FIELD_PATCH_NAME 一致）。 */
const PATCH_NAME = "SYSTEM_FIELD_EXTRACT";

/** 取 core.js 里的 patch 89。 */
async function loadCore() {
  return import("../lib/core.js");
}

/**
 * `patchStatus()` 会经 `patchAppliesHere()` 调 `detectSurface()`，
 * 在非桌面进程里会抛 `DSH_PURGE_UNSUPPORTED_SURFACE`（这是 SURFACE-3 的设计）。
 * 本文件的夹具与宿主面无关，只需强制成 desktop 让判定能跑完。
 */
function withDesktopSurface() {
  const previous = process.env.DSH_SURFACE;
  process.env.DSH_SURFACE = "desktop";
  return () => {
    if (previous === undefined) delete process.env.DSH_SURFACE;
    else process.env.DSH_SURFACE = previous;
  };
}

/** 在临时目录里造一个最小 aiBase，只放 agent-loop 一个包。 */
function makeAiBase(rootName, agentLoopText) {
  const base = join(mkdtempSync(join(tmpdir(), "p25-")), rootName, "node_modules", "@deepseek-ai");
  mkdirSync(base, { recursive: true });
  if (agentLoopText !== null) {
    const pkgDir = join(base, "dsh-agent-loop", "lib");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "index.js"), agentLoopText, "utf8");
  }
  return base;
}

/** patch 89 的「原文」（未应用态）—— 直接取补丁表，保证与实现同步。 */
function patch89Pattern(core) {
  const patch = core.ALL_PATCHES.find((p) => p.name === PATCH_NAME);
  assert.ok(patch, `补丁表里找不到 ${PATCH_NAME}，判定对象没了`);
  return patch.replacements[0].pattern;
}

test("patch 89 生效时 system_field_extracted 为 true（真实布尔，不是真值对象）", async () => {
  const restore = withDesktopSurface();
  try {
    const core = await loadCore();
    // 已应用态：markers 在文件里
    const applied = makeAiBase("applied", "// [dsh-purge-89] system field extract\nconst systemParts = [];\nconst nonSystemMessages = [];\n");
    const status = await core.patchStatus(applied);
    const patch = core.ALL_PATCHES.find((p) => p.name === PATCH_NAME);
    assert.equal(status[patch.id], "applied", "夹具里的 agent-loop 应被判为 applied");

    const value = core.systemFieldExtracted(status);
    assert.equal(typeof value, "boolean", "必须是真布尔 —— Promise/对象在 if 里恒真，等于没修");
    assert.equal(value, true, "patch 89 生效时该字段必须是 true（这正是被 bug 冻成 false 的值）");
  } finally {
    restore();
  }
});

test("反证：patch 89 未生效时必须是 false", async () => {
  const restore = withDesktopSurface();
  try {
    const core = await loadCore();
    // 原文态：pattern 还在文件里 → patchStatus 判 pending
    const pendingBase = makeAiBase("pending", patch89Pattern(core) + "\n");
    const pending = await core.patchStatus(pendingBase);
    const patch = core.ALL_PATCHES.find((p) => p.name === PATCH_NAME);
    assert.equal(pending[patch.id], "pending", "夹具应是 pending");
    assert.equal(core.systemFieldExtracted(pending), false, "pending 说明原文还在，字段不能是 true");
  } finally {
    restore();
  }
});

test("反证：无宿主 / 空状态 / 补丁表里没有它时都是 false", async () => {
  const restore = withDesktopSurface();
  try {
    const core = await loadCore();
    // 空 aiBase：agent-loop 文件不存在 → na（optional 补丁）
    const empty = makeAiBase("empty", null);
    const status = await core.patchStatus(empty);
    assert.equal(core.systemFieldExtracted(status), false, "没有宿主文件时必须 false");

    // 各种空值形态
    for (const blank of [null, undefined, {}, []]) {
      assert.equal(core.systemFieldExtracted(blank), false, `systemFieldExtracted(${JSON.stringify(blank)}) 应为 false`);
    }

    // 补丁表里没有这条补丁 → 不能假装 true
    assert.equal(
      core.systemFieldExtracted({ 89: "applied" }, []),
      false,
      "补丁表里没有 SYSTEM_FIELD_EXTRACT 时必须 false，不能按 id 硬编码",
    );
  } finally {
    restore();
  }
});

test("apply 的 report 数组也能判（apply 端点走这条）", async () => {
  const core = await loadCore();
  const patch = core.ALL_PATCHES.find((p) => p.name === PATCH_NAME);
  // applyPatches 的 report 是行数组，status 用 patch_id 关联
  assert.equal(
    core.systemFieldExtracted([{ patch_id: patch.id, status: "applied" }]),
    true,
    "本次 apply 成功改写 → true",
  );
  assert.equal(
    core.systemFieldExtracted([{ patch_id: patch.id, status: "already" }]),
    true,
    "文本已是目标态 → 对面板来说同样是生效",
  );
  assert.equal(
    core.systemFieldExtracted([{ patch_id: patch.id, status: "pattern_not_found" }]),
    false,
    "pattern 对不上 → false",
  );
  assert.equal(
    core.systemFieldExtracted([{ patch_id: patch.id, status: "na" }]),
    false,
    "不适用 → false",
  );
});

test("三个端点都用真实判定，没有硬编码 true", () => {
  const src = readFileSync(join(LIB, "index.js"), "utf8");
  const hits = [...src.matchAll(/system_field_extracted:\s*([^,\n]+)/g)].map((m) => m[1].trim());
  assert.ok(hits.length >= 3, `应至少有 3 处返回该字段，实际 ${hits.length} 处`);

  // 硬编码布尔一律不许：那正是「字段恒为 true / 恒为 false」的来源。
  const hardcoded = hits.filter((expr) => expr === "true" || expr === "false");
  assert.deepEqual(
    hardcoded,
    [],
    `这些地方把 system_field_extracted 硬编码了，会撒谎：${hardcoded.join(", ")}`,
  );

  // 每处要么直接调 core.systemFieldExtracted，要么用一个从它来的局部变量。
  // 局部变量的取法固定为 `const <name> = core.systemFieldExtracted(...)`。
  const localVars = new Set(
    [...src.matchAll(/const\s+(\w+)\s*=\s*core\.systemFieldExtracted\s*\(/g)].map((m) => m[1]),
  );
  const bogus = hits.filter((expr) => {
    if (expr.includes("core.systemFieldExtracted")) return false;
    const name = expr.match(/^[A-Za-z_$][\w$]*/)?.[0];
    return !(name && localVars.has(name));
  });
  assert.deepEqual(
    bogus,
    [],
    `这些地方没走 core.systemFieldExtracted：${bogus.join(", ")}`,
  );
});

test("lib/ 里不再有裸 require()（那个 bug 的原始形态）", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) {
        // lib/client-src/** 是**片段**，不是 ES 模块。
        // 它们由 scripts/build-client.mjs 逐字节搬进 client.js 的闭包作用域，
        // 那里的 require 是宿主 ModuleLoader 注入的，合法。
        // 把它们当 ESM 检查会误报 —— 这条测试的意图是抓 lib/ 的 Node ESM 模块。
        if (/client-src[\\/]/.test(full)) continue;
        const src = readFileSync(full, "utf8");
        // 去掉注释和字符串里的误报：只看真正的调用形态。
        //
        // 第三行：先剥掉字符串字面量。core.js 的 shim 注入源
        // （`nodeShimInject()`）是一段**被拼进宿主文件的 JS 源码字符串**，
        // 里面合法地写着 `require("node:fs")` —— 那是注入产物要跑的代码，
        // 不是本模块在 ESM 里调用 require。路径层搬走 createRequire 之后
        // 它就浮出来了。断言口径没变（仍然抓真调用）。
        const code = src
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/(^|[^:])\/\/.*$/gm, "$1")
          .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
          .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
          .replace(/`(?:[^`\\]|\\.)*`/g, "``");
        // 前面不是 . 或标识符字符（排除 foo.require( / myrequire(）
        const bare = code.match(/(?<![.\w$])require\s*\(/g) || [];
        const hasCreateRequire = /createRequire\s*\(/.test(code);
        // 浏览器 bundle 的 `require('react')` 是打包器约定的模块引用，不是 Node 的 require
        if (bare.length > 0 && !hasCreateRequire && !/redteam[\\/](client|ui)\.js$/.test(full)) {
          offenders.push(`${full.replace(ROOT, "").replace(/^[\\/]/, "")}（${bare.length} 处）`);
        }
      }
    }
  };
  walk(LIB);
  assert.deepEqual(
    offenders,
    [],
    `这些文件在 ESM 里用裸 require()，运行时会抛 ReferenceError 并被 catch 吞掉：\n  ${offenders.join("\n  ")}`,
  );
});
