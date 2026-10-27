/**
 * `mnemon.json` 手工覆盖项的优先级锁定。
 *
 * 背景：`mnemon.json` 没有任何程序写入方（写侧函数已删且从未被调用），它是
 * 「只供手工编辑」的逃生口。读路径有效但没有断言守着 —— 谁把
 * `lib/identity.js` 的 `mnemonKeep === true` 改成 `!== false`，或者把
 * `lib/mnemon-settings.js` 的 `pick` 顺序调换，都只会在用户手改过文件之后
 * 才暴露。这里把三条被测行为固定下来：
 *
 *   1. 优先级 文件 > 配置 > 默认；
 *   2. 文件缺失 / 坏文件时回落到配置，配置也缺失时回落到默认（默认 = 剥离）；
 *   3. 文件是**单向**逃生口：keepMnemon:true 能压过 stripMnemon，
 *      keepMnemon:false 不能反向强制剥离，只是「不表态」。
 *
 * 两层入口都要测：`loadMnemonSettings`（纯函数，直接吃 dshHome）是解析层，
 * `rewritePromptAssembly`（走 `findDshHome()`，靠 `process.env.DSH_HOME` 重定向）
 * 是真正的生效层 —— 只测解析层会漏掉「解析对了但合并方向反了」这种错。
 *
 * 不碰真实 `~/.dsh`：每个用例用 mkdtemp 造独立 dshHome，用完在 t.after 里删。
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadMnemonSettings } from "../lib/mnemon-settings.js";
import { rewritePromptAssembly } from "../lib/identity.js";

const MNEMON_SECTION_NAME = "mnemon-context";

/**
 * 造一个临时 dshHome。
 * keep 为 undefined 且 raw 为 undefined 时不写 mnemon.json（= 文件缺失）。
 * raw 用来写坏 JSON / 非布尔值这类原始内容。
 */
function tempHome(t, { keep, raw } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-mnemon-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, "dsh-purge");
  const file = path.join(dir, "mnemon.json");
  if (raw !== undefined) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, raw);
  } else if (keep !== undefined) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ keepMnemon: keep }));
  }
  return home;
}

/** 在指定 dshHome 下跑一次真实改写，返回 mnemon 段是否活下来。 */
function keepsMnemonSection(home, injectOptions) {
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const out = rewritePromptAssembly(
      {
        sections: [
          { name: "harness:identity", text: "official identity" },
          { name: MNEMON_SECTION_NAME, text: "remembered facts" },
        ],
        contexts: [],
        tools: [],
      },
      injectOptions,
    );
    assert.ok(Array.isArray(out?.sections), "rewritePromptAssembly 必须返回 sections 数组");
    return out.sections.some((section) => section?.name === MNEMON_SECTION_NAME);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
  }
}

test("mnemon.json 的 keepMnemon:true 压过 stripMnemon 开关（文件 > 配置）", (t) => {
  const home = tempHome(t, { keep: true });
  assert.equal(keepsMnemonSection(home, { dropMnemon: true }), true);
});

test("mnemon.json 缺失时回落到配置：stripMnemon 开着（dropMnemon:true）就剥离", (t) => {
  const home = tempHome(t);
  assert.equal(keepsMnemonSection(home, { dropMnemon: true }), false);
});

test("mnemon.json 缺失时回落到配置：stripMnemon 关掉（dropMnemon:false）就保留", (t) => {
  const home = tempHome(t);
  assert.equal(keepsMnemonSection(home, { dropMnemon: false }), true);
});

test("文件与配置都缺失时回落到默认：默认剥离 mnemon", (t) => {
  const home = tempHome(t);
  assert.equal(keepsMnemonSection(home, {}), false);
  assert.deepEqual(loadMnemonSettings(home), { keepMnemon: false });
});

test("keepMnemon:false 不构成强制剥离，只表示不表态（单向逃生口）", (t) => {
  const home = tempHome(t, { keep: false });
  // 配置说保留 → 保留：文件的 false 不能反向盖掉配置。
  assert.equal(keepsMnemonSection(home, { dropMnemon: false }), true);
  // 配置说剥离 → 剥离：文件没表态，回到配置。
  assert.equal(keepsMnemonSection(home, { dropMnemon: true }), false);
});

test("loadMnemonSettings 三层取值：文件 > 入参 > 默认", (t) => {
  const withFile = tempHome(t, { keep: false });
  assert.deepEqual(loadMnemonSettings(withFile, true), { keepMnemon: false });
  const withTrue = tempHome(t, { keep: true });
  assert.deepEqual(loadMnemonSettings(withTrue, false), { keepMnemon: true });
  const bare = tempHome(t);
  assert.deepEqual(loadMnemonSettings(bare, true), { keepMnemon: true });
  assert.deepEqual(loadMnemonSettings(bare), { keepMnemon: false });
});

test("loadMnemonSettings 忽略非布尔值与坏 JSON，静默落到下一层", (t) => {
  const bad = tempHome(t, { raw: "{ this is not json" });
  assert.deepEqual(loadMnemonSettings(bad, true), { keepMnemon: true });
  assert.deepEqual(loadMnemonSettings(bad), { keepMnemon: false });
  const stringy = tempHome(t, { raw: JSON.stringify({ keepMnemon: "yes" }) });
  assert.deepEqual(loadMnemonSettings(stringy, true), { keepMnemon: true });
  const nullish = tempHome(t, { raw: "null" });
  assert.deepEqual(loadMnemonSettings(nullish), { keepMnemon: false });
});

test("坏 mnemon.json 不让改写链路炸掉，行为等同文件缺失", (t) => {
  const home = tempHome(t, { raw: "{ keepMnemon: true, " });
  assert.equal(keepsMnemonSection(home, { dropMnemon: true }), false);
  assert.equal(keepsMnemonSection(home, { dropMnemon: false }), true);
});
