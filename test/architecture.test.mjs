/**
 * 架构约束（ARCH-1 / ARCH-1 的可执行载体）。
 *
 * ARCH-1 破的环：
 *   core.js → desktop.js → core.js            （desktop 要 atomicWriteSync/atomicCopyFile）
 *   core.js → hide-console.js → desktop.js → core.js
 *
 * 做法：把三个原子写函数抽到 lib/atomic-fs.js（零内部依赖，只依赖 node:fs/path）。
 * 抽完 desktop.js 不再回引 core.js。
 *
 * 本文件锁四件事，防止环被悄悄重新引入：
 *   1. atomic-fs.js 不许依赖任何 lib/ 内部模块（除 extract-asar 这个零依赖叶子）
 *   2. desktop.js 不许回引 core.js
 *   3. core.js 的原子写导出必须与 atomic-fs.js 是同一引用（不是复制实现）
 *   4. 实际写入行为不变
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 取出一个模块的所有内部 import 目标（相对路径）。 */
function internalImports(relPath) {
  const source = readFileSync(join(ROOT, relPath), "utf8");
  const out = [];
  const re = /from\s+["'](\.{1,2}\/[^"']+)["']/g;
  let m;
  while ((m = re.exec(source)) !== null) out.push(m[1]);
  return out;
}

test("ARCH-1：atomic-fs.js 不许依赖 core / desktop / host（否则环还在）", () => {
  const deps = internalImports("lib/atomic-fs.js");
  const forbidden = deps.filter((d) =>
    /\/(core|desktop|host|hide-console|surface)\.js$/.test(d),
  );
  assert.deepEqual(
    forbidden,
    [],
    `atomic-fs.js 依赖了会造成环的模块：${forbidden.join(", ")}`,
  );
});

test("ARCH-1：atomic-fs.js 只依赖 node 内置模块与 extract-asar（零依赖叶子）", () => {
  const deps = internalImports("lib/atomic-fs.js");
  const allowed = new Set(["./extract-asar.js"]);
  const unexpected = deps.filter((d) => !allowed.has(d));
  assert.deepEqual(
    unexpected,
    [],
    `atomic-fs.js 引入了未登记的内部依赖：${unexpected.join(", ")}`,
  );
});

test("ARCH-1：desktop.js 不许回引 core.js（这是被破掉的那条环边）", () => {
  const deps = internalImports("lib/desktop.js");
  assert.equal(
    deps.includes("./core.js"),
    false,
    "desktop.js 又 import core.js 了，环会立刻回来",
  );
  // 但必须从 atomic-fs 取原子写
  assert.ok(
    deps.includes("./atomic-fs.js"),
    "desktop.js 应从 atomic-fs.js 取原子写原语",
  );
});

test("ARCH-1：hide-console.js 与 desktop.js 之间仍是单向（不许反向）", () => {
  const desktopDeps = internalImports("lib/desktop.js");
  assert.equal(
    desktopDeps.includes("./hide-console.js"),
    false,
    "desktop.js 反向依赖 hide-console.js，会形成新环",
  );
});

test("ARCH-1：core.js 的原子写导出与 atomic-fs.js 是同一引用（不是复制实现）", async () => {
  const core = await import("../lib/core.js");
  const afs = await import("../lib/atomic-fs.js");
  for (const fn of ["atomicWriteSync", "atomicWriteFile", "atomicCopyFile"]) {
    assert.equal(
      core[fn],
      afs[fn],
      `${fn} 在 core.js 与 atomic-fs.js 不是同一函数 —— 说明实现被复制了，两份会漂移`,
    );
  }
});

test("ARCH-1：原子写实际行为不变（tmpdir 隔离，不 mock fs）", async () => {
  const afs = await import("../lib/atomic-fs.js");
  const dir = await mkdtemp(join(tmpdir(), "afs-test-"));
  try {
    // 同步写
    const f = join(dir, "a.txt");
    afs.atomicWriteSync(f, "sync-content");
    assert.equal(await readFile(f, "utf8"), "sync-content");

    // 异步写覆盖
    await afs.atomicWriteFile(f, "async-content");
    assert.equal(await readFile(f, "utf8"), "async-content");

    // 异步复制
    const src = join(dir, "src.txt");
    await writeFile(src, "copied");
    const dst = join(dir, "dst.txt");
    await afs.atomicCopyFile(src, dst);
    assert.equal(await readFile(dst, "utf8"), "copied");

    // 自动建父目录
    const nested = join(dir, "x", "y", "z.txt");
    afs.atomicWriteSync(nested, "nested");
    assert.equal(await readFile(nested, "utf8"), "nested");

    // 不留 .tmp 残骸
    const leftovers = readdirSync(dir).filter((n) => /\.(tmp|copytmp)$/.test(n));
    assert.deepEqual(leftovers, [], `原子写留下了临时文件：${leftovers.join(", ")}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ARCH-1：lib/ 下不存在任何 import 环", () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) files.push(full);
    }
  };
  walk(join(ROOT, "lib"));

  // 建图
  const graph = new Map();
  for (const full of files) {
    const rel = full.slice(ROOT.length + 1).replace(/\\/g, "/");
    const dir = dirname(rel).replace(/\\/g, "/");
    const deps = [];
    for (const spec of internalImports(rel)) {
      const parts = [];
      for (const seg of `${dir}/${spec}`.split("/")) {
        if (seg === "." || seg === "") continue;
        if (seg === "..") parts.pop();
        else parts.push(seg);
      }
      deps.push(parts.join("/"));
    }
    graph.set(rel, deps);
  }

  // DFS 找环
  const state = new Map();
  const cycles = [];
  const visit = (node, stack) => {
    if (state.get(node) === "gray") {
      const at = stack.indexOf(node);
      cycles.push([...stack.slice(at), node].join(" → "));
      return;
    }
    if (state.get(node) === "black") return;
    state.set(node, "gray");
    stack.push(node);
    for (const dep of graph.get(node) || []) {
      if (graph.has(dep)) visit(dep, stack);
    }
    stack.pop();
    state.set(node, "black");
  };
  for (const node of graph.keys()) if (!state.has(node)) visit(node, []);

  assert.deepEqual(cycles, [], `发现 import 环：\n  ${cycles.join("\n  ")}`);
});
