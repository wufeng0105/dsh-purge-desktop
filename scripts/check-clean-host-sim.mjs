/**
 * scripts/check-clean-host-sim.mjs — 补丁归宿要以干净宿主为准，装机树上的命中不作依据。
 * 干净宿主判定（**只读**）：把密封 `app.asar` 里的官方原文当作**未清洗宿主**，
 * 逐补丁跑**真实引擎函数**，回答两个问题：
 *
 *   Q1 全新安装在这版官方宿主上，每条补丁会判成什么状态？（会不会让 apply 失败）
 *   Q2 哪些补丁在官方原文上**永不产出任何字节改动**？（= 惰性/冗余数据）
 *
 * ## 为什么必须有这个工具（`probe:host` 答不了这个问题）
 *
 * `npm run probe:host` 只数**pattern 命中数**，而 pattern 零命中**不等于**失败：
 * 进 `pattern_not_found` 的唯一入口是 `notFound > 0`（`lib/core.js:1786`/`:1793`），
 * 而 apply 循环只在 `patchHasRemainingWork(...) || p.strictFiles` 时自增 notFound
 * （`lib/core.js:1997`）。所以「pattern 零命中 + strictFiles:false」落到
 * `skipped`（软，不失败）。1.2.1 的报告正是把「零落脚点」读成了「会失败」，
 * 1.2.2 用本工具实测推翻：**0 条会失败，15/15 strictFiles 全部落地**。
 * 判定要算数，必须跑真实的内容判据（`core.contentOutcomeOf`，与 `patchStatus` 同一套证据），
 * 不能只看命中数，也不许在脚本里另写一份判定。
 *
 * ## 自校验（结论可信的前提）
 *
 * 脚本会把「复刻的 patchStatus 判定层」在**当前磁盘文本**上与真实
 * `core.patchStatus()` 对照，必须 82/82 一致；不一致就只输出推断、不给结论。
 * 唯一带副本的是 `rollupPatchStatus`（13 行纯整数算术，私有符号），而所有
 * 「会不会失败」的判定都交给**真实导出**的 `isPatchResultSoftOk`，副本只产出
 * 中间状态字符串。
 *
 * ## 只读保证
 *
 * 不写宿主、不动 `.bak`、不调 `applyPatches` / `applyPatchesAllHosts` /
 * `backupAll` / `revertAll*` / `silence*`；读 `app.asar` 只解析归档头 + 按偏移
 * 取字节，**不解包落盘**。输出强制落在仓库内 `.tmp-repair/`（已 gitignore）。
 *
 * ## 密封原文可以从 `.bak` 取（2026-10 起）
 *
 * unseal 的动作是把 `resources/app.asar` **改名**成 `resources/app.asar.bak`，两份同源同字节；
 * 之后被清洗的是 `resources/app/` 那棵解包树，`.bak` 一个字节都不动。所以本机这种
 * 「已解包清洗、`app.asar` 不在」的状态下，`.bak` 就是当次安装的官方原文：
 *
 *   - 选择顺序固定 `app.asar` → `app.asar.bak`，解析走**同一条** `openAsar()` 代码路径；
 *   - 用的是哪一份写进输出与 JSON（`sealedSource`）：`.bak` 可能是上一个 build 留下的，
 *     读结论的人要先能判断基线与装机树是不是同一版；
 *   - **不回退到 `app.asar.unpacked`**：那是清洗后的文本，拿它当「未清洗原文」等于
 *     拿结论当输入，下面的 Q1/Q2 会退化成自证。
 *
 * 两条都不在时仍 exit 3，并把试过的两条路径打出来 —— 缺基线与「结论是干净」是两件事。
 *
 * 用法：`npm run probe:clean-host`（需要本机有宿主，且 `resources/app.asar` 或其 `.bak` 在）
 * 非零退出码：2 = 没定位到宿主；3 = 没有可用的密封原文 —— 两个都不是「通过」。
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// 必须在 lib/ 被求值前设好：lib/surface.js 在 import 期就读 process.env。
process.env.DSH_SURFACE = process.env.DSH_SURFACE || "desktop";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const core = await import("../lib/core.js");
const { ALL_PATCHES } = await import("../lib/patch/table.js");
const { targetFiles } = await import("../lib/host/targets.js");
const { isYamlPath, sanitizeYamlPersonaScalars } = await import("../lib/prompt/text.js");

const log = (...a) => console.log(...a);
const pad = (s, n) => String(s).padEnd(n);
const padS = (s, n) => String(s).padStart(n);

// ────────────────────────────────────────── 0) 输入指纹（防止拿旧 JSON 当基线）
/**
 * 为什么落一枚指纹：判定结果完全由「补丁表 + 宿主密封原文」决定，而宿主原文是机器本地件、
 * 不方便逐字节入账。补丁表这一半可以精确认账 —— 表一变，分布数字就可能变，
 * 这时任何「和上次不一样」的结论都必须先看是不是表变了。把 HEAD 与两份表文件的 sha256
 * 一起写进 JSON，读的人一条命令就能判断「这份 JSON 是不是当前代码跑出来的」。
 */
function sha256Of(rel) {
  const buf = fs.readFileSync(path.join(repoRoot, rel));
  return createHash("sha256").update(buf).digest("hex");
}
function gitHead() {
  try {
    const out = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim();
  } catch {
    return "unknown";
  }
}
const sourceFingerprint = {
  head: gitHead(),
  files: {
    "lib/patch/table.js": sha256Of("lib/patch/table.js"),
    "lib/patch/constants.js": sha256Of("lib/patch/constants.js"),
  },
};
log(`输入指纹：head=${sourceFingerprint.head} `
  + `table.js=${sourceFingerprint.files["lib/patch/table.js"].slice(0, 12)}… `
  + `constants.js=${sourceFingerprint.files["lib/patch/constants.js"].slice(0, 12)}…`);
log();

// ─────────────────────────────────────────────────────────── 1) 定位宿主

/**
 * 取 aiBase 时要小心两件事：
 *   1. `resolveOfficialAiBase()` 返回的是**对象** `{aiBase, handoff:{asar, appDir, …}}`，
 *      不是字符串；直接 `await` 拿到对象当字符串用会踩空。
 *   2. `findDshBinRoot()` 给的是深一层的 `…\@deepseek-ai\dsh`，而 `targetFiles()`
 *      认的是 `…\@deepseek-ai`。用错 base 时 `targetFiles()` 只解出 1 个 key（`lib/main.js`），
 *      而且 `patchStatus` 也一起错 —— 表面上「复刻 vs 真实」照样一致，实际是同一个错自洽。
 *      所以优先用 resolveOfficialAiBase，并顺手拿它的 handoff（asar / appDir 都是现成的）。
 */
async function pickAiBase() {
  const trace = [];
  const call = async (name) => {
    const fn = core[name];
    if (typeof fn !== "function") return null;
    try {
      let v = fn();
      if (v && typeof v.then === "function") v = await v;
      if (v && typeof v === "object" && typeof v.aiBase === "string" && v.aiBase) {
        trace.push(`${name}() → 对象，aiBase=${v.aiBase}，asar=${v.handoff?.asar ?? "(无)"}`);
        return { aiBase: v.aiBase, handoff: v.handoff ?? null };
      }
      trace.push(`${name}() → ${typeof v === "string" && v ? v : JSON.stringify(v)?.slice(0, 60) ?? "null"}`);
      return typeof v === "string" && v ? { aiBase: v, handoff: null } : null;
    } catch (e) {
      trace.push(`${name}() 抛错 ${e.message}`);
      return null;
    }
  };
  for (const name of ["resolveOfficialAiBase", "findAiBase", "findDshBinRoot"]) {
    const v = await call(name);
    if (v) return { ...v, trace };
  }
  if (typeof core.enumeratePatchAiBases === "function") {
    try {
      let list = core.enumeratePatchAiBases();
      if (list && typeof list.then === "function") list = await list;
      const arr = Array.isArray(list) ? list : [list];
      trace.push(`enumeratePatchAiBases() → ${arr.length} 个`);
      if (arr[0]) return { aiBase: arr[0], handoff: null, trace };
    } catch (e) {
      trace.push(`enumeratePatchAiBases() 抛错 ${e.message}`);
    }
  }
  return { aiBase: null, handoff: null, trace };
}

const { aiBase, handoff, trace } = await pickAiBase();
for (const t of trace) log("  ", t);
if (!aiBase) {
  log("!! 没定位到宿主，无法取 targetFiles。中止。");
  process.exit(2);
}
log("aiBase =", aiBase);
const files = targetFiles(aiBase);

// pathsOf 是 lib/core.js:1137 的私有函数，这里是**逐字副本**（按 fs.existsSync 过滤）。
const pathsOf = (f, key) => {
  const fp = f[key];
  if (fp == null || fp === "") return [];
  const list = Array.isArray(fp) ? fp : [fp];
  return list.filter((p) => p && fs.existsSync(p));
};
const keysOf = (p) => (Array.isArray(p.file) ? p.file : [p.file]);

// ─────────────────────────────────────────────────────────── 2) 密封原文

/**
 * 读 asar 归档（只读）。规范布局： [4 字节 pickle 头][uint32 pickle 长度][pickle…]
 * contentOffset = 8 + pickleSize。读完做自检：必须能把 dsh/package.json 读成合法 JSON，
 * 否则按候选偏移回扫（打包器对 pickle 整数的解释会漂）。
 */
function openAsar(asarPath) {
  const fd = fs.openSync(asarPath, "r");
  const size = fs.fstatSync(fd).size;
  // 不按 pickle 的整数去算长度——那份语义随打包器版本漂过（这一份就解析失败）。
  // 与 scripts/probe-host-patches.mjs:885 同法：从 0 号字节找 `{"files"`，逐字符扫出配对的 `}`。
  const window = Buffer.alloc(Math.min(size, 1 << 20));
  fs.readSync(fd, window, 0, window.length, 0);
  const jsonStart = window.indexOf(Buffer.from('{"files"'));
  if (jsonStart < 0) {
    fs.closeSync(fd);
    return null;
  }
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
  let contentOffset = jsonStart + jsonSize + ((4 - (jsonSize % 4)) % 4) + 4;
  const read = (key) => {
    const e = entries.get(key);
    if (!e || e.unpacked || e.offset === undefined) return null;
    const b = Buffer.alloc(e.size);
    fs.readSync(fd, b, 0, e.size, contentOffset + e.offset);
    return b;
  };
  let selfCheck = false;
  try {
    const v = read("dsh/package.json");
    selfCheck = !!(v && JSON.parse(v.toString("utf8")).name);
  } catch { selfCheck = false; }
  if (!selfCheck) {
    const base = index.files?.dsh?.files?.["package.json"];
    if (base && base.offset !== undefined) {
      const bOff = Number(base.offset);
      const bSize = Number(base.size);
      for (let cand = jsonEnd - 64; cand <= jsonEnd + 64; cand += 1) {
        if (cand < 0 || cand + bOff + bSize > size) continue;
        const b = Buffer.alloc(bSize);
        fs.readSync(fd, b, 0, bSize, cand + bOff);
        try {
          const j = JSON.parse(b.toString("utf8"));
          if (j && j.name) { contentOffset = cand; selfCheck = true; break; }
        } catch { /* 试下一个 */ }
      }
    }
  }
  return { entries, read, contentOffset, selfCheck, close: () => fs.closeSync(fd) };
}

/**
 * 别再按固定层数往上数：`resolveOfficialAiBase()` / `findDshBinRoot()` 返回的
 * aiBase 深度不一样（前者给对象、后者给 `…\@deepseek-ai\dsh`），写死 `"..","..",".."`
 * 会指到 `…\app\dsh\app.asar` 这种不存在的位置。改成向上逐层试两种常见布局。
 *
 * 每层试两个文件名（`app.asar` 与它的备份 `.bak`），**顺序就是优先级**：
 * 密封原件在场时永远用它，`.bak` 只在原件缺席时补位。
 */
function sealedCandidates(start) {
  const out = [];
  let dir = start;
  for (let i = 0; i < 8; i += 1) {
    for (const base of [dir, path.join(dir, "resources")]) {
      for (const name of ["app.asar", "app.asar.bak"]) {
        const p = path.join(base, name);
        if (!out.includes(p)) out.push(p);
      }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return out;
}

/** 报错时只列资源目录下那一对（`app.asar` / `app.asar.bak`），别把整条上溯链倒出来。 */
function primarySealedPaths(cands) {
  const inResources = cands.filter((p) => path.basename(path.dirname(p)).toLowerCase() === "resources");
  return inResources.length >= 2 ? inResources.slice(0, 2) : cands.slice(0, 2);
}

/** 命中的那条候选与它「是哪一份」的标签（`app.asar` / `app.asar.bak`）。 */
function pickSealed(aiBase2, handoffInfo) {
  if (handoffInfo?.asar && fs.existsSync(handoffInfo.asar)) {
    return { path: handoffInfo.asar, source: "app.asar" };
  }
  const cands = sealedCandidates(aiBase2);
  const hit = cands.find((c) => fs.existsSync(c));
  return hit ? { path: hit, source: path.basename(hit) } : { path: null, source: null, cands };
}

const sealedPick = pickSealed(aiBase, handoff);
const asarPath = sealedPick.path;
const sealedSource = sealedPick.source;
const appDir = handoff?.appDir ?? (asarPath ? path.join(path.dirname(asarPath), "app") : null);
const resourcesDir = appDir ? path.dirname(appDir) : path.resolve(aiBase, "..", "..", "..");
log("密封原文 =", asarPath ?? "(未找到)", "| 用的是", sealedSource ?? "(无)", "| appDir =", appDir ?? "(未知)");

/** 把解包树里的绝对路径映射到归档内的相对键（与 scripts/probe-host-patches.mjs 同法）。 */
function relOf(fp) {
  for (const base of [appDir, appDir ? `${appDir}.asar.unpacked` : null].filter(Boolean)) {
    const b = path.normalize(base).toLowerCase();
    const n = path.normalize(fp).toLowerCase();
    if (n.startsWith(`${b}\\`) || n.startsWith(`${b}/`)) {
      return path.normalize(fp).slice(base.length + 1).replace(/\\/g, "/");
    }
  }
  return null;
}

const pristineSealed = new Map(); // fp -> 官方原文（不可变）
let sealedNote = "no-asar";
if (asarPath) {
  const ar = openAsar(asarPath);
  if (!ar) sealedNote = "header-unparsed";
  else if (!ar.selfCheck) sealedNote = "content-offset-unverified";
  else {
    let count = 0;
    for (const key of Object.keys(files)) {
      for (const fp of pathsOf(files, key)) {
        if (pristineSealed.has(fp)) continue;
        const rel = relOf(fp);
        if (rel == null) continue;
        const buf = ar.read(rel);
        if (!buf) continue;
        pristineSealed.set(fp, buf.toString("utf8"));
        count += 1;
      }
    }
    // 直接用磁盘上的全量目标路径再扫一遍，覆盖按 key 没走到的文件
    for (const fp of Object.values(files).flatMap((v) => (Array.isArray(v) ? v : [v]))) {
      if (typeof fp !== "string" || pristineSealed.has(fp) || !fs.existsSync(fp)) continue;
      const rel = relOf(fp);
      if (rel == null) continue;
      const buf = ar.read(rel);
      if (buf) { pristineSealed.set(fp, buf.toString("utf8")); count += 1; }
    }
    sealedNote = "ok";
    log(`归档自检通过（contentOffset=${ar.contentOffset}，条目 ${ar.entries.size} 个）；从 ${sealedSource} 取到官方原文 ${count} 个补丁目标文件。`);
    // 防「拿已清洗的字节当干净原文」：`.bak` 是 rename 来的，但一台机器上它也可能是
    // 上一轮清洗后又 unseal 一次留下的副本。判据只看插件自己的 marker —— 官方原文里
    // 不可能有 `[dsh-purge]`，出现了就说明这份「原文」已经被写过，Q1/Q2 不成立。
    const washed = [...pristineSealed.values()].filter((t) => t.includes("[dsh-purge]")).length;
    if (washed > 0) {
      sealedNote = "sealed-looks-washed";
      log(`!! 这份密封原文里有 ${washed} 个文件带插件 marker —— 它是清洗后的字节，不是官方原文。`);
    }
  }
  ar.close();
} else {
  const tried = primarySealedPaths(sealedPick.cands ?? sealedCandidates(aiBase));
  log("!! 没有密封原文可作干净宿主基线，两份候选都不在。试过这两条：");
  for (const p of tried) log("     ", p);
  log(`   （本次一共试了 ${(sealedPick.cands ?? []).length} 条上溯候选；缺基线 ≠ 结论是干净）`);
}

// 去伪：归档内 dsh/package.json 版本必须与解包树一致
if (sealedNote === "ok") {
  const pkgPath = path.join(resourcesDir, "app", "dsh", "package.json");
  try {
    const diskV = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
    const ar = openAsar(asarPath);
    const buf = ar.read("dsh/package.json");
    const sealedV = buf ? JSON.parse(buf.toString("utf8")).version : null;
    ar.close();
    log(`版本核对：归档内 dsh=${sealedV} / 解包树 dsh=${diskV} → ${sealedV === diskV ? "同一构建，可作基线" : "**不一致，下面只能作推断**"}`);
  } catch (e) {
    log("版本核对失败：", e.message);
  }
}
log();

// ───────────────────────────────────────────────── 3) 模式 A：校验判定层

/**
 * 复刻 patchStatus 的计数与收敛（`lib/patch/rollup.js` 那份的逐字副本），只在**内存文本**上跑。
 * 逐文件判定**不复制**：调 `core.contentOutcomeOf`，与 `patchStatus` 同一套证据与次序。
 * 本函数只校验「路径解析 + 逐文件循环」有没有跟真引擎走偏。
 */
function statusSim(textOf) {
  const out = {};
  for (const p of ALL_PATCHES) {
    if (!core.patchAppliesHere(p)) { out[p.id] = "na"; continue; }
    const keys = keysOf(p);
    let applied = 0, pending = 0, skipped = 0, unmatched = 0, missing = 0;
    for (const key of keys) {
      const fps = pathsOf(files, key);
      if (fps.length === 0) { missing += 1; continue; }
      for (const fp of fps) {
        let text = null;
        try { text = textOf(fp); } catch { pending += 1; continue; }
        if (text == null) { pending += 1; continue; }
        const o = core.contentOutcomeOf(text, p, fp);
        if (o === "applied") applied += 1;
        else if (o === "pending") pending += 1;
        else if (p.strictFiles) unmatched += 1;
        else skipped += 1;
      }
    }
    if (pending > 0) out[p.id] = "pending";
    else if (applied > 0) out[p.id] = "applied";
    else if (unmatched > 0) out[p.id] = "unmatched";
    else if (skipped > 0) out[p.id] = "skipped";
    else out[p.id] = core.onMissOf(p) === "fail" ? "missing_file" : "na";
  }
  return out;
}

const realStatus = await core.patchStatus(aiBase);
const simStatus = statusSim((fp) => fs.readFileSync(fp, "utf8"));
const mismatches = [];
for (const p of ALL_PATCHES) {
  if ((realStatus[p.id] ?? "(absent)") !== (simStatus[p.id] ?? "(absent)")) {
    mismatches.push({ id: p.id, name: p.name, real: realStatus[p.id] ?? "(absent)", sim: simStatus[p.id] ?? "(absent)" });
  }
}
log(`【校验】在当前（已清洗）文本上，复刻判定 vs 真实 patchStatus：${ALL_PATCHES.length - mismatches.length}/${ALL_PATCHES.length} 一致，偏差 ${mismatches.length} 条`);
for (const m of mismatches) log(`   id=${padS(m.id, 2)} 真=${pad(m.real, 14)} 复刻=${pad(m.sim, 14)} ${m.name}`);
log(`  → 复刻层${mismatches.length === 0 ? "完全一致，可用作干净宿主模拟" : "有偏差，下面干净宿主结论只作推断"}`);
log();

if (sealedNote !== "ok") {
  const why = {
    "no-asar": "宿主 resources 下 app.asar 与 app.asar.bak 都不在（上面列了试过的两条路径）",
    "header-unparsed": "归档头解析失败（这份字节不是能读的 asar）",
    "content-offset-unverified": "归档自检没过（contentOffset 回扫也读不出 dsh/package.json）",
    "sealed-looks-washed": "这份密封原文带插件 marker，是清洗后的字节，不能当未清洗基线",
  }[sealedNote] ?? sealedNote;
  log(`没有可用的密封原文，Q1/Q2 无法回答。原因：${why}。中止。`);
  process.exit(3);
}

// ─────────────────────────────────────── 4) 模式 B：干净宿主全序应用模拟

/**
 * `rollupPatchStatus` 是 lib/core.js:1782-1794 的**逐字副本**（纯整数算术）。
 * 为什么必须带一份副本：它是私有符号，而干净宿主判定绕不开它。
 * 为了让副本不变成第二种真相，下面的「失败判定」一律交给**真实导出**的
 * `isPatchResultSoftOk` / `summarizeApplyReport`，副本只产出中间状态字符串。
 */
function rollupPatchStatus({ applied, already, missing, notFound, lastError, keyCount, onMiss, strictFiles }) {
  if (strictFiles && lastError) return lastError;
  if (strictFiles && notFound > 0) return "pattern_not_found";
  if (applied > 0) return "applied";
  if (already > 0 && (notFound === 0 || onMiss === "warn")) return "already";
  if (missing === keyCount) return "missing_file";
  if (lastError) return lastError;
  if (notFound === 0) return "skipped";
  return "pattern_not_found";
}

function applySim() {
  const work = new Map(pristineSealed); // 可变副本：前面的补丁写了，后面的补丁能看到
  const rows = [];
  const perFile = [];
  for (const p of ALL_PATCHES) {
    if (!core.patchAppliesHere(p)) {
      rows.push({ id: p.id, name: p.name, status: "na", applied: 0, already: 0, missing: 0, notFound: 0, absent: 0 });
      continue;
    }
    const keys = keysOf(p);
    let applied = 0, already = 0, missing = 0, notFound = 0, absent = 0, lastError = null;
    for (const key of keys) {
      const fps = pathsOf(files, key);
      if (fps.length === 0) { missing += 1; continue; }
      for (const fp of fps) {
        const text = work.get(fp);
        if (text == null) { absent += 1; continue; }
        // 独立于前序补丁的判定：官方原文上这条补丁单独跑会怎样
        const soloOutcome = core.contentOutcomeOf(pristineSealed.get(fp), p, fp);
        const soloChanged = core.applyReplacementsToText(pristineSealed.get(fp), p, fp).changed;

        const r = core.applyReplacementsToText(text, p, fp);
        let textOut = r.text;
        let changed = r.changed;
        if (isYamlPath(fp)) {
          const cleaned = sanitizeYamlPersonaScalars(textOut);
          if (cleaned !== textOut) { textOut = cleaned; changed = true; }
        }
        perFile.push({ id: p.id, fp, soloOutcome, soloChanged, changed });
        if (changed) { work.set(fp, textOut); applied += 1; continue; }
        // 逐文件结论与 patchStatus 同一套证据（contentOutcomeOf），不在这里复制判定。
        const o = core.contentOutcomeOf(text, p, fp);
        if (o === "applied") already += 1;
        else if (o === "pending" || p.strictFiles) notFound += 1;
      }
    }
    rows.push({
      id: p.id,
      name: p.name,
      status: rollupPatchStatus({
        applied, already, missing, notFound, lastError, keyCount: keys.length,
        onMiss: core.onMissOf(p), strictFiles: !!p.strictFiles,
      }),
      applied, already, missing, notFound, absent,
    });
  }
  return { rows, perFile };
}

const { rows, perFile } = applySim();

const dist = {};
for (const r of rows) dist[r.status] = (dist[r.status] ?? 0) + 1;
log("【Q1】干净宿主模拟状态分布：", JSON.stringify(dist));

const byId = new Map(ALL_PATCHES.map((p) => [p.id, p]));
const failRows = rows.filter((r) => !core.isPatchResultSoftOk({ status: r.status, patch_id: r.id }, byId.get(r.id)));
log(`     用真实 isPatchResultSoftOk 判定「会让 apply 失败」的：${failRows.length} 条`);
for (const r of failRows) log(`       id=${padS(r.id, 2)} ${pad(r.status, 16)} strict=${byId.get(r.id).strictFiles ? "Y" : "n"} ${r.name}`);
log();

const inj = rows.filter((r) => r.status !== "na" && r.applied === 0 && r.absent === 0);
log(`【Q2】干净宿主上不产出任何字节改动的补丁：${inj.length} 条（状态 applied/already/skipped 都算）`);
log();
log("【明细】重点 4 条 + 全部「不产出改动」的 fail 组成员：");
log(`  ${pad("id", 4)}${pad("状态", 16)}${pad("strict", 7)}${pad("onMiss", 8)}${pad("applied", 9)}${pad("already", 9)}${pad("notFound", 9)}名字`);
const focus = new Set([2, 3, 24, 40]);
for (const r of rows) {
  const isFocus = focus.has(r.id);
  const isInertFail = r.status !== "na" && r.applied === 0 && core.onMissOf(byId.get(r.id)) === "fail";
  if (!isFocus && !isInertFail) continue;
  log(`  ${pad(r.id, 4)}${pad(r.status, 16)}${pad(byId.get(r.id).strictFiles ? "Y" : "n", 7)}${pad(core.onMissOf(byId.get(r.id)), 8)}${pad(r.applied, 9)}${pad(r.already, 9)}${pad(r.notFound, 9)}${r.name}`);
}
log();

log("【逐文件】重点 4 条在官方原文上的判定：");
for (const fp2 of [...perFile].filter((x) => focus.has(x.id))) {
  log(`  id=${padS(fp2.id, 2)} solo=${pad(fp2.soloOutcome, 9)} soloChanged=${pad(fp2.soloChanged ? "Y" : "n", 4)} 顺序感知changed=${pad(fp2.changed ? "Y" : "n", 4)} ${fp2.fp.replace(resourcesDir, "…")}`);
}
log();

// ────────────────────────── 6) 解剖：惰性补丁到底为什么不产出改动

/**
 * 三种互斥的病因：
 *   pattern 不命中            → 这条补丁的锚点在官方原文里不存在（多为旧版布局遗留）
 *   替换正文已在官方原文里    → **上游已经做过了**，补丁已过时（删/降级都安全）
 *   marker 在原文里但替换不在 → **marker 太弱**，是真的 bug：干净安装永远判「已应用」，
 *                              于是这条补丁在全新机器上从来不会执行
 * 第三类是唯一需要改代码的那一类，所以必须和第一、二类分开。
 */
const asLfMod = await import("../lib/prompt/text.js");
const asLf = asLfMod.asLf;
const patchReplacementsOf = (p) =>
  Array.isArray(p.replacements) ? p.replacements : (p.patterns ?? []).map((pat) => ({ pattern: pat, replace: p.replace }));
const hitOf = (hay, pattern) => {
  if (pattern == null) return null;
  if (pattern instanceof RegExp) return new RegExp(pattern.source, String(pattern.flags || "").replace("g", "")).test(hay);
  return hay.includes(asLf(pattern));
};

const inertIds = inj.map((r) => r.id).sort((a, b) => a - b);
const missingIds = rows.filter((r) => r.status === "missing_file").map((r) => r.id);
log("【解剖】为什么这些补丁在干净宿主上不产出改动");
log(`   不产出改动 ${inertIds.length} 条：${inertIds.join(", ")}`);
log(`   目标文件全缺 ${missingIds.length} 条：${missingIds.join(", ")}`);
log();
log(`   ${pad("id", 4)}${pad("文件", 46)}${pad("repl", 6)}${pad("pattern", 10)}${pad("替换首行已在原文", 18)}${pad("替换全文已在原文", 18)}marker`);
const anatomy = [];
const upstrd = new Set();  // 上游已做过
const weakMarker = new Set(); // marker 太弱
const noAnchor = new Set();   // 锚点不存在
for (const p of ALL_PATCHES) {
  if (!inertIds.includes(p.id) && !focus.has(p.id)) continue;
  const fps = keysOf(p).flatMap((k) => pathsOf(files, k));
  for (const fp of fps) {
    const sealed = pristineSealed.get(fp);
    if (sealed == null) continue;
    const repls = patchReplacementsOf(p);
    repls.forEach(({ pattern, replace }, idx) => {
      const patternHit = hitOf(sealed, pattern);
      const head = typeof replace === "string" ? asLf(replace).split("\n")[0].slice(0, 80) : null;
      const headIn = head ? sealed.includes(head) : null;
      const wholeIn = typeof replace === "string" && replace.length > 0 ? sealed.includes(asLf(replace)) : null;
      const markersIn = Array.isArray(p.markers) ? p.markers.some((m) => sealed.includes(asLf(m))) : p.marker ? sealed.includes(asLf(p.marker)) : null;
      if (patternHit === false && headIn === true && wholeIn === true) upstrd.add(p.id);
      else if (patternHit === false && headIn === false && markersIn === true) weakMarker.add(p.id);
      else if (patternHit === false) noAnchor.add(p.id);
      const rec = { id: p.id, fp: fp.replace(resourcesDir, "…"), repl: idx, patternHit, headIn, wholeIn, markersIn };
      anatomy.push(rec);
      log(`   ${pad(p.id, 4)}${pad(rec.fp.slice(-44), 46)}${pad(idx, 6)}${pad(patternHit === null ? "-" : patternHit ? "命中" : "未命中", 10)}${pad(headIn === null ? "-" : headIn ? "是" : "否", 18)}${pad(wholeIn === null ? "-" : wholeIn ? "是" : "否", 18)}${markersIn === null ? "-" : markersIn ? "在" : "不在"}`);
    });
  }
}
log();
log(`   病因统计：上游已做过 ${upstrd.size} 条 [${[...upstrd].sort((a, b) => a - b).join(", ")}]`);
log(`             **marker 太弱**（干净安装永不执行）${weakMarker.size} 条 [${[...weakMarker].sort((a, b) => a - b).join(", ")}]`);
log(`             锚点不存在（旧布局遗留）${noAnchor.size} 条 [${[...noAnchor].sort((a, b) => a - b).join(", ")}]`);
log();

// ─────────────────────────────────────────────────────────── 5) 落盘
const outDir = path.join(repoRoot, ".tmp-repair");
fs.mkdirSync(outDir, { recursive: true });
const outJson = path.join(outDir, "clean-host.json");
fs.writeFileSync(outJson, JSON.stringify({
  generatedAt: new Date().toISOString(),
  sourceFingerprint,
  aiBase,
  asarPath,
  sealedSource,
  sealedNote,
  sealedFiles: pristineSealed.size,
  validation: { total: ALL_PATCHES.length, mismatches },
  cleanHostStatus: Object.fromEntries(rows.map((r) => [r.id, r.status])),
  cleanHostDistribution: dist,
  wouldFailApplication: failRows.map((r) => ({ id: r.id, name: r.name, status: r.status })),
  inertOnCleanHost: inj.map((r) => ({ id: r.id, name: r.name, status: r.status, applied: r.applied })),
  rows,
  perFileFocus: perFile.filter((x) => focus.has(x.id)),
  perFileAll: perFile,
}, null, 1), "utf8");
log("JSON →", outJson);
