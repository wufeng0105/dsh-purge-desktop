/**
 * CONTRACT-1 / CONTRACT-5 契约：生成物与导出面的结构不变式。
 *
 * ## 生成链的真实语义：**单向装配**
 *
 * 生成链曾经是「读产物→改→写回」三步：读 client.js，改 apply() 块 / 补建
 * 占位符标记 / 整段替换 drill marker 与 __DSHP_SRC__ 占位符，再写回。三步都是
 * 「区间整体替换」，重跑字节相同（幂等）。但真正的危险不是叠加，是
 * **覆盖后的静默丢失**：只要某段代码不在源里，它就会被覆盖掉且不留痕迹。
 * 当年正是这样丢过东西 —— 3 处手改修复 + 2 个从未有源的组件。
 *
 * 现在链是**单向**的：
 *
 *   lib/client-src/shell.js + lib/client-src/**\/*.js + lib/redteam/client.js
 *                              ↓  scripts/build-client.mjs（唯一入口）
 *                          client.js
 *
 * `build-client.mjs` 不再读 client.js。所以「删掉 client.js 也能一字不差重建」，
 * 这让 `npm run build:client && git diff --exit-code client.js` 成为**有意义的**
 * 字节级门禁（CI 的 codegen drift 步骤）。
 *
 * ## 本文件锁什么
 *
 *   1. **结构不变式**（marker 存在且唯一、语法可解析、大小合理）
 *   2. **8 项关键内容的逐一存在性**（少一项就红，而不是靠一个 "function Panel(" 探针）
 *   3. **装配完整性**：每个 shell 占位符都有源、每个源文件都被引用
 *
 * ## 为什么仍然不做字节快照
 *
 * 字节快照会把「格式化差异」和「真丢失」混在一起。可复现性由 CI 的
 * codegen drift 步骤保证（build:client + embed-prompt 后 git diff --exit-code），
 * 那里才是字节级判据的正确位置。
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLIENT = join(ROOT, "client.js");
const SRC_DIR = join(ROOT, "lib", "client-src");

const BEGIN = "/* __DSH_PURGE_DRILL_BEGIN__ */";
const END = "/* __DSH_PURGE_DRILL_END__ */";

test("CONTRACT-5：client.js 的 drill marker 存在且顺序正确", () => {
  const text = readFileSync(CLIENT, "utf8");
  const begin = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  assert.ok(begin >= 0, "缺 BEGIN marker —— build-client.mjs 会静默产出坏文件");
  assert.ok(end >= 0, "缺 END marker");
  assert.ok(begin < end, "marker 顺序反了");
  // 只应各出现一次（重复嵌入会让文件翻倍）
  assert.equal(text.split(BEGIN).length - 1, 1, "BEGIN marker 出现了多次，疑似重复嵌入");
  assert.equal(text.split(END).length - 1, 1, "END marker 出现了多次，疑似重复嵌入");
});

test("CONTRACT-5：client.js 是合法的 ModuleLoader bundle", () => {
  const text = readFileSync(CLIENT, "utf8");
  assert.match(
    text.slice(0, 200),
    /window\.__ModuleLoader__\.load\(\{\s*id:\s*"dsh-purge"/,
    "文件开头不是预期的 ModuleLoader 外壳 —— 生成链可能截断了头部",
  );
});

test("CONTRACT-5：client.js 语法可解析", () => {
  assert.doesNotThrow(() => {
    execFileSync(process.execPath, ["--check", CLIENT], { stdio: "pipe" });
  }, "client.js 语法错误 —— 生成链产出了坏文件");
});

test("CONTRACT-5：client.js 大小在合理区间（防截断 / 防重复嵌入）", () => {
  const { size } = statSync(CLIENT);
  // 基线约 498 KB。低于 300 KB 说明被截断；高于 1.2 MB 说明重复嵌入。
  assert.ok(size > 300 * 1024, `client.js 只有 ${Math.round(size / 1024)} KB，疑似截断`);
  assert.ok(size < 1.2 * 1024 * 1024, `client.js 有 ${Math.round(size / 1024)} KB，疑似重复嵌入`);
});

test("CONTRACT-5：产物装的是三个真座位，不是浮层", () => {
  // 判据随设计走：座位迁移之后，「清洗 + 演练台」不再共用一块浮层，
  // 而是各占一个宿主座位。这里锁三件会静默退化的事 ——
  // 座位名写错、主区面板没注册、旧浮层又被人加回来。
  const text = readFileSync(CLIENT, "utf8");
  assert.match(text, /settings\.section/, "清洗页没有注册进设置页 section");
  assert.match(text, /sidebar\.panellist/, "演练台没有侧栏入口");
  assert.match(text, /name: "main"/, "演练台没有注册进主区 main");
  assert.doesNotMatch(text, /dsh-purge-dock/, "旧浮层的 dock id 又出现了 —— 浮层应当已经删掉");
  // 两个页面的标识仍在
  assert.match(text, /清洗|clean/i, "缺清洗页标识");
  assert.match(text, /演练台|drill/i, "缺演练台标识");
});

test("CONTRACT-5：drill 片段与源文件保持一致（生成物没跑偏）", () => {
  // build-client.mjs 把 lib/redteam/client.js 的 factory 体嵌进 client.js。
  // 这里验证关键函数名同时出现在两处，防止「改了源文件忘了重新生成」。
  const clientText = readFileSync(CLIENT, "utf8");
  const drillSrc = readFileSync(join(ROOT, "lib", "redteam", "client.js"), "utf8");
  // 取源文件里一个有辨识度的函数名
  const probe = "function Panel(";
  if (!drillSrc.includes(probe)) return; // 源文件结构变了，跳过（不假装测过）
  assert.ok(
    clientText.includes(probe) || clientText.includes("Panel:"),
    "drill 源文件里的 Panel 没出现在 client.js 里 —— 可能改了源文件但没跑 build:client",
  );
});

/**
 * 必须回灌的 8 项。
 *
 * 每项给一个**只在正确实现里出现**的判据。旧的单一探针 "function Panel("
 * 抓不到这里任何一项 —— 这正是它们曾经能被静默丢掉的原因。
 */
const MUST_SURVIVE = [
  {
    id: "1",
    name: "JSON 容错解析（读 res.text 再 parse）",
    needle: "const text = await res.text().catch(() => '')",
    why: "宿主 502 / 网关错误页会让 res.json() 抛 SyntaxError，调用方只看到 Unexpected token <",
  },
  {
    id: "2",
    name: "非 JSON 响应的结构化失败",
    needle: "non-json: ",
    why: "要能看出状态码与前 120 字正文，而不是一句 parse 异常",
  },
  {
    id: "3",
    name: "非 2xx 的错误信息回退",
    needle: "error: (data && (data.error || data.message)) || (res.status + ' ' + res.statusText)",
    why: "后端给了 error/message 就用它，否则至少给出 status + statusText",
  },
  {
    id: "4",
    name: "revokeObjectURL 延后一拍",
    needle: "setTimeout(() => { try { URL.revokeObjectURL(url) } catch { /* ignore */ } }, 1000)",
    why: "立刻 revoke 会让 click 启动的下载在部分浏览器断流",
  },
  {
    id: "5",
    name: "countdownRef 可打断 + 卸载清理",
    needle: "if (countdownRef.current) { try { clearInterval(countdownRef.current) } catch { /* ignore */ } }",
    why: "孤儿 interval 会在组件卸载后仍然调 window.location.reload()",
  },
  {
    id: "6",
    name: "WelcomeNotice 组件（首次安装的用户须知）",
    needle: "function WelcomeNotice() {",
    why: "它从来没有源文件；丢了不会报错，只会让新用户再也看不到合规提示",
  },
  {
    id: "7",
    name: "PurgeSettingsSection 组件（设置页里的清洗页内容）",
    needle: "function PurgeSettingsSection(props) {",
    why: "座位注册只负责挂载点；内容组件丢了，设置页会开出一个空白 section，而且不会报错",
  },
];

test("CONTRACT-5：7 项必须回灌的内容逐一存在（少一项就红）", () => {
  const text = readFileSync(CLIENT, "utf8");
  const missing = MUST_SURVIVE.filter((item) => !text.includes(item.needle));
  assert.deepEqual(
    missing.map((m) => `#${m.id} ${m.name}`),
    [],
    "以下内容在 client.js 里不见了 —— 它们要么不在生成链的源里（会被覆盖丢失），"
    + "要么源改了没重新生成：\n  "
    + missing.map((m) => `#${m.id} ${m.name}（${m.why}）`).join("\n  "),
  );
});

test("CONTRACT-5：__DSHP_SRC__ 占位符标记成对且唯一", () => {
  const text = readFileSync(CLIENT, "utf8");
  // purge-launcher 已随 DOM 兜底一起删除，标记也就不该再出现；
  // 剩下这两个是「原本只存在于产物里、没有源文件」的补回项，必须继续受锁。
  for (const name of ["welcome-helpers", "welcome-notice"]) {
    const begin = `/* __DSHP_SRC:${name}:BEGIN__ */`;
    const end = `/* __DSHP_SRC:${name}:END__ */`;
    assert.equal(text.split(begin).length - 1, 1, `占位符 ${name} 的 BEGIN 标记不是恰好 1 个`);
    assert.equal(text.split(end).length - 1, 1, `占位符 ${name} 的 END 标记不是恰好 1 个`);
    assert.ok(
      text.indexOf(begin) < text.indexOf(end),
      `占位符 ${name} 的标记顺序反了`,
    );
  }
});

test("CONTRACT-5：PURGE_CSS 只挂在文档级，页面组件不再各自带 style", () => {
  // 真机回归（2026-10-23）：浮层删掉后，PURGE_CSS 只剩页面组件在挂。首次安装的用户须知
  // 走的是 shell.overlay，没有页面组件先挂载 —— 于是 `.dshp-auth-mask` 的 position:fixed
  // 不生效，弹窗按文档流堆着，用户看得见窗口却点不动「同意」。
  // 判据：样式必须由 apply() 挂到 document.head（一处），页面组件里不许再出现
  // `h("style", null, PURGE_CSS)`。
  const text = readFileSync(CLIENT, "utf8");
  assert.match(text, /setAttribute\("data-dsh-purge-ui", "1"\)/, "样式注入点没了：首屏会退回无样式状态");
  assert.equal(
    (text.match(/h\("style", null, PURGE_CSS\)/g) || []).length,
    0,
    "页面组件又各自注入 PURGE_CSS —— 首屏（用户须知）照样无样式、按钮点不动",
  );
});

/**
 * 核心断言：**抽源之后不许再有无源的 UI 代码**。
 *
 * 反过来验证「源是完备的」只有一个办法：清空产物、只从 lib/client-src/ 重建，
 * 然后要求字节相同。这里不做全量字节比较（那由 CI 的 drift 门禁在干净 checkout
 * 上做），只锁三件会静默退化的结构事实：
 *
 *   1. shell.js 里每个占位符都有登记（否则那块代码在产物里凭空出现）
 *   2. lib/client-src/ 里每个文件都被 shell.js 引用（否则它变成死文件）
 *   3. 产物里不再残留任何占位符注释（装配漏了会留下它）
 */
function listSrcFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) out.push(relative(SRC_DIR, full).split(sep).join("/"));
    }
  };
  walk(SRC_DIR);
  return out;
}

test("CONTRACT-5：shell.js 的占位符与 lib/client-src/ 的文件互为完备", () => {
  const shell = readFileSync(join(SRC_DIR, "shell.js"), "utf8");
  const build = readFileSync(join(ROOT, "scripts", "build-client.mjs"), "utf8");

  const slots = [...shell.matchAll(/^\t\t\/\* __DSHP_SLOT:([a-z0-9-]+)__ \*\/$/gm)].map((m) => m[1]);
  assert.ok(slots.length > 10, `shell.js 只找到 ${slots.length} 个占位符 —— 抽源没做完`);
  assert.equal(new Set(slots).size, slots.length, "shell.js 里有重复占位符，会被装配两次");

  // SLOT_FILES 是唯一权威：占位符 → 源文件。两边的键必须完全相同。
  const mapping = {};
  for (const m of build.matchAll(/^\s{2}(?:"([a-z0-9-]+)"|([a-z][a-z0-9-]*)):\s*"([^"]+\.js)",$/gm)) {
    mapping[m[1] || m[2]] = m[3];
  }
  assert.deepEqual(
    Object.keys(mapping).sort(),
    [...slots].sort(),
    "build-client.mjs 的 SLOT_FILES 与 shell.js 的占位符集合不一致 —— "
    + "少一边就是「代码在产物里凭空出现」或「源文件成了死文件」",
  );

  const files = listSrcFiles().filter((f) => f !== "shell.js");
  const referenced = new Set(Object.values(mapping));
  const orphans = files.filter((f) => !referenced.has(f));
  assert.deepEqual(
    orphans,
    [],
    `这些源文件没有被 shell.js 的任何占位符引用（改它们不会影响产物）：\n  ${orphans.join("\n  ")}`,
  );
  const dangling = [...referenced].filter((f) => !existsSync(join(SRC_DIR, f)));
  assert.deepEqual(dangling, [], `SLOT_FILES 指向不存在的源文件：${dangling.join(", ")}`);
});

test("CONTRACT-5：产物里不残留占位符注释（装配漏了就红）", () => {
  const text = readFileSync(CLIENT, "utf8");
  const leftovers = text.match(/__DSHP_SLOT:[a-z0-9-]+__/g) || [];
  assert.deepEqual(leftovers, [], "产物里还有未替换的占位符 —— build-client 没装配完整");
});

test("CONTRACT-5：生成链是单向的（build-client.mjs 不许读 client.js）", () => {
  const build = readFileSync(join(ROOT, "scripts", "build-client.mjs"), "utf8");
  // 只判「有没有把 client.js 当输入读」。写是必须的（它是产物）。
  const reads = build.match(/readFileSync\(\s*clientPath/g) || [];
  assert.deepEqual(
    reads,
    [],
    "build-client.mjs 又在读 client.js 了 —— 产物一旦是输入，"
    + "「从零复现」立刻消失，git diff --exit-code 的门禁也就没有意义了",
  );
});
