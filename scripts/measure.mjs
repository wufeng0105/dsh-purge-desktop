/**
 * scripts/measure.mjs — 度量口径只写在这一个脚本里，结果只喂生成链。
 *
 * 存在理由：architecture/*.yaml 由生成器整份重写，它要的那批数字必须有一个唯一的
 * 算法出处，否则同一件事会在两处各算一遍、慢慢算成两个答案。口径写在每个 measure*
 * 函数的注释里；改口径就改这里，不要手改产物里的数字。
 *
 * 只读仓库文件 + 只写 .tmp-rebuild/*.json（中间产物，不入库），不碰任何受版本
 * 控制的文件。下游：scripts/gen-architecture.mjs 读这两个 JSON 生成 architecture/*.yaml。
 *
 * 用法：node scripts/measure.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
// 硬编码中文的计数口径与界面片段清单住在 cjk-count.mjs：度量与棘轮共用一处实现，
// 改口径只改那一处，两边不会漂。
import { CLIENT_SRC, countCjk } from "./cjk-count.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, ".tmp-rebuild");
mkdirSync(outDir, { recursive: true });

const read = (rel) => readFileSync(join(root, rel), "utf8");
/** 统计行数：只按 LF 切，末尾换行不算一行（与 `wc -l` 同口径）。 */
const linesOf = (text) => {
  const parts = text.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts.length;
};
const bytesOf = (text) => Buffer.byteLength(text, "utf8");

// ── 1) 文件度量 ───────────────────────────────────────────────────────────────
// CLIENT_SRC（界面片段清单）从 cjk-count.mjs import —— 它是口径的一部分。

function measureFiles() {
  const srcRows = CLIENT_SRC.map((rel) => {
    const text = read(join("lib", "client-src", rel));
    return { path: `lib/client-src/${rel}`, bytes: bytesOf(text), lines: linesOf(text) };
  });
  const client = read("client.js");
  const drill = read("lib/redteam/client.js");
  return {
    artifactClient: { path: "client.js", bytes: bytesOf(client), lines: linesOf(client) },
    drillFragment: { path: "lib/redteam/client.js", bytes: bytesOf(drill), lines: linesOf(drill) },
    clientSrc: {
      files: srcRows.length,
      bytes: srcRows.reduce((n, r) => n + r.bytes, 0),
      lines: srcRows.reduce((n, r) => n + r.lines, 0),
      rows: srcRows,
    },
  };
}

// ── 2) 补丁表 ─────────────────────────────────────────────────────────────────
async function measurePatches() {
  const t = await import("../lib/patch/table.js");
  const { TARGET_KEYS } = await import("../lib/host/targets.js");
  const rows = t.ALL_PATCHES.map((p) => {
    const markers = Array.isArray(p.markers) ? p.markers : [];
    const first = markers.length ? markers[0] : null;
    const firstText = typeof first === "string" ? first
      : first && typeof first === "object" ? String(first.pattern ?? first.text ?? "") : "";
    const groupKey = t.DISPLAY_GROUP_BY_ID.get(p.id) ?? null;
    return {
      id: p.id,
      name: p.name,
      layer: p.layer ?? "",
      layerEn: p.layer_en ?? "",
      file: p.file,
      rel: p.rel ?? null,
      desc: p.desc ?? "",
      onMiss: p.onMiss ?? "fail",
      surfaces: p.surfaces ?? null,
      strictFiles: p.strictFiles ?? null,
      skipIfMarked: Boolean(p.skipIfMarked),
      replacements: Array.isArray(p.replacements) ? p.replacements.length : 0,
      markerCount: markers.length,
      firstMarker: firstText.slice(0, 40),
      displayGroup: groupKey,
      displayTitle: t.displayTitleOf(groupKey, p),
    };
  });
  // Map 累加后转回对象：键集与插入序和逐键累加完全一致（输出 JSON 逐字节相同），
  // 且不产生 computed member assignment——understand 的增量符号校验会把后者
  // 当作 scope 不可解析的通配 evidence，拦停整个知识图谱更新。
  const layerCounts = new Map();
  for (const r of rows) layerCounts.set(r.layer, (layerCounts.get(r.layer) ?? 0) + 1);
  const byLayer = Object.fromEntries(layerCounts);
  const grouped = Object.entries(t.PATCH_DISPLAY_GROUPS).map(([key, ids]) => ({
    key,
    ids,
    title: t.displayTitleOf(key, rows.find((r) => r.id === ids[0])),
  }));
  const mergedAway = grouped.reduce((n, g) => n + g.ids.length, 0);
  return {
    total: rows.length,
    byLayer,
    arrays: {
      PATCHES: t.PATCHES.length,
      CODE_PATCHES: t.CODE_PATCHES.length,
      ENGINE_PATCHES: t.ENGINE_PATCHES.length,
      NEW_TOOL_PATCHES: t.NEW_TOOL_PATCHES.length,
    },
    display: {
      groups: grouped,
      mergedAway,
      // 展示行数 = 总数 - 被合并掉的条数 + 每组一行
      rows: rows.length - mergedAway + grouped.length,
    },
    ids: rows.map((r) => r.id),
    targetKeys: TARGET_KEYS.length,
    rows,
  };
}

// ── 3) HTTP 路由与 op ─────────────────────────────────────────────────────────
function measureHttp() {
  const idx = read("lib/index.js");
  const idxLines = idx.split("\n");
  const exact = [];
  const prefix = [];
  idxLines.forEach((line, i) => {
    const m = /kind: "(exact|prefix)",/.exec(line);
    if (!m) return;
    // path 有时在下一行（exact 的多行写法），有时同一行（prefix 的单行写法）。
    const same = /path: "([^"]+)"/.exec(line);
    const next = /path: "([^"]+)"/.exec(idxLines[i + 1] ?? "");
    const p = same ?? next;
    (m[1] === "exact" ? exact : prefix).push({ line: i + 1, path: p ? p[1] : "", handlerLine: i + 2 });
  });
  // 路由 handler 内允许的方法：扫描每个 routeregister 块里的 request.method 判定
  return { exact, prefix, exactCount: exact.length, prefixCount: prefix.length };
}

/**
 * op 名扫描。
 *
 * 口径：在演练台聚合路由的分发文件里，匹配 `op === 'x'` / `op !== 'x'` / `.op === 'x'`
 * 三种写法，取去重后的 op 名。**已知漏项**：用数组 includes 声明的 op（ui.js:1010
 * 的 `['version','updateCheck','updateApply']`）不会被正则捕获，必须人工补。
 * 文档里的 op 总数 = 本函数结果 ∪ 人工补的数组声明项。
 */
function measureOps() {
  const files = ["lib/redteam/store-core.js", "lib/redteam/ui.js"];
  /** 类型名不是 op：`typeof op === 'string'` 这类守卫会被 `op === 'x'` 正则误吞。 */
  const NOT_OP = new Set(["string", "number", "boolean", "undefined", "function", "object", "symbol", "bigint"]);
  const found = new Map();
  for (const f of files) {
    const lines = read(f).split("\n");
    lines.forEach((line, i) => {
      const re = /\.?op\s*[!=]==?\s*'([a-zA-Z][a-zA-Z0-9]*)'/g;
      let m;
      while ((m = re.exec(line)) !== null) {
        if (NOT_OP.has(m[1])) continue;
        const prev = found.get(m[1]) ?? [];
        prev.push(`${f}:${i + 1}`);
        found.set(m[1], prev);
      }
    });
  }
  // 人工补：数组形式的 op 声明（正则抓不到）
  const arrayDeclared = [];
  const uiLines = read("lib/redteam/ui.js").split("\n");
  uiLines.forEach((line, i) => {
    const m = /\[([^\]]*)\]\.includes\(request\.op\)/.exec(line);
    if (!m) return;
    for (const q of m[1].matchAll(/'([a-zA-Z][a-zA-Z0-9]*)'/g)) arrayDeclared.push({ op: q[1], at: `lib/redteam/ui.js:${i + 1}` });
  });
  for (const d of arrayDeclared) {
    const prev = found.get(d.op) ?? [];
    prev.push(d.at);
    found.set(d.op, prev);
  }
  const ops = [...found.keys()].sort();
  return { count: ops.length, ops, arrayDeclared };
}

// ── 4) 硬编码中文 ─────────────────────────────────────────────────────────────
/**
 * 口径：见 scripts/cjk-count.mjs 的头注释（计数函数与正则都在那里，本文件只做汇总）。
 * 排除 lib/client-src/i18n.js 本身（那是词典，不是待清零的硬编码）。
 */
function measureCjk() {
  const srcFiles = CLIENT_SRC.filter((f) => f !== "i18n.js").map((f) => `lib/client-src/${f}`);
  const src = srcFiles.map((f) => countCjk(f));
  const drill = countCjk("lib/redteam/client.js");
  const srcTotal = src.reduce((n, r) => n + r.hits, 0);
  const srcMatches = src.reduce((n, r) => n + r.matchTotal, 0);
  return {
    drill: { hits: drill.hits, matchTotal: drill.matchTotal, lines: drill.lineNos },
    clientSrc: {
      total: srcTotal,
      matchTotal: srcMatches,
      rows: src.filter((r) => r.hits > 0),
    },
    combined: drill.hits + srcTotal,
    combinedMatches: drill.matchTotal + srcMatches,
  };
}

// ── 5) i18n 词典键 ────────────────────────────────────────────────────────────
/**
 * 口径：在 lib/client-src/i18n.js 里定位 `const zh = {` / `const en = {` 的块，
 * 按花括号深度取顶层键名（深度 1 上的 `key:`）。不做求值，避免把片段当模块 import。
 */
function measureI18n() {
  const text = read("lib/client-src/i18n.js");
  /**
   * 取一个字典块的顶层键。
   *
   * 关键点：键名有两种写法 —— 裸标识符（`nav:`）和带引号（`"dock.clean":`）。
   * 只认裸标识符会把 99% 的键漏掉（本仓库绝大多数键是带点号的带引号键）。
   */
  const keysOf = (marker) => {
    const start = text.indexOf(marker);
    if (start < 0) return { keys: [], found: false };
    let i = text.indexOf("{", start);
    let depth = 0;
    const keys = [];
    for (; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === "{") { depth += 1; continue; }
      if (ch === "}") {
        depth -= 1;
        if (depth === 0) break;
        continue;
      }
      // 只在顶层（depth === 1）取键
      if (depth !== 1) {
        // 跳过嵌套字符串，避免把值里的花括号当结构
        if (ch === '"' || ch === "'" || ch === "`") {
          const quote = ch;
          for (i += 1; i < text.length; i += 1) {
            if (text[i] === "\\") { i += 1; continue; }
            if (text[i] === quote) break;
          }
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        const quote = ch;
        let buf = "";
        let j = i + 1;
        for (; j < text.length; j += 1) {
          if (text[j] === "\\") { buf += text[j + 1] ?? ""; j += 1; continue; }
          if (text[j] === quote) break;
          buf += text[j];
        }
        // 引号后面必须是冒号才算键（否则是值）
        let k = j + 1;
        while (k < text.length && /\s/.test(text[k])) k += 1;
        if (text[k] === ":") keys.push(buf);
        i = j;
        continue;
      }
      const m = /^[A-Za-z0-9_$]+(?=\s*:)/.exec(text.slice(i));
      if (m) {
        keys.push(m[0]);
        i += m[0].length - 1;
      }
    }
    return { keys, found: true };
  };
  const zh = keysOf("const zh = {");
  const en = keysOf("const en = {");
  const zhKeys = zh.keys;
  const enKeys = en.keys;
  return {
    zhFound: zh.found,
    enFound: en.found,
    zh: zhKeys.length,
    en: enKeys.length,
    union: new Set([...zhKeys, ...enKeys]).size,
    onlyZh: zhKeys.filter((k) => !enKeys.includes(k)),
    onlyEn: enKeys.filter((k) => !zhKeys.includes(k)),
  };
}

// ── 6) CSS ───────────────────────────────────────────────────────────────────
/**
 * 口径：
 *   两段 CSS = lib/client-src/dock/purge-css.js 内全部字符串字面量拼接后的正文
 *   （该文件按 data-theme 分叉，实为「白 / dusk」两套规则文本）。
 *   规则块数 = 选择器后紧跟 `{` 的次数（含 @media 内的嵌套块，因为嵌套块本身也是规则）。
 *   颜色数 = 六种形态字面量去重后的集合大小。
 */
function measureCss() {
  /**
   * 三段手写 CSS 的实测口径：
   *   A = lib/client-src/dock/purge-css.js 里长度 > 500 且含 `{` 与 `:` 的字符串（PURGE_CSS）
   *   B = lib/client-src/rewind/rewind-ui.js 同一条规则（REWIND_CSS，声明在该文件里）
   *   C = lib/redteam/client.js 里 `const CSS = ` 后面那个模板字符串（演练台样式）
   * C 必须锚定到声明处再取模板：整文件扫引号会把 JS 代码里被撇号带偏的区间当成样式段，
   * 数出并不存在的规则块。
   * A 与 B 都落在 lib/client-src 下的独立样式文件，各扫各的；漏掉 B 会整体少算
   * REWIND_CSS 的规则块与颜色。
   */
  const segments = [];
  const pushSeg = (rel, startLine, endLine, buf) => {
    segments.push({ file: rel, startLine, endLine, bytes: bytesOf(buf), text: buf });
  };

  const sheetFiles = ["lib/client-src/dock/purge-css.js", "lib/client-src/rewind/rewind-ui.js"];
  for (const cssFile of sheetFiles) {
    const cssText = read(cssFile);
    for (let i = 0; i < cssText.length; i += 1) {
      const ch = cssText[i];
      if (ch !== '"' && ch !== "'" && ch !== "`") continue;
      const quote = ch;
      const startLine = cssText.slice(0, i).split("\n").length;
      let buf = "";
      let j = i + 1;
      let closed = false;
      for (; j < cssText.length; j += 1) {
        if (cssText[j] === "\\") { buf += cssText[j + 1] ?? ""; j += 1; continue; }
        if (cssText[j] === quote) { closed = true; break; }
        buf += cssText[j];
      }
      i = j;
      if (!closed) continue;
      if (buf.length > 500 && buf.includes("{") && buf.includes(":")) {
        pushSeg(cssFile, startLine, cssText.slice(0, i).split("\n").length, buf);
      }
    }
  }

  const drillFile = "lib/redteam/client.js";
  const drillText = read(drillFile);
  const anchor = drillText.search(/const\s+CSS\s*=\s*`/);
  if (anchor >= 0) {
    const open = drillText.indexOf("`", anchor);
    const startLine = drillText.slice(0, open).split("\n").length;
    let buf = "";
    let j = open + 1;
    let closed = false;
    for (; j < drillText.length; j += 1) {
      if (drillText[j] === "\\") { buf += drillText[j + 1] ?? ""; j += 1; continue; }
      if (drillText[j] === "`") { closed = true; break; }
      buf += drillText[j];
    }
    if (closed) pushSeg(drillFile, startLine, drillText.slice(0, j).split("\n").length, buf);
  }

  const css = segments.map((s) => s.text).join("\n");
  const blockCount = (css.match(/\{/g) ?? []).length;
  let depth = 0;
  let blockCountTopLevel = 0;
  let inComment = false;
  for (let i = 0; i < css.length; i += 1) {
    const c = css[i];
    const n = css[i + 1];
    if (inComment) {
      if (c === "*" && n === "/") { inComment = false; i += 1; }
      continue;
    }
    if (c === "/" && n === "*") { inComment = true; i += 1; continue; }
    if (c === "{") { if (depth === 0) blockCountTopLevel += 1; depth += 1; continue; }
    if (c === "}") depth = Math.max(0, depth - 1);
  }
  const colors = css.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g) ?? [];
  const uniq = [...new Set(colors.map((c) => c.toLowerCase()))];
  const themeMarkers = [];
  for (const rel of ["lib/client-src/dock/purge-css.js", "lib/redteam/client.js"]) {
    read(rel).split("\n").forEach((line, i) => {
      if (/data-theme|data-ds-dark-theme|prefers-color-scheme|color-scheme/.test(line)) {
        themeMarkers.push({ at: `${rel}:${i + 1}`, text: line.trim().slice(0, 80) });
      }
    });
  }
  const cssVar = (css.match(/var\(--/g) ?? []).length;
  return {
    segments: segments.map(({ file, startLine, endLine, bytes }) => ({ file, startLine, endLine, bytes })),
    cssBytes: bytesOf(css),
    blockCount,
    blockCountTopLevel,
    colorTotal: colors.length,
    colorUnique: uniq.length,
    topColors: uniq.slice(0, 24),
    themeMarkers,
    cssVarUses: cssVar,
  };
}

// ── 7) 宿主 DOM 猜测面 ───────────────────────────────────────────────────────
function measureDomGuessing() {
  const files = ["lib/redteam/client.js", ...CLIENT_SRC.map((f) => `lib/client-src/${f}`)];
  const rows = [];
  for (const f of files) {
    const lines = read(f).split("\n");
    let fn = "";
    lines.forEach((line, i) => {
      const fnm = /^\s*(?:async\s+)?function\s+([A-Za-z0-9_$]+)/.exec(line);
      if (fnm) fn = fnm[1];
      if (/\bcreatePortal\b/.test(line)) rows.push({ at: `${f}:${i + 1}`, kind: "createPortal", fn });
      if (/\bMutationObserver\b/.test(line)) rows.push({ at: `${f}:${i + 1}`, kind: "MutationObserver", fn });
      if (/\bsetInterval\s*\(/.test(line)) rows.push({ at: `${f}:${i + 1}`, kind: "setInterval", fn });
    });
  }
  // setTimeout 自递归：同一函数名内既有 setTimeout 又有对该函数的调用/赋值
  const selfRecursive = [];
  for (const f of files) {
    const lines = read(f).split("\n");
    let fn = "";
    const bodies = new Map();
    lines.forEach((line, i) => {
      const fnm = /^\s*(?:async\s+)?function\s+([A-Za-z0-9_$]+)/.exec(line);
      if (fnm) fn = fnm[1];
      if (!bodies.has(fn)) bodies.set(fn, []);
      bodies.get(fn).push({ line: i + 1, text: line });
    });
    for (const [name, body] of bodies) {
      if (!name) continue;
      const hasTimeout = body.some((l) => /setTimeout\s*\(/.test(l.text));
      const callsSelf = body.some((l) => new RegExp(`\\b${name}\\s*\\(`).test(l.text));
      if (hasTimeout && callsSelf) {
        const at = body.find((l) => /setTimeout\s*\(/.test(l.text));
        selfRecursive.push({ at: `${f}:${at.line}`, kind: "setTimeout(self-recursive)", fn: name });
      }
    }
  }
  const all = [...rows, ...selfRecursive];
  const count = (k) => all.filter((r) => r.kind === k).length;
  return {
    rows: all,
    counts: {
      createPortal: count("createPortal"),
      mutationObserver: count("MutationObserver"),
      setInterval: count("setInterval"),
      setTimeoutSelfRecursive: count("setTimeout(self-recursive)"),
    },
    timerGroups: count("setInterval") + count("setTimeout(self-recursive)"),
  };
}

// ── 8) 座位注册（仓库侧） ───────────────────────────────────────────────────
function measureSlots() {
  const files = ["lib/redteam/client.js", ...CLIENT_SRC.map((f) => `lib/client-src/${f}`)];
  const rows = [];
  for (const f of files) {
    read(f).split("\n").forEach((line, i) => {
      const m = /slots\.(register|inject)\(\s*["']([^"']+)["']/.exec(line);
      if (m) rows.push({ at: `${f}:${i + 1}`, call: m[1], slot: m[2] });
      const n = /name:\s*["']([a-z][a-z0-9.-]*)["']/.exec(line);
      if (n && /slots|register/.test(line)) rows.push({ at: `${f}:${i + 1}`, call: "name-literal", slot: n[1] });
    });
  }
  return { rows, distinct: [...new Set(rows.map((r) => r.slot))] };
}

// ── 9) 源 → 产物剥离探针 ────────────────────────────────────────────────────
/**
 * 口径：同一个探针字符串在「源码」与「产物」里的出现次数。
 * 源码 = lib/redteam/client.js（演练台片段）+ lib/client-src/**；
 * 产物 = client.js。出现次数不等就说明该段被 build 剥离或改写。
 */
function measureStrip() {
  const probes = [
    "sidebar.footer.action",
    "conversation.session.header.utilities",
    "conversation.input.right",
    "shell.overlay",
    "applyDrillParts",
    "exports.apply",
    "exports.inject",
    "function apply(ctx)",
    "__DSH_PURGE_DRILL_BEGIN__",
    "AUTH_LEGAL_HTML",
    "data-theme",
    "__DSHP_SLOT:",
  ];
  const client = read("client.js");
  const drill = read("lib/redteam/client.js");
  const srcAll = [...CLIENT_SRC.map((f) => read(join("lib", "client-src", f))), drill].join("\n");
  const count = (hay, needle) => hay.split(needle).length - 1;
  return probes.map((p) => ({
    probe: p,
    inArtifact: count(client, p),
    inSource: count(srcAll, p),
    inDrillSource: count(drill, p),
    stripped: count(srcAll, p) - count(client, p),
  }));
}

// ── 10) 视图键（机械初稿） ──────────────────────────────────────────────────
/**
 * 口径：从三处取「视图键」的机械证据，宁可多列不可漏列 ——
 *   a) 演练台页签数组（TABS / TABS = [...]）
 *   b) 设置页 section 定义（sections 数组里的 id/title 对）
 *   c) 清洗浮层页签（dock 的 tab 键）
 * 这份初稿只给「文件:行号 + 字面量」，可达性要靠人工确认。
 */
function measureViews() {
  const out = [];
  const scan = (rel, re, kind) => {
    read(rel).split("\n").forEach((line, i) => {
      const m = re.exec(line);
      if (m) out.push({ at: `${rel}:${i + 1}`, kind, literal: m[0].trim().slice(0, 120) });
    });
  };
  scan("lib/redteam/client.js", /\{\s*id:\s*'[a-z][a-zA-Z0-9_-]*'\s*,\s*(?:label|title)\s*:/, "tab-object");
  scan("lib/redteam/client.js", /const (?:TABS|TAB_LIST|SECTIONS)\s*=/, "tab-array-decl");
  scan("lib/client-src/settings/config-tab.js", /^\s*(?:const\s+)?[A-Z_]+_SECTION\b|id:\s*"[a-z][a-z0-9.-]*"\s*,\s*title/, "settings-section");
  // 浮层已删（视图键的来源之一随之消失）：文件不在就记 0 行，这不是「量法变了」，
  // 而是被量的对象没了 —— 留着会崩，跳过会让「浮层页签」这个口径永远报空。
  if (existsSync(join(root, "lib/client-src/dock/purge-dock.js"))) {
    scan("lib/client-src/dock/purge-dock.js", /tab\s*[=:]\s*["'][a-z]+["']|TAB[A-Z_]*\s*=/, "dock-tab");
  }
  scan("lib/client-src/settings/config-tab.js", /SECTION_ORDER|SECTIONS\s*=\s*\[/, "section-order");
  return { rows: out };
}

const result = {
  generatedAt: new Date().toISOString(),
  files: measureFiles(),
  patches: await measurePatches(),
  http: measureHttp(),
  ops: measureOps(),
  cjk: measureCjk(),
  i18n: measureI18n(),
  css: measureCss(),
  dom: measureDomGuessing(),
  slots: measureSlots(),
  strip: measureStrip(),
  views: measureViews(),
};

writeFileSync(join(outDir, "measure.json"), JSON.stringify(result, null, 2), "utf8");
writeFileSync(join(outDir, "patches.json"), JSON.stringify({
  total: result.patches.total,
  byLayer: result.patches.byLayer,
  arrays: result.patches.arrays,
  display: result.patches.display,
  rows: result.patches.rows,
}, null, 2), "utf8");

const brief = {
  clientBytes: result.files.artifactClient.bytes,
  clientLines: result.files.artifactClient.lines,
  drillLines: result.files.drillFragment.lines,
  clientSrcFiles: result.files.clientSrc.files,
  clientSrcLines: result.files.clientSrc.lines,
  patchTotal: result.patches.total,
  patchByLayer: result.patches.byLayer,
  patchDisplayRows: result.patches.display.rows,
  httpExact: result.http.exactCount,
  httpPrefix: result.http.prefixCount,
  opCount: result.ops.count,
  cjkDrill: result.cjk.drill.hits,
  cjkClientSrc: result.cjk.clientSrc.total,
  cjkCombined: result.cjk.combined,
  cjkDrillMatches: result.cjk.drill.matchTotal,
  cjkClientSrcMatches: result.cjk.clientSrc.matchTotal,
  cjkCombinedMatches: result.cjk.combinedMatches,
  i18n: result.i18n,
  cssBlocks: result.css.blockCount,
  cssBlocksTopLevel: result.css.blockCountTopLevel,
  cssColors: result.css.colorUnique,
  dom: result.dom.counts,
  timerGroups: result.dom.timerGroups,
  slots: result.slots.distinct,
};
console.log(JSON.stringify(brief, null, 2));
