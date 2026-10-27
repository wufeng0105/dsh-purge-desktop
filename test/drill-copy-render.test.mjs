/**
 * test/drill-copy-render.test.mjs — 演练台文案渲染器：只认 `**粗体**` 与 `` `代码` ``，先转义再替换。
 *
 * ## 为什么这一条是硬判据
 *
 * 用户截图里最刺眼的一条是「同一靶标**同时最多 3 个执行智能体**」—— 裸星号直接出现在界面上。
 * 根因不是漏写，是 14 条 `drill.*` 文案带着轻标记、却被当纯文本塞进节点。渲染器修好之后，
 * 「以后还会不会露裸星号」取决于两件事：渲染规则本身，以及那些文案有没有真的走渲染器。
 *
 * 所以这里测两半：
 *   一、**行为**：从产物 `client.js` 里取出 `copyToHtml` 真跑一遍（`<script>` 必须被转义成文本，
 *      不是标签；`**` 与反引号才允许产生标签）；
 *   二、**接线**：带 `**` 的那七条 `drill.*` 文案，每个调用点都在 `RichCopy` 的 text 表达式里 ——
 *      少一处就会再露一次裸星号。
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const CLIENT = readFileSync(join(ROOT, "client.js"), "utf8");

/** 从产物里取出 `function copyToHtml(...) {...}` 的源码（按花括号配平，不按行）。 */
function sourceOf(name) {
  const at = CLIENT.indexOf(`function ${name}(`);
  assert.ok(at > 0, `client.js 里没有 ${name}：渲染器没装配进产物`);
  let depth = 0;
  const open = CLIENT.indexOf("{", at);
  for (let i = open; i < CLIENT.length; i += 1) {
    if (CLIENT[i] === "{") depth += 1;
    else if (CLIENT[i] === "}") {
      depth -= 1;
      if (depth === 0) return CLIENT.slice(at, i + 1);
    }
  }
  throw new Error(`${name} 的花括号没有闭合`);
}

const copyToHtml = new Function(`${sourceOf("copyToHtml")}; return copyToHtml;`)();

test("粗体与行内代码：只认这两个标记，其余原样", () => {
  assert.equal(copyToHtml("a **b** c"), "a <strong>b</strong> c");
  assert.equal(copyToHtml("`x`"), "<code>x</code>");
  assert.equal(copyToHtml("普通一行"), "普通一行");
  /* 落单的星号不配对就保持原样：宁可难看，也不要吞掉半个句子。 */
  assert.equal(copyToHtml("一个 * 星号"), "一个 * 星号");
});

test("先转义再替换：<script> 只产生文本，不产生标签", () => {
  const out = copyToHtml("<script>alert(1)</script>");
  assert.equal(out, "&lt;script&gt;alert(1)&lt;/script&gt;");
  assert.ok(!/<script/i.test(out), "<script> 没有被转义 —— 这会变成一次 XSS");
  /* 强调标记里的内容同样先被转义：否则 `**<b>x</b>**` 会把用户内容变成真标签。 */
  assert.equal(copyToHtml("**<b>x</b>**"), "<strong>&lt;b&gt;x&lt;/b&gt;</strong>");
  assert.equal(copyToHtml("a & b"), "a &amp; b");
  assert.equal(copyToHtml("`<i>`"), "<code>&lt;i&gt;</code>");
});

test("接线：七条带 ** 的 drill 文案都走 RichCopy（少一处就再露裸星号）", () => {
  const i18n = readFileSync(join(ROOT, "lib", "client-src", "i18n.js"), "utf8");
  const zi = i18n.indexOf("const zh = {");
  const ze = i18n.indexOf("const en = {");
  const zhText = i18n.slice(zi, ze);
  const enText = i18n.slice(ze);
  const boldZh = [...zhText.matchAll(/^\t{3}"(drill\.[\w.]+)":\s*"(.*)",$/gm)]
    .filter((m) => m[2].includes("**"))
    .map((m) => m[1]);
  const boldEn = [...enText.matchAll(/^\t{3}"(drill\.[\w.]+)":\s*"(.*)",$/gm)]
    .filter((m) => m[2].includes("**"))
    .map((m) => m[1]);
  assert.ok(boldZh.length >= 7, `中文词典里带 ** 的 drill 文案只剩 ${boldZh.length} 条，取样点可能变了`);
  assert.deepEqual(boldEn, boldZh, "两份词典的轻标记文案不是同一批：一处改了另一处没跟");

  for (const key of boldZh) {
    const needle = `dt('${key}')`;
    let from = 0;
    let seen = 0;
    while (true) {
      const at = CLIENT.indexOf(needle, from);
      if (at < 0) break;
      seen += 1;
      const before = CLIENT.slice(Math.max(0, at - 400), at);
      assert.ok(
        before.includes("h(RichCopy, {"),
        `${key} 的调用点没有经过 RichCopy：界面上会再出现一次裸星号（位置 ${at}）`,
      );
      from = at + needle.length;
    }
    assert.ok(seen > 0, `${key} 在产物里没有调用点：文案带着标记却没人渲染它`);
  }
});

test("Emoji 清零：产物里不再有 ⚠️ / ✅ 这类字符", () => {
  const emoji = CLIENT.match(/[\u26a0\u2705\u274c\u2b50\u2139]/gu) || [];
  assert.deepEqual(emoji, [], `产物里还有 emoji：${emoji.join("")} —— 界面文案改用「注意 / 提示」前缀`);
});
