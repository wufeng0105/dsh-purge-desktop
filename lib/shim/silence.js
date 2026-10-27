/**
 * lib/shim/silence.js — 五个静默目标共用一套执行器，加目标只加一行数据。
 * 5 个 silence 目标的数据表 + 单执行器。
 *
 * ## 为什么在这里而不是 core.js
 *
 * 收敛前是 5 份逐字复制的 `for (const fp of files) { ... }` 循环，共 356 行，
 * 差异只有三个维度：文件清单、marker/needle/replacement、以及「已应用」怎么判。
 * 新增一个目标要复制 ~70 行，而复制出来的第 6 份一定会跟前面 5 份漂移。
 *
 * 现在：数据（TARGETS）+ 一个循环（silenceAll）。加目标只加一条记录。
 * 对外只开 `silenceOne`（core.js 的 5 个具名导出转发到它）；`silenceAll` 是
 * 「一次跑完全部目标」的编排入口，当前无调用方，保持**文件内私有**（1.2.1
 * 死代码清零时去掉 `export`，实现原样保留 —— 它是这张数据表的批量入口）。
 *
 * ## 为什么不 import core.js
 *
 * core.js import 本模块。反向 import 会立刻造出 ARCH-1 禁止的环。
 * 所以「文件清单需要的那几个判定」由调用方注入（`host` 参数）：
 *
 *   host.isFile / host.isDir         宿主文件判定（含 asar 遮挡）
 *   host.keepSurfaceFile             宿主面门禁（allowTargetPath）
 *   host.findAiBase                  插件根（listSubprocessLocalFiles 要用）
 *
 * 这不是为了解耦而解耦 —— 是这三个判定本身依赖 core 的路径层，搬过来就成环。
 *
 * ## 返回值契约（改动前后必须逐一相同）
 *
 *   "skipped_not_win32"  非 Windows 早退（官方 phase-1 那条没有此早退）
 *   "missing"            没有候选文件，或候选文件全部读不出来
 *   "patched" / "already" / "pattern_miss"
 *   "error:<e>"          写失败
 *
 * ⚠️ 注意 `worseHit` 的排序是「取更差」：error > pattern_miss > missing > patched > already。
 * 也就是说 `patched` 与 `already` 只有在**没有任何一个文件**落进更差状态时才会浮上来 ——
 * 这条语义是历史行为，收敛成一等公民时一字未改。
 */
import { widenPhase1KeepFilter } from "../phase1-keep.js";

/**
 * 每个目标的 `apply(text)` 返回 `{ next?, hit }`：
 *   next 存在  → 写回文件，hit 参与 worseHit 归并
 *   next 不存在 → 不写，hit 参与归并
 *
 * 这样「already 但需要顺手修 import」这类分支（dshmarket）也能表达。
 */

// ── subprocess-local：spawn 补 windowsHide ────────────────────────────────
const SUBPROCESS_LOCAL = {
  key: "subprocess-local",
  resultKey: "subprocess",
  win32Only: true,
  marker: "[dsh-purge] subprocess-local windowsHide",
  needle:
    "\tconst child = spawn(program, args, {\n" +
    "\t\tcwd: spec.cwd,\n" +
    "\t\tenv,\n" +
    "\t\tstdio: [\n" +
    '\t\t\tstdinMode === "ignore" ? "ignore" : "pipe",\n' +
    '\t\t\toutMode === "inherit" ? "inherit" : "pipe",\n' +
    '\t\t\terrMode === "inherit" ? "inherit" : "pipe"\n' +
    "\t\t],\n" +
    '\t\tdetached: platform !== "win32"\n' +
    "\t});",
  replacement:
    "\tconst child = spawn(program, args, {\n" +
    "\t\tcwd: spec.cwd,\n" +
    "\t\tenv,\n" +
    "\t\tstdio: [\n" +
    '\t\t\tstdinMode === "ignore" ? "ignore" : "pipe",\n' +
    '\t\t\toutMode === "inherit" ? "inherit" : "pipe",\n' +
    '\t\t\terrMode === "inherit" ? "inherit" : "pipe"\n' +
    "\t\t],\n" +
    '\t\tdetached: platform !== "win32",\n' +
    "\t\t// [dsh-purge] subprocess-local windowsHide\n" +
    "\t\twindowsHide: true\n" +
    "\t});",
  list: listSubprocessLocalFiles,
};

// ── official-phase1：官方 phase-1 白名单放宽 ──────────────────────────────
// 唯一没有 win32 早退的目标：改的是白名单表达式，与平台无关。
const OFFICIAL_PHASE1 = {
  key: "official-phase1",
  resultKey: "officialPhase1",
  win32Only: false,
  list: listOfficialPhase1Files,
  /** 自定义改写：先判是否还有白名单符号，再判「没改动是已完成还是对不上」。 */
  apply(text) {
    if (!text.includes("PERSONA_SECTION_NAMES")) return { hit: "missing" };
    const next = widenPhase1KeepFilter(text);
    if (next === text && text.includes('startsWith("dshpg-")')) return { hit: "already" };
    if (next === text) return { hit: "pattern_miss" };
    return { next, hit: "patched" };
  },
};

// ── mnemon-git：把 resolveGitBranch 里的 git 子进程换成直接读 .git ────────
const MNEMON_GIT = {
  key: "mnemon-git",
  resultKey: "mnemon",
  win32Only: true,
  marker: "dsh-purge: never spawn git.exe here",
  needle: 'execFileSync("git", [',
  list: listMnemonIndexFiles,
  apply(text, target) {
    if (text.includes(target.marker)) return { hit: "already" };
    if (!text.includes(target.needle)) return { hit: "pattern_miss" };
    let next = text.replace(
      /function resolveGitBranch\(cwd\) \{[\s\S]*?\n\}\n\/\/#endregion\n\/\/#region src\/memory-view\.ts/,
      `${target.replacement}\n//#endregion\n//#region src/memory-view.ts`,
    );
    if (next === text) {
      next = text.replace(
        /function resolveGitBranch\(cwd\) \{[\s\S]*?\n\}(?=\n\/\/#endregion)/,
        target.replacement,
      );
    }
    if (next === text) return { hit: "pattern_miss" };
    return { next, hit: "patched" };
  },
  replacement: `function resolveGitBranch(cwd) {
	const root = cwd?.trim();
	if (root === void 0 || root === "") return void 0;
	// 不在这里 spawn git.exe，避免每轮对话弹控制台。
	try {
		let dir = root;
		for (let i = 0; i < 64; i++) {
			const gitPath = join(dir, ".git");
			let headFile = join(gitPath, "HEAD");
			if (existsSync(gitPath) && statSync(gitPath).isFile()) {
				const gitdir = readFileSync(gitPath, "utf8").trim().replace(/^gitdir:\\s*/i, "");
				headFile = isAbsolute(gitdir) ? join(gitdir, "HEAD") : join(dir, gitdir, "HEAD");
			}
			if (existsSync(headFile)) {
				const text = readFileSync(headFile, "utf8").trim();
				const m = /^ref:\\s*refs\\/heads\\/(.+)$/.exec(text);
				return m ? m[1] : void 0;
			}
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	} catch {}
	return;
}`,
};

// ── doctor-spawn：三处独立改写，任一已存在就不重复打 ──────────────────────
const DOCTOR_SPAWN = {
  key: "doctor-spawn",
  resultKey: "doctorSpawn",
  win32Only: true,
  list: listDoctorCliFiles,
  steps: [
    {
      marker: "[dsh-purge] doctor spawn windowsHide",
      needle: 'import { spawn } from "node:child_process";',
      replacement:
        'import { spawn as __dshPurgeSpawnOrig } from "node:child_process";\n' +
        "// [dsh-purge] doctor spawn windowsHide\n" +
        "function spawn(file, args, options) {\n" +
        "\tconst hide = (o) => {\n" +
        "\t\tif (o == null) return { windowsHide: true };\n" +
        "\t\tif (typeof o !== \"object\") return o;\n" +
        "\t\treturn { ...o, windowsHide: true };\n" +
        "\t};\n" +
        "\tif (typeof file === \"string\" && /(?:^|[\\\\/])cmd\\.exe$/i.test(file)) {\n" +
        "\t\t// Last-resort: never show a cmd console even if a caller slips through.\n" +
        "\t\toptions = hide(options);\n" +
        "\t}\n" +
        "\tif (args != null && !Array.isArray(args)) return __dshPurgeSpawnOrig(file, hide(args));\n" +
        "\treturn __dshPurgeSpawnOrig(file, args ?? [], hide(options));\n" +
        "}\n",
    },
    {
      marker: "[dsh-purge] dsh.cmd → node bin.js (no cmd.exe)",
      needle:
        'function dshSpawnSpec(binary, args, platform = process.platform) {\n' +
        '\tif (platform === "win32") {\n' +
        '\t\tif (binary.toLowerCase().endsWith(".cmd") || binary.toLowerCase().endsWith(".bat")) return {\n' +
        '\t\t\tcommand: "cmd.exe",\n' +
        '\t\t\targs: windowsCmdShimArgs(binary, args),\n' +
        '\t\t\twindowsVerbatimArguments: true\n' +
        "\t\t};",
      replacement:
        'function dshSpawnSpec(binary, args, platform = process.platform) {\n' +
        '\tif (platform === "win32") {\n' +
        '\t\tif (binary.toLowerCase().endsWith(".cmd") || binary.toLowerCase().endsWith(".bat")) {\n' +
        "\t\t\t// [dsh-purge] dsh.cmd → node bin.js (no cmd.exe)\n" +
        "\t\t\ttry {\n" +
        "\t\t\t\tconst dir = dirname(binary);\n" +
        "\t\t\t\tconst candidates = [\n" +
        '\t\t\t\t\tjoin(dir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),\n' +
        '\t\t\t\t\tjoin(dir, "..", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),\n' +
        "\t\t\t\t];\n" +
        "\t\t\t\tfor (const c of candidates) if (existsSync(c)) return { command: process.execPath, args: [c, ...args] };\n" +
        "\t\t\t} catch {}\n" +
        "\t\t\treturn {\n" +
        '\t\t\t\tcommand: "cmd.exe",\n' +
        "\t\t\t\targs: windowsCmdShimArgs(binary, args),\n" +
        "\t\t\t\twindowsVerbatimArguments: true\n" +
        "\t\t\t};\n" +
        "\t\t}",
    },
    {
      marker: "[dsh-purge] doctor launch stdio no-inherit",
      needle:
        "const child = spawnDsh(realDsh, options.argv, {\n" +
        "\t\tstdio: [\n" +
        '\t\t\t"inherit",\n' +
        '\t\t\t"inherit",\n' +
        '\t\t\t"pipe"\n' +
        "\t\t],",
      replacement:
        "const child = spawnDsh(realDsh, options.argv, {\n" +
        "\t\t// [dsh-purge] doctor launch stdio no-inherit\n" +
        "\t\tstdio: [\n" +
        '\t\t\t"ignore",\n' +
        '\t\t\t"ignore",\n' +
        '\t\t\t"pipe"\n' +
        "\t\t],\n" +
        "\t\twindowsHide: true,",
    },
  ],
  /** 三步按序尝试；只要文件有任何改动就算 patched，否则按「有没有 marker」判 already / pattern_miss。 */
  apply(text, target) {
    let next = text;
    for (const step of target.steps) {
      if (!next.includes(step.marker) && next.includes(step.needle)) {
        next = next.replace(step.needle, step.replacement);
      }
    }
    if (next === text) {
      const anyMarker = target.steps.some((step) => text.includes(step.marker));
      return { hit: anyMarker ? "already" : "pattern_miss" };
    }
    return { next, hit: "patched" };
  },
};

// ── dshmarket-restart：重启改走 node bin.js ───────────────────────────────
const MARKET_RESTART = {
  key: "market-restart",
  resultKey: "market",
  win32Only: true,
  marker: "[dsh-purge] market restart → node bin.js (no powershell/dsh.cmd)",
  importNeedle: "import { tmpdir } from 'node:os';\nimport { join } from 'node:path';",
  importReplacement:
    "import { existsSync } from 'node:fs';\n" +
    "import { tmpdir } from 'node:os';\n" +
    "import { dirname, join } from 'node:path';",
  needle:
    "export function respawnInvocation(launch, platform = process.platform) {\n" +
    "    if (platform !== 'win32') {\n" +
    "        return { file: launch.file, args: launch.args, viaShell: launch.viaShell, detached: true };\n" +
    "    }\n",
  replacement:
    "export function respawnInvocation(launch, platform = process.platform) {\n" +
    "    if (platform !== 'win32') {\n" +
    "        return { file: launch.file, args: launch.args, viaShell: launch.viaShell, detached: true };\n" +
    "    }\n" +
    "    // [dsh-purge] market restart → node bin.js (no powershell/dsh.cmd)\n" +
    "    {\n" +
    "        const resolveBin = (file) => {\n" +
    "            try {\n" +
    "                if (typeof file === 'string' && /[\\\\/]bin\\.js$/i.test(file) && existsSync(file))\n" +
    "                    return { file: nodeExecutable(), args: launch.args, viaShell: false, detached: true };\n" +
    "                const dir = typeof file === 'string' ? dirname(file) : '';\n" +
    "                const candidates = [\n" +
    "                    join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),\n" +
    "                    join(dir, '..', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),\n" +
    "                ];\n" +
    "                for (const c of candidates) if (existsSync(c))\n" +
    "                    return { file: nodeExecutable(), args: [c, ...launch.args], viaShell: false, detached: true };\n" +
    "            } catch {}\n" +
    "            return null;\n" +
    "        };\n" +
    "        if (!launch.viaShell) {\n" +
    "            const hit = resolveBin(launch.args?.find?.((a) => typeof a === 'string' && /[\\\\/]bin\\.js$/i.test(a)) || launch.file);\n" +
    "            if (hit) return hit;\n" +
    "            return { file: launch.file, args: launch.args, viaShell: false, detached: true };\n" +
    "        }\n" +
    "        const shim = /\\.(?:cmd|bat)$/iu.test(launch.file) ? launch.file : `${launch.file}.cmd`;\n" +
    "        const hit = resolveBin(shim);\n" +
    "        if (hit) return hit;\n" +
    "    }\n",
  list: listDshmarketRestartFiles,
  apply(text, target) {
    let next = text;
    // import 修正先做：即使主体已打好，也把缺的 existsSync/dirname 补上。
    if (!next.includes("existsSync") && next.includes(target.importNeedle)) {
      next = next.replace(target.importNeedle, target.importReplacement);
    }
    if (next.includes(target.marker)) {
      return next === text ? { hit: "already" } : { next, hit: "already" };
    }
    if (!next.includes(target.needle)) return { hit: "pattern_miss" };
    next = next.replace(target.needle, target.replacement);
    if (next === text) return { hit: "pattern_miss" };
    return { next, hit: "patched" };
  },
};

/** 简单目标（marker → already；needle 缺 → pattern_miss；改不动 → pattern_miss）。 */
function simpleApply(text, target) {
  if (text.includes(target.marker)) return { hit: "already" };
  if (!text.includes(target.needle)) return { hit: "pattern_miss" };
  const next = text.replace(target.needle, target.replacement);
  if (next === text) return { hit: "pattern_miss" };
  return { next, hit: "patched" };
}

export const SILENCE_TARGETS = Object.freeze([
  SUBPROCESS_LOCAL,
  OFFICIAL_PHASE1,
  MNEMON_GIT,
  DOCTOR_SPAWN,
  MARKET_RESTART,
]);

// ══ 文件清单 ═══════════════════════════════════════════════════════════
// 每个目标「哪些文件算候选」的规则不同，这些是真正的差异，不是重复。

/**
 * npm-global 与 profile 下的嵌套副本，外加 bin.js 所在目录。
 *
 * 这里按**目录名**枚举 profile，没有硬编码 "web" —— 但枚举结果可能落到
 * `profiles/web`，所以 push 必须过 `keepSurfaceFile`（= isFile + allowTargetPath）。
 * 只判 isFile 会让 web-profile 的遗留副本进候选清单，而 pathZone 判它
 * `web-profile` 并拒绝写入（DELETE-4），结果是白跑一趟还把状态归并成
 * pattern_miss。三个清单函数用同一套门禁，不再各写一份。
 */
export function listSubprocessLocalFiles(dshHome, host) {
  const { path, fs, isDir, findAiBase, keepSurfaceFile } = host;
  const out = [];
  const push = (fp) => {
    if (keepSurfaceFile(fp) && !out.includes(fp)) out.push(fp);
  };
  const aiBase = findAiBase();
  if (aiBase) {
    push(path.join(aiBase, "dsh-subprocess-local", "lib", "index.js"));
    push(path.join(aiBase, "dsh", "node_modules", "@deepseek-ai", "dsh-subprocess-local", "lib", "index.js"));
  }
  const profilesRoot = path.join(dshHome, "profiles");
  if (isDir(profilesRoot)) {
    try {
      for (const name of fs.readdirSync(profilesRoot)) {
        push(
          path.join(
            profilesRoot,
            name,
            "node_modules",
            "@deepseek-ai",
            "dsh-subprocess-local",
            "lib",
            "index.js",
          ),
        );
      }
    } catch {}
  }
  // 从 bin.js 所在目录向上找。
  try {
    const bin = process.argv[1];
    if (typeof bin === "string" && /[\\/]bin\.js$/i.test(bin)) {
      const root = path.dirname(path.dirname(bin));
      push(path.join(root, "node_modules", "@deepseek-ai", "dsh-subprocess-local", "lib", "index.js"));
    }
  } catch {}
  return out;
}

/** 官方 dsh-agent-instructions 的两份入口。只查 desktop profile（web 面已移除）。 */
export function listOfficialPhase1Files(dshHome, host) {
  const { path, keepSurfaceFile, findAiBase } = host;
  const out = [];
  const push = (fp) => {
    if (keepSurfaceFile(fp) && !out.includes(fp)) out.push(fp);
  };
  const addBase = (aiBase) => {
    if (!aiBase) return;
    push(path.join(aiBase, "dsh-agent-instructions", "lib", "index.js"));
    push(path.join(aiBase, "dsh-agent-instructions", "lib", "bootstrap.js"));
  };
  try { addBase(findAiBase()); } catch { /* 启动时还没定位到宿主 */ }
  const profilesRoot = path.join(dshHome, "profiles");
  // 只补丁 desktop profile。`profiles/web` 里的旧包不再被主动发现 ——
  // web CLI 宿主面已移除，继续往那里写只会制造"看起来还能用但永远不更新"的僵尸状态（DELETE-4）。
  // 注意：pathZone 仍把 profiles/web 判成 web-profile 并**拒绝写入**，
  // 那是保护遗留数据不被误改，与本处的"不再主动发现"不冲突。
  addBase(path.join(profilesRoot, "desktop", "node_modules", "@deepseek-ai"));
  return out;
}

/** dsh-mnemon 的 lib/index.js，含 @scope/pkg/node_modules 嵌套。 */
export function listMnemonIndexFiles(dshHome, host) {
  const { path, fs, isDir, keepSurfaceFile } = host;
  const out = [];
  const push = (fp) => {
    if (keepSurfaceFile(fp) && !out.includes(fp)) out.push(fp);
  };
  // 只查 desktop profile（web CLI 宿主面已移除）。
  push(path.join(dshHome, "profiles", "desktop", "node_modules", "dsh-mnemon", "lib", "index.js"));
  // 含 dsh-web-all 等套件嵌套。
  const profilesRoot = path.join(dshHome, "profiles");
  if (isDir(profilesRoot)) {
    let profiles = [];
    try {
      profiles = fs.readdirSync(profilesRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      profiles = [];
    }
    for (const ent of profiles) {
      const base = path.join(profilesRoot, ent.name, "node_modules");
      push(path.join(base, "dsh-mnemon", "lib", "index.js"));
      // @scope/pkg/node_modules/dsh-mnemon
      try {
        for (const scope of fs.readdirSync(base, { withFileTypes: true })) {
          if (!scope.isDirectory()) continue;
          const scopeDir = path.join(base, scope.name);
          if (scope.name.startsWith("@")) {
            for (const pkg of fs.readdirSync(scopeDir, { withFileTypes: true })) {
              if (!pkg.isDirectory()) continue;
              push(path.join(scopeDir, pkg.name, "node_modules", "dsh-mnemon", "lib", "index.js"));
            }
          } else {
            push(path.join(scopeDir, "node_modules", "dsh-mnemon", "lib", "index.js"));
          }
        }
      } catch {}
    }
  }
  return out;
}

/** doctor 的 cli.mjs。desktop 固定一条 + 每个 profile 扫一遍（同样过宿主面门禁）。 */
export function listDoctorCliFiles(dshHome, host) {
  const { path, fs, isDir, keepSurfaceFile } = host;
  const out = [];
  const push = (fp) => {
    if (keepSurfaceFile(fp) && !out.includes(fp)) out.push(fp);
  };
  const profilesRoot = path.join(dshHome, "profiles");
  push(path.join(profilesRoot, "desktop", "node_modules", "@linxin666", "dsh-doctor", "lib", "cli.mjs"));
  if (isDir(profilesRoot)) {
    try {
      for (const ent of fs.readdirSync(profilesRoot, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const base = path.join(profilesRoot, ent.name, "node_modules", "@linxin666", "dsh-doctor", "lib", "cli.mjs");
        push(base);
      }
    } catch {}
  }
  return out;
}

/** dshmarket 的 lib/restart.js。desktop 固定一条 + 每个 profile 扫一遍（同样过宿主面门禁）。 */
export function listDshmarketRestartFiles(dshHome, host) {
  const { path, fs, isDir, keepSurfaceFile } = host;
  const out = [];
  const push = (fp) => {
    if (keepSurfaceFile(fp) && !out.includes(fp)) out.push(fp);
  };
  const profilesRoot = path.join(dshHome, "profiles");
  push(path.join(profilesRoot, "desktop", "node_modules", "dshmarket", "lib", "restart.js"));
  if (isDir(profilesRoot)) {
    try {
      for (const name of fs.readdirSync(profilesRoot)) {
        push(path.join(profilesRoot, name, "node_modules", "dshmarket", "lib", "restart.js"));
      }
    } catch {}
  }
  return out;
}

/** 文件清单按 key 取（revertCmdFlash 也要用同一套清单）。 */
export function listTargetFiles(key, dshHome, host) {
  const target = SILENCE_TARGETS.find((t) => t.key === key);
  if (!target) throw new Error(`unknown silence target: ${key}`);
  return target.list(dshHome, host);
}

// ══ 执行器 ═════════════════════════════════════════════════════════════

/**
 * 状态归并：**取更差的那个**。
 *
 * 排序 error < pattern_miss < missing < patched < already（rank 越小越差），
 * 所以「一个文件成功、另一个对不上」时，对外报的是对不上 —— 坏结果不被成功覆盖。
 *
 * 这是历史语义（状态归并原语），改名时一字未动。旧名里带一个第三方插件的前缀，
 * 但那名字在撒谎：本函数被 6 个与该插件无关的目标复用，是通用的状态归并原语。
 */
export function worseHit(current, next) {
  const rank = (hit) => {
    if (String(hit).startsWith("error:")) return 0;
    if (hit === "pattern_miss") return 1;
    if (hit === "missing") return 2;
    if (hit === "patched") return 3;
    if (hit === "already") return 4;
    return 2;
  };
  return rank(next) < rank(current) ? next : current;
}

/** 对单个目标跑一遍。 */
function runTarget(target, dshHome, host) {
  if (target.win32Only && process.platform !== "win32") return "skipped_not_win32";
  const files = target.list(dshHome, host);
  if (files.length === 0) return "missing";
  const apply = target.apply ?? simpleApply;
  let hit = "missing";
  for (const fp of files) {
    let text;
    try {
      text = host.fs.readFileSync(fp, "utf8");
    } catch {
      continue;
    }
    const plan = apply(text, target);
    if (plan.next === undefined) {
      hit = worseHit(hit, plan.hit);
      continue;
    }
    try {
      host.fs.writeFileSync(fp, plan.next, "utf8");
      hit = worseHit(hit, plan.hit);
    } catch (e) {
      hit = worseHit(hit, `error:${e}`);
    }
  }
  return hit;
}

/**
 * 跑全部目标。返回 `{ subprocess, officialPhase1, mnemon, doctorSpawn, market }`。
 *
 * 文件内私有（1.2.1 去掉 `export`）：当前仓库没有调用方 —— core.js 走的是
 * `silenceOne` 的按目标粒度。保留是因为它是 `SILENCE_TARGETS` 的批量入口，
 * 加目标时用它做一次性自检比逐个调 `silenceOne` 更省事。
 *
 * @param {string} dshHome
 * @param {{path, fs, isFile, isDir, keepSurfaceFile, findAiBase}} host
 */
function silenceAll(dshHome, host) {
  const out = {};
  for (const target of SILENCE_TARGETS) out[target.resultKey] = runTarget(target, dshHome, host);
  return out;
}

/** 跑单个目标（core 的 5 个具名导出转发到这里，导出面保持不变）。 */
export function silenceOne(key, dshHome, host) {
  const target = SILENCE_TARGETS.find((t) => t.key === key);
  if (!target) throw new Error(`unknown silence target: ${key}`);
  return runTarget(target, dshHome, host);
}
