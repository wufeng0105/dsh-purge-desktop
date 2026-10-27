/**
 * scripts/probe-host-patches.mjs — 装机树上的补丁命中只能靠真实探针看，静态图看不见。
 * F7：真实宿主补丁命中诊断（**只读**）。
 *
 * 目的：闭合「最大已知缺口：补丁 pattern 是否真能在真实宿主文件里命中，
 * 没有端到端验证」。本脚本对本机已装官方宿主（发现逻辑见下）的 82 条 `ALL_PATCHES`
 * 逐条做**只读**判定，输出分布表 + 「本该命中却 miss」的清单。
 *
 * ## 为什么存在
 *
 * 单测用的是固定假宿主文本。「这些 pattern 在真实宿主上到底命中没有」这个
 * 缺口只能靠它补 —— 没有这个脚本，那个缺口只能靠嘴说。
 *
 * ## 只读保证（调用前已逐条读过实现）
 *
 *   lib/core.js `patchStatus()`                      → targetFiles → 读文件 → contentOutcomeOf
 *   lib/core.js `contentOutcomeOf()`                 → 纯函数（文件文本 + 补丁条目 + 账本）
 *   lib/core.js:1651 `onMissOf()`                    → 纯函数
 *   lib/core.js:2890 `patchStatusReady()`            → 纯函数
 *   lib/core.js:200  `checkHostVersionGate()`        → readHostVersion（lib/host-version.js 无任何写调用）
 *   lib/host/targets.js:386 `targetFiles()`          → 只 existsSync / isFile / readdirSync
 *   lib/host/paths.js:865 `enumeratePatchAiBases()`  → 只 existsSync / realpath / readdirSync
 *   lib/hooks-deny.js:138 `annotateHookDenyStatus()` → patchStatus 内调用，settings 为空即立刻 return，
 *                                                      即使进入分支也只走 io.loadText
 *
 * 本脚本**不** import 也不调用 `applyPatches` / `applyPatchesAllHosts` / `backupAll` /
 * `revertAll` / `revertAllHosts` / `patchShim` / `patchAllShims` / 任何 `write*` / `save*`。
 * 唯一写动作是最后 `writeFileSync(out)`，落点默认在 `.tmp-repair/f7-probe.json`，
 * 且 `out` 被强制限制在仓库内。
 *
 * ## 用法
 *
 *   DSH_SURFACE=desktop node scripts/probe-host-patches.mjs
 *
 * `DSH_SURFACE=desktop` 是必须的：宿主探测（`lib/surface.js:142` detectSurface）在
 * 非 Electron 进程里 fail-fast 抛错，而补丁适用面判定 `patchAppliesHere` 需要它。
 * 脚本自己在 import 之前设好这个变量，不需要调用方传。
 *
 * 可选 `DSH_BASE=<插件根>`：显式指定 aiBase（默认走仓库自己的 enumeratePatchAiBases）。
 * 可选 `PROBE_OUT=<路径>`：覆盖落盘 JSON。**路径必须落在仓库内**，否则直接退出。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 必须在任何 lib/ 模块被求值之前设好：lib/surface.js 在 import 期就会读 process.env。
if (!String(process.env.DSH_SURFACE || "").trim()) {
  process.env.DSH_SURFACE = "desktop";
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

const core = await import("../lib/core.js");
const paths = await import("../lib/host/paths.js");
const constants = await import("../lib/patch/constants.js");
const targetSpec = await import("../lib/host/targets.js");

const {
  ALL_PATCHES,
  patchStatus,
  patchStatusReady,
  contentOutcomeOf,
  onMissOf,
  applyReplacementsToText,
  checkHostVersionGate,
  isPatchResultSoftOk,
  patchAppliesHere,
  findAiBase,
  findDshHome,
  enumeratePatchAiBases,
  targetFiles,
} = core;

// ────────────────────────────── 小工具 ──────────────────────────────

const out = [];
const log = (line = "") => {
  const s = String(line);
  out.push(s);
  process.stdout.write(`${s}\n`);
};

function normalizeInline(s) {
  return String(s).replace(/\s+/g, " ").trim();
}

/** 大文件（asar 到 180 MB）用流式哈希，别一次性读进内存。 */
async function sha256Of(fp) {
  const { createHash } = await import("node:crypto");
  const h = createHash("sha256");
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(fp);
    rs.on("data", (c) => h.update(c));
    rs.on("end", resolve);
    rs.on("error", reject);
  });
  return h.digest("hex");
}

function mtimeKey(fp) {
  try {
    const st = fs.statSync(fp);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "missing";
  }
}

function keysOf(p) {
  return Array.isArray(p.file) ? p.file : [p.file];
}

/** `file` 字段可能开数组、key 可能不在 targetFiles 里 —— 抽出人可读的形态。 */
function fileLabel(p) {
  const k = keysOf(p);
  return k.length === 1 ? String(k[0]) : `[${k.join(", ")}]`;
}

function pct(n, d) {
  if (!d) return "0.0%";
  return `${((n / d) * 100).toFixed(1)}%`;
}

function pad(s, w) {
  const v = String(s);
  // 中文字符按 2 列算，表格才对得齐。
  let width = 0;
  for (const ch of v) width += ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
  return v + " ".repeat(Math.max(0, w - width));
}

function table(headers, rows) {
  const all = [headers, ...rows];
  const widths = headers.map((_, i) => Math.max(...all.map((r) => {
    let w = 0;
    for (const ch of String(r[i] ?? "")) w += ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
    return w;
  })));
  const line = (cells) => `| ${cells.map((c, i) => pad(c ?? "", widths[i])).join(" | ")} |`;
  log(line(headers));
  log(`| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`);
  for (const r of rows) log(line(r));
}

// ────────────────────────────── 1. 宿主发现 ──────────────────────────────

log("# F7 真实宿主补丁命中诊断（只读）");
log();
log(`生成时间(本机): ${new Date().toString()}`);
log(`Node: ${process.version} / platform=${process.platform} / cwd=${process.cwd()}`);
log(`DSH_SURFACE=${process.env.DSH_SURFACE}（脚本自设，非宿主残留）`);
log();

log("## 1 宿主发现（复用仓库自己的探测链）");
log();

const envAiBase = String(process.env.DSH_BASE || "").trim();
const enumerated = enumeratePatchAiBases();
const aiBase = envAiBase ? path.normalize(envAiBase) : (findAiBase() || enumerated[0] || null);

log("```");
log(`enumeratePatchAiBases() -> ${JSON.stringify(enumerated, null, 2)}`);
log(`findAiBase()            -> ${findAiBase() ?? "null"}`);
log(`findDshHome()           -> ${findDshHome() ?? "null"}`);
log(`DSH_BASE(env)           -> ${envAiBase || "(未设)"}`);
log(`采用的 aiBase           -> ${aiBase ?? "null"}`);
log("```");
log();

if (!aiBase) {
  log("**结论：本机没找到可用宿主插件根，无法做命中诊断。**");
  log();
  log("可复现判据：");
  log("```powershell");
  log('$env:DSH_SURFACE="desktop"; node -e "import(\'./lib/host/paths.js\').then(p=>console.log(p.enumeratePatchAiBases()))"');
  log("```");
  process.exit(0);
}

const isAiBase = paths.isAiBase(aiBase);
log(`isAiBase(aiBase) = ${isAiBase}（判据：<root>/dsh-agent-instructions/lib 是目录，lib/host/paths.js:188）`);
if (!isAiBase) {
  log("**这个路径不是仓库认可的插件根（isAiBase=false），诊断结果仅供参考。**");
}
log();

const gate = checkHostVersionGate(aiBase);
log("版本门禁（checkHostVersionGate，只读）：");
log("```json");
log(JSON.stringify(gate, null, 2));
log("```");
log();

// 具体是哪一份安装：把路径拆开写出来，别只给一个长串。
{
  const parts = aiBase.split(/[\\/]/);
  const iResources = parts.findIndex((s) => s.toLowerCase() === "resources");
  if (iResources >= 0) {
    log(`安装树推断：【实测】aiBase = \`${aiBase}\``);
    log(`→ install = \`${parts.slice(0, iResources).join("\\")}\``);
    log(`→ resources = \`${parts.slice(iResources, iResources + 2).join("\\")}\``);
    log(`→ 变体 = \`${parts[iResources + 1]}\`（app = asar 已解开的目录树；app.asar.unpacked = 只放原生的补丁目录）`);
    log();
  }
}

// ────────────────────────────── 2. 目标文件清单 ──────────────────────────────

log("## 2 目标文件清单（targetFiles 解析结果）");
log();

const files = targetFiles(aiBase);
const keysUsed = new Set();
for (const p of ALL_PATCHES) for (const k of keysOf(p)) keysUsed.add(k);

const keyToPatches = new Map();
for (const p of ALL_PATCHES) {
  for (const k of keysOf(p)) {
    if (!keyToPatches.has(k)) keyToPatches.set(k, []);
    keyToPatches.get(k).push(p.id);
  }
}

const unresolvedKeys = [...keysUsed].filter((k) => !(k in files) || files[k] === "" || (Array.isArray(files[k]) && files[k].length === 0));
const resolvedKeys = [...keysUsed].filter((k) => !unresolvedKeys.includes(k));

log(`补丁表引用到的 key 共 ${keysUsed.size} 个：解析成功 ${resolvedKeys.length} 个，落空 ${unresolvedKeys.length} 个。`);
log();

if (unresolvedKeys.length) {
  log("落空的 key（这些 key 的全部候选路径在本机都不存在）：");
  log();
  table(
    ["key", "引用它的补丁 id", "这些补丁的 onMiss", "是否 strictFiles"],
    unresolvedKeys.map((k) => {
      const ids = keyToPatches.get(k) || [];
      const ps = ids.map((id) => ALL_PATCHES.find((x) => x.id === id));
      const missSet = [...new Set(ps.map((p) => onMissOf(p)))].join("/");
      const strict = ps.some((p) => p.strictFiles) ? "**是**" : "否";
      return [`\`${k}\``, ids.join(","), missSet, strict];
    }),
  );
  log();
}

log("解析成功的 key → 文件：");
log();
table(
  ["key", "命中文件数", "路径"],
  resolvedKeys.map((k) => {
    const v = files[k];
    const list = Array.isArray(v) ? v : [v];
    const shown = list.length === 1 ? `\`${list[0]}\`` : list.map((x) => `\`${x}\``).join("<br>");
    return [`\`${k}\``, String(list.filter(Boolean).length), shown];
  }),
);
log();

const allTargetPaths = [];
for (const v of Object.values(files)) {
  for (const fp of Array.isArray(v) ? v : [v]) {
    if (fp && typeof fp === "string" && !allTargetPaths.includes(fp)) allTargetPaths.push(fp);
  }
}
log(`去重后实际要读的目标文件：${allTargetPaths.length} 个。`);
log();

// ────────────────────────────── 3. 只读前后指纹 ──────────────────────────────

const hostSide = [
  path.join(path.dirname(path.dirname(path.dirname(aiBase))), "dsh", "package.json"),
  path.join(path.dirname(path.dirname(path.dirname(aiBase))), "dsh", "desktop-runtime.json"),
  path.join(path.dirname(path.dirname(path.dirname(path.dirname(aiBase)))), "app.asar"),
  path.join(path.dirname(path.dirname(path.dirname(path.dirname(aiBase)))), "app", "package.json"),
].filter((fp) => fs.existsSync(fp));

async function snapshot() {
  const snap = {};
  for (const fp of [...allTargetPaths, ...hostSide]) {
    try {
      if (!fs.statSync(fp).isFile()) {
        snap[fp] = "dir";
        continue;
      }
      snap[fp] = await sha256Of(fp);
    } catch {
      snap[fp] = "unreadable";
    }
  }
  return snap;
}

// ────────────────────────────── 4. 引擎判定 ──────────────────────────────

log("## 3 引擎判定（patchStatus + 逐文件 contentOutcomeOf）");
log();

const before = await snapshot();
const mdTimesBefore = Object.fromEntries([...allTargetPaths, ...hostSide].map((fp) => [fp, mtimeKey(fp)]));

/** 文本缓存：每个文件只读一次，避免 82 条补丁各读一遍。 */
const textCache = new Map();
function textOf(fp) {
  if (textCache.has(fp)) return textCache.get(fp);
  let t;
  try {
    t = fs.readFileSync(fp, "utf8");
  } catch {
    t = null;
  }
  textCache.set(fp, t);
  return t;
}

const status = await patchStatus(aiBase);

// 自己按 patchStatus 的同一套规则重算一份更细的（逐 key、逐文件），用来定位 miss 落在哪个文件。
const details = [];
for (const p of ALL_PATCHES) {
  const applies = (() => {
    try {
      return patchAppliesHere(p);
    } catch (e) {
      return `THROW:${e?.code || e?.message}`;
    }
  })();
  const keys = keysOf(p);
  const perKey = [];
  let applied = 0;
  let pending = 0;
  let skipped = 0;
  let unmatched = 0;
  let missing = 0;
  for (const k of keys) {
    const raw = files[k];
    const list = raw == null || raw === "" ? [] : (Array.isArray(raw) ? raw : [raw]);
    const existing = list.filter((fp) => fp && fs.existsSync(fp));
    const entry = { key: k, candidates: list, existing: [], outcomes: [] };
    if (existing.length === 0) {
      missing += 1;
      entry.note = "key 落空（候选路径一个都不在）";
    }
    for (const fp of existing) {
      const text = textOf(fp);
      if (text == null) {
        pending += 1;
        entry.outcomes.push({ fp, outcome: "unreadable" });
        continue;
      }
      const o = contentOutcomeOf(text, p, fp);
      entry.outcomes.push({ fp, outcome: o });
      if (o === "applied") applied += 1;
      else if (o === "pending") pending += 1;
      else if (p.strictFiles) unmatched += 1;
      else skipped += 1;
    }
    perKey.push(entry);
  }
  let computed;
  if (pending > 0) computed = "pending";
  else if (applied > 0) computed = "applied";
  else if (unmatched > 0) computed = "unmatched";
  else if (skipped > 0) computed = "skipped";
  else computed = onMissOf(p) === "fail" ? "missing_file" : "na";
  const engine = applies === true ? status[p.id] : "na";
  details.push({
    id: p.id,
    name: p.name,
    layer: p.layer,
    file: p.file,
    onMiss: onMissOf(p),
    strictFiles: Boolean(p.strictFiles),
    appliesHere: applies,
    engineStatus: engine,
    recomputed: computed,
    agree: engine === computed || (typeof applies === "string" && computed === "na"),
    tally: { applied, pending, skipped, unmatched, missing },
    perKey,
  });
}

const dist = {};
for (const d of details) dist[d.engineStatus] = (dist[d.engineStatus] || 0) + 1;

log("### 3.1 82 条补丁的 state 分布（引擎 `patchStatus()` 实际返回值）");
log();
table(
  ["state", "条数", "占比", "含义"],
  Object.entries(dist).sort((a, b) => b[1] - a[1]).map(([k, v]) => [
    k,
    String(v),
    pct(v, ALL_PATCHES.length),
    {
      applied: "标记/替换已在宿主文件里（已经洗过）",
      pending: "还有 pattern 残留，点应用就能改",
      skipped: "pattern 对不上且非 strictFiles（原文不在此版本）",
      unmatched: "pattern 对不上且 strictFiles=true → 钉死为失败",
      missing_file: "这条补丁的全部目标文件在本机不存在",
      na: "宿主面不适用 / onMiss!=fail 且文件全缺",
      off: "被设置关掉",
    }[k] || "",
  ]),
);
log();
log(`合计 ${Object.values(dist).reduce((a, b) => a + b, 0)} / ${ALL_PATCHES.length} 条。`);
const disagree = details.filter((d) => !d.agree);
if (disagree.length) {
  log();
  log(`**注意**：${disagree.length} 条我重算的 state 与引擎返回值不一致（会在第 6 节列出）。`);
}
log();

const readyCount = ALL_PATCHES.filter((p) => patchStatusReady(status[p.id], p)).length;
log(`\`patchStatusReady()\` 判定为「就绪」的：${readyCount} / ${ALL_PATCHES.length}。`);
log();

// ────────────────────────────── 5. onMiss 分组 ──────────────────────────────

log("### 3.2 按 onMiss 分组 × state");
log();

const onMissGroups = {};
for (const d of details) {
  const g = (onMissGroups[d.onMiss] ??= { total: 0, strict: 0, states: {}, ids: [] });
  g.total += 1;
  if (d.strictFiles) g.strict += 1;
  g.states[d.engineStatus] = (g.states[d.engineStatus] || 0) + 1;
  g.ids.push(d.id);
}

table(
  ["onMiss", "总数", "其中 strictFiles", "applied", "pending", "skipped", "unmatched", "missing_file", "na"],
  ["fail", "warn", "ignore"].filter((k) => onMissGroups[k]).map((k) => {
    const g = onMissGroups[k];
    return [
      k,
      String(g.total),
      String(g.strict),
      String(g.states.applied || 0),
      String(g.states.pending || 0),
      String(g.states.skipped || 0),
      String(g.states.unmatched || 0),
      String(g.states.missing_file || 0),
      String(g.states.na || 0),
    ];
  }),
);
log();

for (const k of ["fail", "warn", "ignore"]) {
  const g = onMissGroups[k];
  if (!g) continue;
  log(`- \`onMiss:"${k}"\` → id ${g.ids.join(", ")}`);
}
log();

// ────────────────────────────── 6. 可疑清单 ──────────────────────────────

log("## 4 可疑清单（本该命中却 miss）");
log();

const strictMiss = details.filter((d) => d.strictFiles && d.engineStatus !== "applied" && d.engineStatus !== "pending");
log("### 4.1 **最高优先级**：strictFiles 必中条目却 miss");
log();
if (!strictMiss.length) {
  log("**无。** 17 条 strictFiles 里没有任何一条落在 skipped / unmatched / missing_file / na。");
} else {
  table(
    ["id", "name", "state", "onMiss", "file", "落空/对不上的文件"],
    strictMiss.map((d) => {
      const bad = d.perKey.flatMap((k) => k.outcomes.filter((o) => o.outcome !== "applied")
        .map((o) => `\`${o.fp}\` → ${o.outcome}`)
        .concat(k.note ? [`key \`${k.key}\`：${k.note}`] : []));
      return [String(d.id), d.name, `**${d.engineStatus}**`, d.onMiss, fileLabel({ file: d.file }), bad.join("<br>") || "-"];
    }),
  );
}
log();

log("`strictFiles` 全量核对（17 条逐条给 state，便于外部复核）：");
log();
const strictAll = details.filter((d) => d.strictFiles);
table(
  ["id", "name", "state", "onMiss", "file"],
  strictAll.map((d) => [String(d.id), d.name, d.engineStatus, d.onMiss, fileLabel({ file: d.file })]),
);
log();

const failMiss = details.filter((d) => !d.strictFiles && d.onMiss === "fail"
  && d.engineStatus !== "applied" && d.engineStatus !== "pending");
log("### 4.2 onMiss=fail 但 pattern 对不上（非 strictFiles）");
log();
if (!failMiss.length) {
  log("**无。**");
} else {
  table(
    ["id", "name", "state", "file", "明细"],
    failMiss.map((d) => {
      const bad = d.perKey.flatMap((k) => k.outcomes.filter((o) => o.outcome !== "applied")
        .map((o) => `\`${o.fp}\` → ${o.outcome}`)
        .concat(k.note ? [`key \`${k.key}\`：${k.note}`] : []));
      return [String(d.id), d.name, `**${d.engineStatus}**`, fileLabel({ file: d.file }), bad.join("<br>") || "-"];
    }),
  );
}
log();

const skipSoft = details.filter((d) => d.engineStatus === "skipped" || d.engineStatus === "na");
log("### 4.3 skipped / na 全量（含真可选，逐条给判据）");
log();
table(
  ["id", "name", "state", "onMiss", "strictFiles", "file", "为什么"],
  skipSoft.map((d) => {
    const why = [];
    if (d.appliesHere !== true) why.push(`宿主面不适用（patchAppliesHere → ${d.appliesHere}）`);
    for (const k of d.perKey) {
      if (k.note) why.push(`key \`${k.key}\` 落空`);
      for (const o of k.outcomes) if (o.outcome !== "applied") why.push(`\`${o.fp}\` → ${o.outcome}`);
    }
    return [
      String(d.id), d.name, d.engineStatus, d.onMiss,
      d.strictFiles ? "**是**" : "否", fileLabel({ file: d.file }),
      why.join("<br>") || "-",
    ];
  }),
);
log();

// ────────────────────────────── 7. 目标文件不存在 ──────────────────────────────

log("### 4.4 目标文件在本机不存在的条目");
log();
if (!unresolvedKeys.length) {
  log("**无。** 82 条补丁引用的 key 全部在本机解析到了文件。");
} else {
  table(
    ["key", "补丁 id", "onMiss", "strictFiles", "后果"],
    unresolvedKeys.map((k) => {
      const ids = keyToPatches.get(k) || [];
      const ps = ids.map((id) => ALL_PATCHES.find((x) => x.id === id));
      const missSet = [...new Set(ps.map((p) => onMissOf(p)))].join("/");
      const strict = ps.some((p) => p.strictFiles) ? "**是**" : "否";
      const conseq = strict === "**是**"
        ? "**必中补丁缺件 → missing_file / unmatched，是实打实的缺口**"
        : (missSet === "fail" ? "判 missing_file（失败）" : `判 na（onMiss=${missSet}，视为这一版不需要）`);
      return [`\`${k}\``, ids.join(","), missSet, strict, conseq];
    }),
  );
}
log();

const missFilePatches = details.filter((d) => d.engineStatus === "missing_file");
log(`state=missing_file 的补丁：${missFilePatches.length ? missFilePatches.map((d) => d.id).join(", ") : "无"}。`);
log();

// ────────────────────────────── 8. 基线夹逼（pattern 真能在真实宿主文本上命中吗） ──────────────────────────────

log("### 4.5 基线夹逼：把已打上的替换反拆回官方原文，再让 pattern 重新命中");
log();
log("本机宿主 **已经被洗过**（上面 72 条 applied 就是证据），所以「pattern 未命中」在已洗文件上");
log("本来就是预期结果 —— 光看状态分不出「pattern 与官方原文不兼容」还是「已经洗过了」。");
log("这里做一次只读夹逼：在内存里把每条补丁的 replace 文本反拆成它自己的 pattern（**只动内存字符串**），");
log("再对该 pattern 做一次 `applyReplacementsToText`，检查能否**逐字节还原**。");
log();

const UNREACHABLE = /\b(?:const|let|var|function|class|import|export|await|return|if|else|for|while|try|catch)\b|=>|require\(|module\.exports/;
const GENERIC_TAGS = /<\/?(?:div|span|p|br|body|html|head|script|style|font|table|tr|td)\b|^\s*[-*_=#]{3,}\s*$/i;

/** 单个 replace 片段反拆是否安全。 */
function reversalSafe(replace, pattern) {
  if (typeof replace !== "string" || typeof pattern !== "string") return false;
  if (!replace) return false;
  if (replace.length < 12) return false;
  if (replace.length > 40000) return false;
  if (!/\s/.test(replace)) return false;
  if (UNREACHABLE.test(replace)) return false;
  if (GENERIC_TAGS.test(replace)) return false;
  return true;
}

function stripInMemory(text, fp, order) {
  let cur = text;
  const touched = [];
  for (const p of order) {
    for (const { pattern, replace } of p.replacements) {
      if (typeof replace !== "string" || !reversalSafe(replace, pattern)) continue;
      const written = fp.toLowerCase().endsWith(".yml") || fp.toLowerCase().endsWith(".yaml")
        ? core.yamlJsCommentsToHash(replace)
        : replace;
      const needle = String(pattern);
      if (!written || written === needle || !cur.includes(written)) continue;
      cur = cur.split(written).join(needle);
      touched.push(p.id);
    }
  }
  return { text: cur, touched };
}

function applyInMemory(text, fp, p) {
  let cur = text;
  const applied = [];
  for (const { pattern, replace } of p.replacements) {
    if (typeof replace !== "string" || !reversalSafe(replace, pattern)) continue;
    const written = fp.toLowerCase().endsWith(".yml") || fp.toLowerCase().endsWith(".yaml")
      ? core.yamlJsCommentsToHash(replace)
      : replace;
    const needle = String(pattern);
    if (!written || written === needle || !cur.includes(needle)) continue;
    cur = cur.split(needle).join(written);
    applied.push(pattern);
  }
  return { text: cur, applied };
}

const roundTripRows = [];
let roundTripOk = 0;
let roundTripFail = 0;
let roundTripSkip = 0;

for (const d of details) {
  if (!d.appliesHere || d.engineStatus !== "applied") continue;
  const p = ALL_PATCHES.find((x) => x.id === d.id);
  const keys = keysOf(p);
  for (const k of keys) {
    const raw = files[k];
    const list = raw == null || raw === "" ? [] : (Array.isArray(raw) ? raw : [raw]);
    for (const fp of list) {
      if (!fp || !fs.existsSync(fp)) continue;
      const text = textOf(fp);
      if (text == null) continue;
      const forwardOrder = ALL_PATCHES.filter((x) => keysOf(x).includes(k));
      const backwardOrder = [...forwardOrder].reverse();
      const stripped = stripInMemory(text, fp, backwardOrder);
      if (!stripped.touched.includes(d.id)) {
        roundTripSkip += 1;
        continue;
      }
      const reapplied = applyInMemory(stripped.text, fp, p);
      const ok = reapplied.text === text && reapplied.applied.length > 0;
      if (ok) roundTripOk += 1;
      else roundTripFail += 1;
      roundTripRows.push({
        id: d.id,
        name: d.name,
        fp,
        ok,
        appliedPatterns: reapplied.applied.length,
        patternCount: p.replacements.length,
        sameAfterStrip: stripped.text === text,
      });
    }
  }
}

log(`夹逼结果：**逐字节还原成功 ${roundTripOk}** 组，还原失败 ${roundTripFail} 组，因 replace 文本不具备可逆特征而跳过 ${roundTripSkip} 组。`);
log();
if (roundTripRows.length && roundTripFail) {
  log("还原失败的组（**这些才是 pattern 与真实宿主文本不兼容的实证**）：");
  log();
  table(
    ["id", "name", "target file", "apply 上了几条 pattern", "pattern 总数"],
    roundTripRows.filter((r) => !r.ok).map((r) => [
      String(r.id), r.name, `\`${r.fp}\``, String(r.appliedPatterns), String(r.patternCount),
    ]),
  );
  log();
}
const rtCaveat = roundTripRows.filter((r) => r.ok).length;
log(`> 口径说明：只对 \`applied\` 且 replace 文本「不像代码、够长、含空白」的条目做夹逼；`);
log(`> 反拆直接命中的 ${rtCaveat} 组里，pattern 在官方口吻的原文形态上**确实能命中**。`);
log();

// ───────── 4.6 真·端到端：拿宿主自带的官方原文备份当基线，复跑一遍 apply ─────────

log("### 4.6 真·端到端：用宿主自带的官方原文备份当基线，复跑一次 apply（**全部在内存里**）");
log();
log(`宿主侧存在仓库自己的备份约定：目标文件旁的 \`<file>.dshpurge.bak\`（lib/core.js:1201 BAK_SUFFIX）`);
log(`以及 \`$DSH_HOME/dsh-purge/host-backups/<sha1>.bak\`（lib/core.js:1208 hostBakVaultRoot）。`);
log(`这些 .bak 是**官方原文**（apply 前写的），所以它们就是判「pattern 到底能不能在真实宿主原文上命中」的黄金基线。`);
log("");

const bakOf = new Map();
for (const fp of allTargetPaths) {
  const cand = `${fp}.dshpurge.bak`;
  if (fs.existsSync(cand)) {
    bakOf.set(fp, { kind: "sidecar", bak: cand });
    continue;
  }
  const vaultDir = path.join(findDshHome(), "dsh-purge", "host-backups");
  if (!fs.existsSync(vaultDir)) continue;
  const want = new Set();
  want.add(path.normalize(fp).replace(/\\/g, "/").toLowerCase());
  try {
    want.add(fs.realpathSync(fp).replace(/\\/g, "/").toLowerCase());
  } catch { /* asar 虚路径或未落盘 */ }
  let hit = null;
  for (const w of want) {
    const { createHash } = await import("node:crypto");
    const d = createHash("sha1").update(w).digest("hex").slice(0, 24);
    const cand2 = path.join(vaultDir, `${d}.bak`);
    if (fs.existsSync(cand2)) { hit = cand2; break; }
  }
  if (hit) bakOf.set(fp, { kind: "vault", bak: hit });
}

const appliedJsonPath = path.join(findDshHome(), "dsh-purge", "applied.json");
let appliedIds = null;
try {
  const parsed = JSON.parse(fs.readFileSync(appliedJsonPath, "utf8"));
  appliedIds = new Set(Array.isArray(parsed) ? parsed : Object.keys(parsed).map(Number));
} catch { /* 没有就不按 id 过滤 */ }
log(`宿主 \`applied.json\`：${appliedIds ? `${appliedIds.size} 个 id` : "读不到（不按 id 过滤）"}`);
log(`找到官方原文备份的目标文件：${bakOf.size} / ${allTargetPaths.length} 个。`);
log();

const e2e = [];
for (const fp of allTargetPaths) {
  const info = bakOf.get(fp);
  if (!info) continue;
  const cur = textOf(fp);
  if (cur == null) continue;
  const orig = fs.readFileSync(info.bak, "utf8");

  // 这个文件被哪些 key 覆盖、这些 key 又挂在哪些补丁上。
  const owningKeys = Object.keys(files).filter((k) => {
    const v = files[k];
    return Array.isArray(v) ? v.includes(fp) : v === fp;
  });
  const involved = ALL_PATCHES.filter((p) => keysOf(p).some((k) => owningKeys.includes(k)));
  const involvedIds = involved.map((p) => p.id);
  // 宿主面不适用的补丁不参与复跑（apply 侧也会被同一门禁挡掉）。
  const inScope = involved.filter((p) => {
    try {
      return patchAppliesHere(p);
    } catch {
      return false;
    }
  });

  // 把**全部**相关补丁按表序叠加到官方原文上（applyPatches 的逐文件等价物）。
  let sim = orig;
  const changedIds = [];
  for (const p of inScope) {
    const r = applyReplacementsToText(sim, p, fp);
    sim = r.text;
    if (r.changed) changedIds.push(p.id);
  }

  const sameAsApplied = sim === cur;
  const backupEqualsCurrent = orig === cur;
  const backupLooksClean = orig.length > 0 && !orig.includes("dsh-purge");
  const curLooksPatched = cur.includes("dsh-purge");
  // 逐条：pattern 在官方原文里到底有没有落脚点。
  const patternHits = [];
  for (const p of inScope) {
    let hit = 0;
    let total = 0;
    for (const { pattern } of p.replacements) {
      if (!pattern) continue;
      total += 1;
      let ok;
      if (typeof pattern === "string") {
        ok = orig.includes(pattern);
      } else {
        // 模块级正则可能带 g —— 每次新建，避免 lastIndex 残留（lib/core.js:1605 同一坑）。
        ok = new RegExp(pattern.source, String(pattern.flags || "").replace("g", "")).test(orig);
      }
      if (ok) hit += 1;
    }
    patternHits.push({ id: p.id, hit, total });
  }

  const noHitIds = patternHits.filter((h) => h.hit === 0).map((h) => h.id);
  const hitIds = patternHits.filter((h) => h.hit > 0).map((h) => h.id);
  let verdict;
  if (backupEqualsCurrent) verdict = "backup-identical-to-current";
  else if (!changedIds.length) verdict = "baseline-patterns-no-hit";
  else if (sameAsApplied) verdict = "baseline-roundtrip-ok";
  else verdict = "baseline-roundtrip-differs";

  e2e.push({
    fp,
    backupKind: info.kind,
    backup: info.bak,
    involvedIds,
    inScopeIds: inScope.map((p) => p.id),
    patternHits,
    hitIds,
    changedIds,
    noHitIds,
    sameAsApplied,
    backupEqualsCurrent,
    backupLooksClean,
    curLooksPatched,
    verdict,
  });
}

const e2eIdentical = e2e.filter((r) => r.verdict === "backup-identical-to-current");
const e2eBaseline = e2e.filter((r) => r.verdict === "baseline-roundtrip-ok");
const e2eBaselineDiff = e2e.filter((r) => r.verdict === "baseline-roundtrip-differs");
const e2eNone = e2e.filter((r) => r.verdict === "baseline-patterns-no-hit");

log("**先说清这批 .bak 到底是什么**（本地实测，别把它当官方原文）：");
log();
log(`- 有 ${e2e.filter((r) => r.backupLooksClean).length} / ${e2e.length} 份 .bak 不含 \`dsh-purge\` 字样（即通过仓库自己的 isOfficialSnapshotBuf 判据）；`);
log(`- 其中 ${e2eIdentical.length} 份 **与当前宿主文件逐字节相同** —— 这些是「打补丁前就一致」的对，不能当基线用；`);
log(`- 当前宿主文件里含 \`dsh-purge\` 字样的有 ${e2e.filter((r) => r.curLooksPatched).length} 份 —— 这就是「本机装的那份宿主已经被洗过」的直接证据。`);
log();
log(`**因此：本机没有可用于「从官方原文复跑 apply」的干净基线。** 下面把两种情形分开报，别混在一起：`);
log();
log(`1. \`backup-identical-to-current\`（${e2eIdentical.length} 组）—— 基线 == 现文件，对补丁命中**没有**鉴别力；`);
log(`2. \`baseline-roundtrip-ok\` / \`baseline-roundtrip-differs\` / \`baseline-patterns-no-hit\`（${e2eBaseline.length} / ${e2eBaselineDiff.length} / ${e2eNone.length} 组）—— 基线 != 现文件，可以看 pattern 在**这份**基线里有没有落脚点。`);
log();

log(`**A. 基线 == 现文件（${e2eIdentical.length} 组，无鉴别力，仅供参考）**：`);
log();
log(e2eIdentical.length
  ? e2eIdentical.map((r) => `- \`${r.fp}\`（id ${r.involvedIds.join(",")}，逐条 pattern 命中 ${r.patternHits.map((h) => `${h.id}:${h.hit}/${h.total}`).join(" ")}）`).join("\n")
  : "- （无）");
log();

log(`**B. 基线 != 现文件：把 pattern 命中它的补丁按表序复跑，是否等于现文件（${e2e.length - e2eIdentical.length} 组）**`);
log();
table(
  ["target file", "结论", "基线 != 现文件", "基线里命中的 id", "基线里 0 命中的 id", "复跑后有改动的 id"],
  e2e.filter((r) => r.verdict !== "backup-identical-to-current").map((r) => [
    `\`${r.fp}\``,
    r.verdict,
    r.backupEqualsCurrent ? "否" : "是",
    r.hitIds.join(",") || "-",
    r.noHitIds.join(",") || "-",
    r.changedIds.join(",") || "-",
  ]),
);
log();

if (e2eNone.length) {
  log("`baseline-patterns-no-hit` 明细（官方原文里**一个 pattern 都没命中** → 最需要解释的一组）：");
  log();
  table(
    ["target file", "involved ids", "按 id 的 pattern 命中（命中数/总数）", "基线来源", "基线==现文件"],
    e2eNone.map((r) => [
      `\`${r.fp}\``,
      r.involvedIds.join(","),
      r.patternHits.map((h) => `${h.id}:${h.hit}/${h.total}`).join("<br>") || "-",
      r.backupKind,
      r.backupEqualsCurrent ? "是" : "否",
    ]),
  );
  log();
}

if (e2eBaselineDiff.length) {
  log("`baseline-roundtrip-differs` 明细：");
  log();
  table(
    ["target file", "involved ids", "基线里命中的 id", "复跑后有改动的 id"],
    e2eBaselineDiff.map((r) => [
      `\`${r.fp}\``,
      r.involvedIds.join(","),
      r.hitIds.join(",") || "-",
      r.changedIds.join(",") || "-",
    ]),
  );
  log();
}

// ───────── 4.7 密封 app.asar = 官方原文基线（只读解析归档头） ─────────

log("### 4.7 真·官方原文基线：`resources/app.asar` 里的同名条目（只读）");
log();
log("4.6 的 `.bak` 有 41 份已被污染，所以那批当不了基线。本机还有一份**没被碰过**的官方原文：");
log("官方安装包自带的密封归档 `resources/app.asar`。仓库自己把它当权威原文来源");
log("（lib/extract-asar.js:176 `archiveFs` 读归档走真实磁盘）。");
log("这里只**解析归档头**（Chromium pickle + JSON 索引）再按偏移读条目字节 —— 不解包、不落盘。");
log();

/** 只读解析 asar 头 + 按偏移取条目。不解包、不写盘。
 *
 *  不按 pickle 的整数去算——那份长度的语义随打包器版本漂过。
 *  直接从 0 号字节找 `{"files"`，再逐字符扫出配对的 `}`，得到 header 的真实边界。
 */
function openAsar(asarPath) {
  if (!fs.existsSync(asarPath)) return null;
  const fd = fs.openSync(asarPath, "r");
  const size = fs.fstatSync(fd).size;

  const window = Buffer.alloc(Math.min(size, 1 << 20));
  fs.readSync(fd, window, 0, window.length, 0);
  const jsonStart = window.indexOf(Buffer.from('{"files"'));
  if (jsonStart < 0) {
    fs.closeSync(fd);
    return null;
  }

  // header 一般几 MB；给足 3 倍余量再截断到 `}}` 结束的 JSON 文本。
  const probeLen = Math.min(size - jsonStart, 24 << 20);
  const probe = Buffer.alloc(probeLen);
  fs.readSync(fd, probe, 0, probeLen, jsonStart);
  const text = probe.toString("utf8");
  let depth = 0;
  let inStr = false;
  let esc = false;
  let jsonEnd = -1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) { jsonEnd = i; break; }
    }
  }
  if (jsonEnd < 0) {
    fs.closeSync(fd);
    return null;
  }
  const jsonSize = Buffer.byteLength(text.slice(0, jsonEnd + 1), "utf8");

  let index;
  try {
    index = JSON.parse(text.slice(0, jsonEnd + 1));
  } catch {
    fs.closeSync(fd);
    return null;
  }

  // 内容区起点：pickle 的整数语义随打包器漂，所以**直接试** ——
  // 从 jsonEnd 附近起扫几个候选偏移，谁能把 dsh/package.json 读成合法 JSON，就用谁。
  let contentOffset = jsonStart + jsonSize + ((4 - (jsonSize % 4)) % 4) + 4;
  try {
    const baseOff = Number(index.files?.dsh?.files?.["package.json"]?.offset);
    const baseSize = Number(index.files?.dsh?.files?.["package.json"]?.size);
    for (let cand = jsonEnd - 8; cand <= jsonEnd + 16; cand += 1) {
      if (cand < 0 || cand + baseOff + baseSize > size) continue;
      const buf = Buffer.alloc(baseSize);
      fs.readSync(fd, buf, 0, baseSize, cand + baseOff);
      try {
        const parsed = JSON.parse(buf.toString("utf8"));
        if (parsed && parsed.name) {
          contentOffset = cand;
          break;
        }
      } catch { /* 试下一个候选 */ }
    }
  } catch { /* 保持推断值 */ }

  const entries = new Map();
  const walk = (node, prefix) => {
    for (const [name, val] of Object.entries(node.files || {})) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (val.files) walk(val, p);
      else if (val.offset !== undefined) entries.set(p, { offset: Number(val.offset), size: Number(val.size) });
      else if (val.unpacked) entries.set(p, { unpacked: true });
    }
  };
  walk(index, "");
  const read = (key) => {
    const e = entries.get(key);
    if (!e || e.unpacked || e.offset === undefined) return null;
    const buf = Buffer.alloc(e.size);
    fs.readSync(fd, buf, 0, e.size, contentOffset + e.offset);
    return buf;
  };
  return {
    asarPath, entries, read, jsonStart, jsonSize, contentOffset,
    close: () => fs.closeSync(fd),
  };
}

const asarGuess = [
  path.resolve(aiBase, "..", "..", "..", "..", "..", "resources", "app.asar"),
  path.resolve(aiBase, "..", "..", "..", "resources", "app.asar"),
].find((p) => fs.existsSync(p)) || null;

log(`app.asar 定位：\`${asarGuess ?? "(未找到)"}\``);
log();

const sealedRows = [];
let sealedInfo = "no-asar";
if (asarGuess) {
  const ar = openAsar(asarGuess);
  if (ar) {
    sealedInfo = "ok";
    const resourcesDir = path.dirname(asarGuess);
    const sealed = new Map();
    for (const fp of allTargetPaths) {
      let rel = null;
      for (const base of [path.join(resourcesDir, "app"), path.join(resourcesDir, "app.asar.unpacked")]) {
        const b = path.normalize(base).toLowerCase();
        const n = path.normalize(fp).toLowerCase();
        if (n.startsWith(`${b}\\`) || n.startsWith(`${b}/`)) {
          rel = path.normalize(fp).slice(base.length + 1).replace(/\\/g, "/");
          break;
        }
      }
      if (rel === null) continue;
      const buf = ar.read(rel);
      if (buf) sealed.set(fp, { rel, buf });
    }
    log(`归档头解析成功；归档条目总数 ${ar.entries.size}，其中命中补丁目标路径的 ${sealed.size} / ${allTargetPaths.length} 个。`);

    // 先去伪：归档里 dsh/package.json 的版本必须与当前解包树一致，否则这份 asar 是另一个构建，
    // 拿它当原文基线不成立。
    let sealedVersion = null;
    let diskVersion = null;
    let sealedHead = "";
    try {
      const vbuf = ar.read("dsh/package.json");
      sealedHead = vbuf ? vbuf.toString("utf8", 0, 60).replace(/\s+/g, " ") : "(read 返回 null)";
      if (vbuf) sealedVersion = JSON.parse(vbuf.toString("utf8")).version || null;
    } catch (e) {
      sealedHead = `解析失败: ${e.message.slice(0, 60)}`;
    }
    log(`归档内 \`dsh/package.json\` 头 60 字：\`${sealedHead}\``);
    try {
      const dshPkg = path.join(path.resolve(aiBase, "..", ".."), "package.json");
      if (fs.existsSync(dshPkg)) diskVersion = JSON.parse(fs.readFileSync(dshPkg, "utf8")).version || null;
    } catch { /* 同上 */ }
    log(`版本核对：归档内 dsh = \`${sealedVersion ?? "读不到"}\`；解包树 dsh = \`${diskVersion ?? "读不到"}\` → ${sealedVersion && diskVersion && sealedVersion === diskVersion ? "**同一构建，可作原文基线**" : "**不一致或读不到 —— 下面的对比只能作推断**"}`);
    log();
    ar.close();

    for (const [fp, { rel, buf }] of sealed) {
      const cur = textOf(fp);
      if (cur == null) continue;
      const sealedText = buf.toString("utf8");
      const identical = buf.equals(Buffer.from(cur, "utf8"));
      const owningKeys = Object.keys(files).filter((k) => {
        const v = files[k];
        return Array.isArray(v) ? v.includes(fp) : v === fp;
      });
      const involved = ALL_PATCHES.filter((p) => keysOf(p).some((k) => owningKeys.includes(k)));
      const hits = involved.map((p) => {
        let hit = 0;
        let total = 0;
        for (const { pattern } of p.replacements) {
          if (!pattern) continue;
          total += 1;
          const ok = typeof pattern === "string"
            ? sealedText.includes(pattern)
            : new RegExp(pattern.source, String(pattern.flags || "").replace("g", "")).test(sealedText);
          if (ok) hit += 1;
        }
        return { id: p.id, hit, total };
      });
      sealedRows.push({ fp, rel, identical, hits, involvedIds: involved.map((p) => p.id) });
    }
  } else {
    sealedInfo = "header-unparsed";
    log("归档头解析失败（不是本脚本关心的形态）—— 跳过本小节。");
  }
} else {
  sealedInfo = "asar-absent";
  log("本机没有 app.asar —— 官方归档已被挪走（宿主处于「已解包」态），**没有密封原文可对照**。");
}
log();

if (sealedRows.length) {
  const ident = sealedRows.filter((r) => r.identical);
  log(`**实测：${ident.length} / ${sealedRows.length} 个补丁目标文件与密封归档里的同名条目逐字节相同**（= 这些文件根本没被洗过）；`);
  log(`其余 ${sealedRows.length - ident.length} 个不同（= 被洗过，或归档与解包树版本不同）。`);
  log();

  const agg = new Map();
  for (const r of sealedRows) {
    for (const h of r.hits) {
      if (!agg.has(h.id)) agg.set(h.id, { hit: 0, total: 0, files: 0, hitFiles: 0 });
      const a = agg.get(h.id);
      a.files += 1;
      if (h.hit > 0) a.hitFiles += 1;
      a.hit = Math.max(a.hit, h.hit);
      a.total = Math.max(a.total, h.total);
    }
  }
  log("密封归档（官方原文）里 pattern 的落脚点统计 —— 这是本机**唯一一份没被污染**的基线：");
  log();
  table(
    ["补丁 id", "密封原文里命中 pattern 数 / 总数", "带这条补丁的文件里有落脚点的比例"],
    [...agg.entries()].sort((x, y) => x[0] - y[0]).map(([id, a]) => [
      String(id),
      `${a.hit} / ${a.total}`,
      `${a.hitFiles} / ${a.files}${a.hit === 0 ? "  ← 密封原文里完全没落脚点" : ""}`,
    ]),
  );
  log();

  const noFoot = sealedRows.flatMap((r) => r.hits.filter((h) => h.hit === 0).map((h) => ({ fp: r.fp, id: h.id, total: h.total })));
  log(`密封原文里 0 命中的 (文件 × 补丁) 组合：${noFoot.length} 个。`);
  if (noFoot.length) {
    const seen = new Set();
    const uniq = [];
    for (const x of noFoot) {
      const key = `${x.id}`;
      const p = ALL_PATCHES.find((q) => q.id === x.id);
      // 同一条补丁可能在多个文件上都 0 命中，也可能只在部分文件上 0 命中；
      // 这里按 (id) 收敛一条，另记「在几个文件上 0 命中 / 该补丁共挂在几个文件上」。
      const allFilesForPatch = [...new Set(noFoot.filter((y) => y.id === x.id).map((y) => y.fp))].length;
      if (seen.has(key)) {
        const row = uniq.find((u) => u.id === x.id);
        if (row) row.zeroFiles = allFilesForPatch;
        continue;
      }
      seen.add(key);
      uniq.push({
        id: x.id,
        name: p?.name,
        onMiss: p ? onMissOf(p) : "?",
        strictFiles: Boolean(p?.strictFiles),
        zeroFiles: allFilesForPatch,
        files: [...new Set(noFoot.filter((y) => y.id === x.id).map((y) => y.fp))],
      });
    }
    uniq.sort((a, b) => a.id - b.id);
    table(
      ["补丁 id", "name", "onMiss", "strictFiles", "密封原文里 0 命中的文件数", "判定"],
      uniq.map((u) => [
        String(u.id),
        u.name || "-",
        u.onMiss,
        u.strictFiles ? "**是**" : "否",
        String(u.zeroFiles),
        u.strictFiles
          ? "**最高优先级：必中补丁在官方原文里也没有落脚点**"
          : (u.onMiss === "fail" ? "onMiss=fail：官方原文对不上，按设计该报失败" : `onMiss=${u.onMiss}：设计上允许不命中`),
      ]),
    );
    log();
    log("对应的完整文件清单：");
    log();
    for (const u of uniq) {
      log(`- **${u.id} ${u.name}**（onMiss=${u.onMiss}${u.strictFiles ? "，strictFiles" : ""}）：`);
      for (const f of u.files) log(`  - \`${f}\``);
    }
    log();
  }
}


// ────────────────────────────── 9. 断言：本脚本真的只读 ──────────────────────────────

log("## 5 只读核实（本脚本执行前后的文件指纹）");
log();
const after = await snapshot();
const mdTimesAfter = Object.fromEntries([...allTargetPaths, ...hostSide].map((fp) => [fp, mtimeKey(fp)]));

const changed = [];
for (const fp of new Set([...Object.keys(before), ...Object.keys(after)])) {
  if (before[fp] !== after[fp]) changed.push({ fp, before: before[fp], after: after[fp] });
}
const mtimeChanged = Object.keys(mdTimesBefore).filter((fp) => mdTimesBefore[fp] !== mdTimesAfter[fp]);

log(`快照范围：${allTargetPaths.length} 个补丁目标文件 + ${hostSide.length} 个宿主元数据文件（dsh/package.json、desktop-runtime.json、app.asar、app/package.json）。`);
log();
if (!changed.length && !mtimeChanged.length) {
  log(`**实测：内容 sha256 与 mtime/size 全部不变 —— 本次诊断期间没有任何目标文件被改写。**`);
} else {
  log("**⚠ 检测到变化（这不该发生）**：");
  for (const c of changed) log(`- \`${c.fp}\`：${String(c.before).slice(0, 16)} → ${String(c.after).slice(0, 16)}`);
  for (const fp of mtimeChanged) log(`- \`${fp}\`：mtime/size ${mdTimesBefore[fp]} → ${mdTimesAfter[fp]}`);
}
log();
log("脚本内所调用的函数与「无副作用」判据（逐条读过实现）：");
log();
log("| 调用 | 实现 | 判据 |");
log("| --- | --- | --- |");
log("| `enumeratePatchAiBases()` | lib/host/paths.js:865 | 只 `isDir`/`realpathSync`/`existsSync` |");
log("| `findAiBase()` / `findDshHome()` | lib/host/paths.js:894 / 595 | memo + 只读探测 |");
log("| `targetFiles(aiBase)` | lib/host/targets.js:386 | 只 `existsSync`/`isFile`/`readdirSync`；全文件无 `fs.write*` |");
log("| `checkHostVersionGate()` | lib/core.js:200 | → lib/host-version.js，全文件无写调用 |");
log("| `patchStatus()` | lib/core.js:2055 | `loadText` = `fsp.readFile`；`annotateHookDenyStatus` 在 settings 为空时立即 return |");
log("| `contentOutcomeOf()` / `onMissOf()` / `patchStatusReady()` | lib/core.js | 纯函数（与 patchStatus 同一套证据） |");
log("| `applyReplacementsToText()` | lib/core.js:1717 | **本脚本只把它的返回值赋给局部变量**，从不落盘 |");
log();
log("**从未调用**：`applyPatches` / `applyPatchesAllHosts` / `backupAll` / `revertAll` / `revertAllHosts` / `patchShim` / `patchAllShims` / `silence*` / `installOverride` / 任何 `write*`、`save*`、`atomic*`。");
log();

// ────────────────────────────── 10. 全量明细 ──────────────────────────────

log("## 6 全量明细（82 条）");
log();
table(
  ["id", "name", "layer", "onMiss", "strict", "state", "file", "applied/pending/skipped/unmatched/missing"],
  details.map((d) => [
    String(d.id),
    d.name,
    d.layer || "-",
    d.onMiss,
    d.strictFiles ? "是" : "",
    d.engineStatus,
    fileLabel({ file: d.file }),
    `${d.tally.applied}/${d.tally.pending}/${d.tally.skipped}/${d.tally.unmatched}/${d.tally.missing}`,
  ]),
);
log();

if (disagree.length) {
  log("我重算的 state 与引擎返回值不一致的条目（说明我漏了某条聚合规则，不等于引擎错）：");
  table(
    ["id", "name", "引擎", "重算"],
    disagree.map((d) => [String(d.id), d.name, d.engineStatus, d.recomputed]),
  );
  log();
}

// ────────────────────────────── 落盘 ──────────────────────────────

// 默认落点选在 .tmp-repair/ 下：本脚本的执行者只被授权写 .tmp-repair/ 与 scripts/probe-host-patches.mjs，
// 不往 scripts/ 里多塞产物。PROBE_OUT 可覆盖，但仍强制必须在仓库内。
const defaultOut = path.join(REPO, ".tmp-repair", "f7-probe.json");
const outPath = path.resolve(process.env.PROBE_OUT || defaultOut);
if (!outPath.toLowerCase().startsWith(REPO.toLowerCase())) {
  process.stderr.write(`PROBE_OUT 必须在仓库内：${outPath}\n`);
  process.exit(2);
}
try {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
} catch { /* 目录建不出来就让下面的 writeFileSync 报错 */ }

const json = {
  generatedAt: new Date().toISOString(),
  aiBase,
  dshHome: findDshHome(),
  versionGate: gate,
  readonly: {
    snapshottedFiles: [...allTargetPaths, ...hostSide],
    changed,
    mtimeChanged,
  },
  distribution: dist,
  onMissGroups: Object.fromEntries(Object.entries(onMissGroups).map(([k, v]) => [k, { total: v.total, strict: v.strict, states: v.states }])),
  unresolvedKeys: Object.fromEntries(unresolvedKeys.map((k) => [k, keyToPatches.get(k) || []])),
  strictFiles: details.filter((d) => d.strictFiles).map((d) => ({ id: d.id, name: d.name, state: d.engineStatus, onMiss: d.onMiss, file: d.file })),
  suspicious: {
    strictMiss: strictMiss.map((d) => d.id),
    failMiss: failMiss.map((d) => d.id),
    missingFile: missFilePatches.map((d) => d.id),
    roundTripFail: roundTripRows.filter((r) => !r.ok).map((r) => ({ id: r.id, fp: r.fp })),
  },
  appliedIdsFromHost: appliedIds ? [...appliedIds] : null,
  endToEnd: {
    backupsFound: bakOf.size,
    backupEqualsCurrent: e2eIdentical.map((r) => ({ fp: r.fp, ids: r.involvedIds, patternHits: r.patternHits })),
    baselineRoundtripOk: e2eBaseline.map((r) => ({ fp: r.fp, ids: r.involvedIds, hitIds: r.hitIds, changedIds: r.changedIds })),
    baselineRoundtripDiffers: e2eBaselineDiff.map((r) => ({ fp: r.fp, ids: r.involvedIds, hitIds: r.hitIds, changedIds: r.changedIds })),
    baselinePatternsNoHit: e2eNone.map((r) => ({
      fp: r.fp,
      involvedIds: r.involvedIds,
      patternHits: r.patternHits,
      backupKind: r.backupKind,
    })),
  },
  sealedAsar: {
    state: sealedInfo,
    path: asarGuess,
    comparedFiles: sealedRows.length,
    identicalToSealed: sealedRows.filter((r) => r.identical).map((r) => r.fp),
    sealedPatternFooting: Object.fromEntries((() => {
      const agg = new Map();
      for (const r of sealedRows) {
        for (const h of r.hits) {
          if (!agg.has(h.id)) agg.set(h.id, { maxHit: 0, total: 0, files: 0, hitFiles: 0 });
          const a = agg.get(h.id);
          a.files += 1;
          if (h.hit > 0) a.hitFiles += 1;
          a.maxHit = Math.max(a.maxHit, h.hit);
          a.total = Math.max(a.total, h.total);
        }
      }
      return [...agg.entries()].map(([id, a]) => [id, a]);
    })()),
  },
  details: details.map((d) => ({
    id: d.id,
    name: d.name,
    onMiss: d.onMiss,
    strictFiles: d.strictFiles,
    engineStatus: d.engineStatus,
    tally: d.tally,
    perKey: d.perKey,
  })),
};

fs.writeFileSync(outPath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
log(`机器可读明细已写入：\`${outPath}\`（这是本脚本唯一的写动作，路径强制限制在仓库内）。`);
