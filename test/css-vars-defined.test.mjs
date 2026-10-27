/**
 * test/css-vars-defined.test.mjs — 引用了的自定义属性必须有定义（T39）。
 *
 * ## 为什么这条能拦住真洞
 *
 * `color: var(--rt-danger, #d33)` 里的 `--rt-danger` 在全仓**没有任何定义**，于是这个
 * `var()` 永远取兜底的 `#d33`：深色主题下是一个写死的浅色系红。而 `check-style-tokens`
 * 的判据是「剥掉整个 `var(...)` 之后不许有字面色」—— 兜底被合法地剥掉，这个洞就看不见。
 *
 * 颜色门禁管的是「字面色有没有藏在 `var` 外面」，这一条管的是**另一半**：
 * `var` 里面的名字有没有人定义。两条合起来，一条 CSS 颜色才真的只有一个来源。
 *
 * ## 判据
 *
 * 一、**定义**有三种合法来源：源码里出现 `--名字:`（`<style>` 里的声明）、运行时
 *    `setProperty('--名字'`（浮窗尺寸这类拖拽时写入的几何量）、宿主注入的命名空间
 *    （`--dsw-*` 主题 token 与 `--ds-*` 字体栈 —— 它们的定义在宿主进程里，仓库里不该有）。
 * 二、**引用**：`var(--名字...)`。凡引用不在这三类里，就是这条用例要报的洞。
 * 三、**自证**：用一条夹具（`var(--rt-danger, #d33)`）证明探测器真的会报 —— 否则
 * 「零命中」可能只是正则写歪了。
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");

/** 宿主注入的命名空间：定义在宿主进程里，仓库里出现它们才算错。 */
const HOST_PREFIXES = ["--dsw-", "--ds-"];

/** 界面样式的全部源头（产物也扫：产物里的名字与源头必须一致）。 */
function uiSources() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith(".js")) files.push(rel);
    }
  };
  walk("lib/client-src");
  files.push("lib/redteam/client.js", "client.js");
  return files.map((rel) => ({ rel, text: readFileSync(join(ROOT, rel), "utf8") }));
}

/**
 * 扫描一组源文件：返回「被引用但没有定义」的属性名 → 出处。
 *
 * 只看 `var(--x` 与 `--x:` 两种写法：`var()` 里的名字是要解析的，`--x:` 是声明。
 * `setProperty('--x'` 也算声明 —— 那是 JS 在运行时写进去的几何量。
 */
function undefinedProps(sources) {
  const defined = new Set();
  const referenced = new Map();
  for (const { rel, text } of sources) {
    for (const m of text.matchAll(/(?:^|[\s;{])(--[a-z0-9-]+)\s*:/gi)) defined.add(m[1].toLowerCase());
    for (const m of text.matchAll(/setProperty\(\s*["'](--[a-z0-9-]+)/gi)) defined.add(m[1].toLowerCase());
    for (const m of text.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
      const name = m[1].toLowerCase();
      if (!referenced.has(name)) referenced.set(name, new Set());
      referenced.get(name).add(rel);
    }
  }
  const out = new Map();
  for (const [name, files] of referenced) {
    if (defined.has(name)) continue;
    if (HOST_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    out.set(name, [...files]);
  }
  return out;
}

test("探测器自证：没有定义的引用必须被报出来", () => {
  const fixture = [{
    rel: "fixture.css",
    /* 同一份夹具里既有「借来但没定义」的，也有「定义了」的：探测器要在同一次扫描里把两者分开。 */
    text: ":root{--dshp-c-text:#1a1916}.x{color:var(--rt-danger, #d33);background:var(--dshp-c-text)}",
  }];
  const found = undefinedProps(fixture);
  assert.ok(found.has("--rt-danger"), "探测器认不出没有定义的引用，本条判据已经失效");
  assert.ok(!found.has("--dshp-c-text"), "探测器把「有定义」的名字也报了：判据会变成噪声");
});

test("仓库里的每个 var(--x) 都有定义：源码、产物、宿主命名空间三者合起来覆盖", () => {
  const missing = undefinedProps(uiSources());
  const lines = [...missing].map(([name, files]) => `${name}（${files.join("、")}）`);
  assert.deepEqual(
    lines,
    [],
    "这些自定义属性被引用了却没有任何定义 —— 深色主题下它们永远是兜底那个写死值：\n  " + lines.join("\n  "),
  );
});

test("T39 的具体回归点：错误色走宿主语义 token，不再借未定义的自定义属性", () => {
  const client = readFileSync(join(ROOT, "lib", "redteam", "client.js"), "utf8");
  assert.ok(!client.includes("--rt-danger"), "--rt-danger 又回来了：它没有定义，等于一个写死的颜色");
  assert.ok(
    client.includes("var(--dsw-alias-state-error-primary)"),
    "错误色没有走宿主语义 token（--dsw-alias-state-error-primary）",
  );
  // `var()` 里不许再出现「借来的名字 + 字面兜底」这种形态：兜底会在深色主题下露馅。
  const borrowed = [...client.matchAll(/var\(\s*--rt-[a-z0-9-]+\s*,\s*#[0-9a-f]{3,8}/gi)].map((m) => m[0]);
  assert.deepEqual(borrowed, [], `var() 里还有借来的自定义属性 + 字面色兜底：${borrowed.join("、")}`);
});
