/**
 * lib/host/paths.js — 宿主安装路径的唯一答案源，core.js 只能向下依赖它。
 * 宿主安装路径探测（从 core.js 整块搬来，逐字未改）。
 *
 * ## 这一层是什么
 *
 * 「这个宿主装在哪」的全部答案：插件根（aiBase）、主目录（dshHome）、
 * 启动器目录（shimDir）、npm 前缀（prefix），以及 pnpm 虚拟仓 / 嵌套副本
 * 这些非标准布局的兜底探测。
 *
 * ## 依赖方向（ARCH-2）
 *
 * 本模块**不许** import `patch/` `shim/` `prompt/` `redteam/`，也不许 import
 * `core.js` —— 它是 `core.js` 的下游，反向依赖会立刻造出环。
 *
 * 现在依赖三个叶子模块：
 *   - `../desktop.js`     安装树判定
 *   - `../extract-asar.js` hostFs（asar 遮挡感知的文件系统）
 *   - `../surface.js`     宿主面判定
 *
 * ⚠️ `desktop.js` 是必须保留的依赖：`findDshHome` 要问「哪些目录像
 * 桌面安装」「当前进程是不是官方 exe」。这几个判定就住在 desktop.js 里，
 * 搬过来只会把 1666 行再复制一份。
 */
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as desktop from "../desktop.js";
import { hostFs, withFsProbeCache } from "../extract-asar.js";
import { detectSurface, isDesktop } from "../surface.js";

const fs = hostFs;

const isWindows = process.platform === "win32";
const SHIM_NAMES = ["dsh.cmd", "dsh.ps1", "dsh"];
/** @type {import("node:child_process").ExecFileSyncOptionsWithStringEncoding} */
const HIDDEN_EXEC = {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
  windowsHide: true,
  timeout: 8000,
};

/**
 * Electron 在主进程上挂了 `resourcesPath`，Node 的类型里没有它。
 * @returns {string} 空串表示不在 Electron 里
 */
function electronResourcesPath() {
  const raw = /** @type {{resourcesPath?: string}} */ (process).resourcesPath;
  return raw ? path.normalize(raw) : "";
}

/** 本模块所在目录（lib/host）。 */
const HOST_MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
/** 插件根（lib/）—— 与 core.js 里的 PLUGIN_DIR 同值。 */
const PLUGIN_DIR = path.dirname(HOST_MODULE_DIR);

/**
 * 跑一个同步子进程并取 stdout（失败返回空串）。
 * @param {string} bin 可执行文件
 * @param {string[]} args 参数
 * @returns {string} 去尾空白的 stdout
 */
function execFileText(bin, args) {
  try {
    return execFileSync(bin, args, HIDDEN_EXEC).trim();
  } catch {
    return "";
  }
}

/** 当前 node 自带的 npm-cli.js（找不到返回空串）。 */
function npmCliJs() {
  const cli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  return isFile(cli) ? cli : "";
}

/**
 * 跑一次 npm 查询。
 * @param {string[]} args npm 子命令
 * @returns {string}
 */
function npmQuery(args) {
  // Windows 不走 npm.cmd，避免弹出控制台。
  const cli = npmCliJs();
  if (cli) return execFileText(process.execPath, [cli, ...args]);
  if (isWindows) return "";
  return execFileText("npm", args);
}

/** PATH 里的目录列表。 */
function pathEnvDirs() {
  const raw = process.env.PATH || process.env.Path || "";
  return raw.split(path.delimiter).map((d) => d.trim()).filter(Boolean);
}

const memo = {
  prefix: { ready: false, value: null },
  shim: { ready: false, value: null },
  desktopShim: { ready: false, value: null },
  ai: { ready: false, value: null },
};

function remember(slot, compute) {
  if (memo[slot].ready) return memo[slot].value;
  const value = compute();
  // 启动早期可能还看不到宿主目录。空结果不缓存，否则整次进程都是 0/52、每条跳过。
  if (slot === "ai" && !value) return value;
  memo[slot] = { ready: true, value };
  return value;
}

/** 丢弃全部路径探测缓存（宿主换目录后要重探）。 */
export function resetPathMemo() {
  for (const slot of Object.keys(memo)) memo[slot] = { ready: false, value: null };
}

/**
 * 只清「上次没找到插件根」这个失败缓存，让下次 findAiBase 重新探测。
 *
 * 为什么单独一个函数：`remember` 对 `ai` 槽故意不缓存空结果，但启动早期
 * 一旦探到过 `{ready:true, value:null}`（构造期半成品），apply 时就该重探。
 * core.js 的 applyRuntimeEnv 原本直接改 memo.ai，现在 memo 住在本模块里。
 */
export function clearAiBaseMissMemo() {
  if (memo.ai.ready && !memo.ai.value) memo.ai = { ready: false, value: null };
}

/** 丢弃桌面定位缓存，并连带清掉路径探测缓存。 */
export function clearDesktopLocateCache() {
  try { desktop.clearDesktopLocateCache(); } catch { /* ignore */ }
  resetPathMemo();
}

/**
 * 是文件（asar 密封路径一律判否）。
 * @param {string} fp
 * @returns {boolean}
 */
export function isFile(fp) {
  try {
    if (desktop.isAsarSealedPath(fp)) return false;
    return fs.existsSync(fp) && fs.statSync(fp).isFile();
  } catch {
    return false;
  }
}

/**
 * 是目录（asar 密封路径一律判否）。
 * @param {string} fp
 * @returns {boolean}
 */
export function isDir(fp) {
  try {
    if (desktop.isAsarSealedPath(fp)) return false;
    return fs.existsSync(fp) && fs.statSync(fp).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 过滤掉不存在的目录并去重（按 normalize 后的路径）。
 * @param {string[]} paths
 * @returns {string[]}
 */
function collectDirs(paths) {
  const seen = new Set();
  const out = [];
  for (const p of paths) {
    if (!p || !isDir(p)) continue;
    const n = path.normalize(p);
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * 是不是一个 @deepseek-ai 插件根。
 * @param {string} p
 * @returns {boolean}
 */
export function isAiBase(p) {
  return p && isDir(path.join(p, "dsh-agent-instructions", "lib"));
}

/**
 * 建目录（失败静默 —— 调用方都是「尽力而为」的备份目录）。
 * @param {string} dir
 * @returns {void}
 */
export function ensureDirSync(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
}

/**
 * 一个启动器文件的备份路径。
 *
 * 密封 bin（桌面官方 CLI）里的文件不能就地写 `.dshpurge.bak`，
 * 备份要落到 `$DSH_HOME/dsh-purge/shim-backups/`，路径用 sha1 摘要区分。
 *
 * @param {string} fp 原文件
 * @returns {string} 备份文件路径
 */
export function shimBackupPath(fp) {
  const dir = path.dirname(fp);
  if (!isDesktopCommandRuntimeDir(dir)) return fp + ".dshpurge.bak";
  const bakRoot = path.join(findDshHome(), "dsh-purge", "shim-backups");
  ensureDirSync(bakRoot);
  const digest = createHash("sha1").update(path.normalize(fp)).digest("hex").slice(0, 20);
  const bak = path.join(bakRoot, `${path.basename(fp)}.${digest}.bak`);
  // 备份路径不能落在密封 bin 内。
  if (path.normalize(path.dirname(bak)).toLowerCase() === path.normalize(dir).toLowerCase()) {
    return path.join(os.tmpdir(), `dsh-purge-${path.basename(fp)}.${digest}.bak`);
  }
  return bak;
}

/**
 * 一个路径是不是「打包后的桌面 dsh 根」。
 * @param {string} p
 * @returns {boolean}
 */
function isPackagedDesktopDshRoot(p) {
  if (!p) return false;
  const n = String(p).replace(/\\/g, "/").toLowerCase();
  if (n.includes("/resources/app/dsh")) return true;
  if (n.includes("deepseekharnessdesktop")) return true;
  try {
    return desktop.isInsideDesktopInstall(p);
  } catch {
    return false;
  }
}

const AI_RESOLVE_IDS = [
  "@deepseek-ai/dsh-agent-instructions/package.json",
  "@deepseek-ai/dsh-agent-instructions",
  "@deepseek-ai/dsh/package.json",
  "@deepseek-ai/dsh-base/package.json",
  "@deepseek-ai/dsh-web-app/package.json",
];

function firstAiBase(cands) {
  for (const cand of cands) {
    if (cand && isAiBase(cand)) return path.normalize(cand);
  }
  return null;
}

function aiBaseGuessesAround(dir) {
  if (!dir) return [];
  const nested = nestedAiPath();
  return [
    dir,
    path.join(dir, "@deepseek-ai"),
    path.join(dir, "node_modules", "@deepseek-ai"),
    path.join(dir, "node_modules", nested),
    path.join(dir, "dsh", "node_modules", "@deepseek-ai"),
    path.join(dir, "dsh", "node_modules", nested),
    path.join(dir, "..", "node_modules", "@deepseek-ai"),
    path.join(dir, "..", "node_modules", nested),
    path.join(dir, "..", "..", "node_modules", "@deepseek-ai"),
    path.join(dir, "..", "..", "node_modules", nested),
    ...pnpmHoistAiBases(dir),
  ];
}

function walkAncestorsForAiBase(start, maxUp = 10) {
  let dir = path.normalize(start);
  for (let i = 0; i < maxUp; i++) {
    const hit = firstAiBase(aiBaseGuessesAround(dir));
    if (hit) return hit;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function requireFrom(fromFile) {
  if (!fromFile) return null;
  try {
    let spec = fromFile;
    if (isDir(fromFile)) {
      const pkg = path.join(fromFile, "package.json");
      spec = isFile(pkg) ? pkg : path.join(fromFile, "index.js");
    }
    return createRequire(spec);
  } catch {
    return null;
  }
}

function findAiBaseFromRequire(fromFile) {
  const req = requireFrom(fromFile);
  if (!req) return null;
  for (const id of AI_RESOLVE_IDS) {
    try {
      const resolved = req.resolve(id);
      const hit = walkAncestorsForAiBase(path.dirname(resolved), 8);
      if (hit) return hit;
    } catch {
    }
  }
  return null;
}

function findAiBaseFromRunningProcess() {
  const starts = [];
  if (process.argv[1]) {
    try { starts.push(path.resolve(process.argv[1])); } catch {}
  }
  starts.push(PLUGIN_DIR);
  try { starts.push(path.resolve(process.cwd())); } catch {}
  for (const start of starts) {
    const fromReq = findAiBaseFromRequire(start);
    if (fromReq) return fromReq;
    const fromWalk = walkAncestorsForAiBase(isDir(start) ? start : path.dirname(start));
    if (fromWalk) return fromWalk;
  }
  return null;
}

function findAiBaseFromDshHome(dshHome) {
  if (!dshHome || !isDir(dshHome)) return null;
  const profiles = path.join(dshHome, "profiles");
  const names = [];
  if (isDir(profiles)) {
    try { names.push(...fs.readdirSync(profiles)); } catch {}
  }
  const direct = firstAiBase([
    path.join(dshHome, "node_modules", "@deepseek-ai"),
    path.join(dshHome, "node_modules", nestedAiPath()),
    ...names.map((n) => path.join(profiles, n, "node_modules", "@deepseek-ai")),
    ...names.map((n) => path.join(profiles, n, "node_modules", nestedAiPath())),
  ]);
  if (direct) return direct;
  const fromPnpm = firstAiBase([
    ...pnpmHoistAiBases(dshHome),
    ...names.flatMap((n) => pnpmHoistAiBases(path.join(profiles, n))),
  ]);
  if (fromPnpm) return fromPnpm;
  for (const n of names) {
    const hit = findAiBaseFromRequire(path.join(profiles, n, "package.json"));
    if (hit) return hit;
  }
  return null;
}

/**
 * 这个目录里有没有 dsh 启动器（dsh.cmd / dsh.ps1 / dsh）。
 * @param {string} dir
 * @returns {boolean}
 */
export function dirHasDshLauncher(dir) {
  if (!dir || !isDir(dir)) return false;
  return SHIM_NAMES.some((name) => isFile(path.join(dir, name)));
}

/**
 * 是不是桌面官方 CLI 的密封运行时目录。
 * @param {string} dir
 * @returns {boolean}
 */
export function isDesktopCommandRuntimeDir(dir) {
  return desktop.isSealedRuntimeDir(dir);
}

/**
 * 桌面官方 CLI 的密封运行时目录清单（PATH + 桌面探测）。
 * @returns {string[]}
 */
export function listDesktopCommandRuntimeDirs() {
  return collectDirs([
    ...pathEnvDirs(),
    ...desktop.listSealedRuntimeBins(),
  ]).filter(isDesktopCommandRuntimeDir);
}

/**
 * 前缀 → 启动器可能所在的目录（prefix 自身与其 bin/）。
 * @param {string} prefix
 * @returns {string[]}
 */
export function launcherDirsOf(prefix) {
  if (!prefix) return [];
  const n = path.normalize(prefix);
  if (path.basename(n) === "bin") return [n];
  return [n, path.join(n, "bin")];
}

function guessedPrefixDirs() {
  const home = os.homedir();
  const appdata = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const localapp = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  return [
    path.join(home, "npm-global"),
    path.join(appdata, "npm"),
    path.join(localapp, "npm"),
    path.join(home, ".npm-global"),
    "/usr/local",
    "/usr",
  ];
}

function guessedShimDirs() {
  const prefixGuesses = guessedPrefixDirs();
  return [
    ...prefixGuesses,
    ...prefixGuesses.map((p) => path.join(p, "bin")),
    "/usr/local/bin",
    "/usr/bin",
  ];
}

function nestedAiPath() {
  return path.join("@deepseek-ai", "dsh", "node_modules", "@deepseek-ai");
}

// .modules.yaml 或 .pnpm 才当 pnpm；npm/yarn/bun 不走 hoist。
function isPnpmNodeModules(nmDir) {
  if (!nmDir || !isDir(nmDir)) return false;
  return isFile(path.join(nmDir, ".modules.yaml")) || isDir(path.join(nmDir, ".pnpm"));
}

function pnpmVirtualStoreDir(root) {
  if (!root) return null;
  const nm = path.join(root, "node_modules");
  if (!isPnpmNodeModules(nm)) return null;
  const yaml = path.join(nm, ".modules.yaml");
  if (isFile(yaml)) {
    try {
      const text = fs.readFileSync(yaml, "utf8");
      const m = text.match(/^virtualStoreDir:\s*(.+)$/m);
      if (m) {
        // M35:先剥 ` # comment` 再剥引号。pnpm 的 .modules.yaml 可能带尾注释。
        let raw = m[1].replace(/\s+#.*$/, "").trim();
        raw = raw.replace(/^['"]|['"]$/g, "");
        if (raw) return path.isAbsolute(raw) ? path.normalize(raw) : path.normalize(path.join(root, raw));
      }
    } catch {}
  }
  const fallback = path.join(nm, ".pnpm");
  return isDir(fallback) ? fallback : null;
}

function pnpmProjectRootNear(base) {
  if (!base) return null;
  let dir = path.normalize(base);
  for (let i = 0; i < 4; i++) {
    const nm = path.basename(dir) === "node_modules" ? dir : path.join(dir, "node_modules");
    if (isPnpmNodeModules(nm)) {
      return path.basename(dir) === "node_modules" ? path.dirname(dir) : dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function pnpmHoistAiBases(base) {
  const project = pnpmProjectRootNear(base);
  if (!project) return [];
  const store = pnpmVirtualStoreDir(project);
  if (!store) return [];
  return [path.join(store, "node_modules", "@deepseek-ai")];
}

function aiBaseGuessesFor(base) {
  if (!base) return [];
  const nested = nestedAiPath();
  return [
    path.join(base, "node_modules", nested),
    path.join(base, "lib", "node_modules", nested),
    path.join(base, "node_modules", "@deepseek-ai"),
    path.join(base, "lib", "node_modules", "@deepseek-ai"),
    path.join(base, "..", "lib", "node_modules", nested),
    path.join(base, "..", "node_modules", nested),
    ...pnpmHoistAiBases(base),
  ];
}

/**
 * 这个目录像不像 dsh 主目录（`.dsh` / `dsh-home`）。
 * @param {string} dir
 * @returns {boolean}
 */
export function isDshHomeDir(dir) {
  if (!dir || !isDir(dir)) return false;
  const base = path.basename(path.normalize(dir)).toLowerCase();
  return base === ".dsh" || base === "dsh-home";
}

function homeHasHarnessData(dir) {
  if (!dir || !isDir(dir)) return false;
  return isFile(path.join(dir, "prompt-inject.md"))
    || isDir(path.join(dir, "profiles"))
    || isFile(path.join(dir, "cordis.patch.yml"));
}

function desktopHomeCandidates() {
  const out = [];
  const push = (dir) => {
    if (!dir) return;
    const root = path.normalize(dir);
    out.push(root);
    out.push(path.join(root, ".dsh"));
    out.push(path.join(root, "dsh-home"));
  };
  try {
    const exe = desktop.findDesktopAppExecutable();
    if (exe) push(path.dirname(exe));
  } catch { /* ignore */ }
  try {
    const resources = electronResourcesPath();
    if (resources) push(path.dirname(resources));
  } catch { /* ignore */ }
  try {
    for (const root of desktop.listDesktopInstallRoots()) push(root);
  } catch { /* ignore */ }
  for (const guess of desktopDshHomeGuesses()) out.push(guess);
  const seen = new Set();
  return out.filter((item) => {
    const key = path.normalize(item).replace(/\\/g, "/").toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 便携布局：启动器旁边有 `.dsh` 就认它。
 * @param {string} shimDir 启动器目录
 * @param {string} prefix npm 前缀
 * @returns {string|null}
 */
export function portableHomeFromLauncher(shimDir, prefix) {
  const bases = [];
  if (shimDir) {
    bases.push(shimDir, path.join(shimDir, ".."), path.join(shimDir, "..", ".."));
  }
  if (prefix) {
    bases.push(prefix, path.join(prefix, ".."));
  }
  const seen = new Set();
  for (const base of bases) {
    const cand = path.normalize(path.join(base, ".dsh"));
    if (seen.has(cand)) continue;
    seen.add(cand);
    if (isDshHomeDir(cand)) return cand;
  }
  return null;
}

/**
 * 桌面端主目录的候选（给 applyRuntimeEnv / listPiAiApiFiles 复用）。
 * @returns {string[]}
 */
export function desktopDshHomeGuesses() {
  const home = os.homedir();
  // L32:按 platform 过滤。Linux 下不该出 macOS/Windows 路径,否则 isDshHomeDir 一堆噪声。
  if (process.platform === "darwin") {
    return [path.join(home, "Library", "Application Support", "DeepSeek Harness", "dsh-home")];
  }
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    const localapp = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return [
      path.join(appdata, "DeepSeek Harness", "dsh-home"),
      path.join(localapp, "DeepSeek Harness", "dsh-home"),
    ];
  }
  // linux 默认空,官方桌面壳没有 linux 官方分发
  return [];
}

/**
 * 找 dsh 主目录。
 *
 * 顺序：DSH_HOME → 桌面进程旁 .dsh/dsh-home → 启动器旁 .dsh → ~/.dsh。
 * 不写死盘符；桌面端不借用 Web 启动器旁的主目录。
 *
 * @param {{env?: Record<string,string|undefined>, shimDir?: string|null, prefix?: string|null}} [options]
 * @returns {string} 主目录绝对路径（可能不存在）
 */
export function findDshHome(options = {}) {
  const env = options.env ?? process.env;
  const fromEnv = env.DSH_HOME;
  if (fromEnv && String(fromEnv).trim()) return path.normalize(fromEnv.trim());
  const desktopHost = isDesktop(options);
  if (desktopHost) {
    const found = [];
    for (const cand of desktopHomeCandidates()) {
      if (isDshHomeDir(cand)) found.push(path.normalize(cand));
    }
    const unix = path.normalize(path.join(os.homedir(), ".dsh"));
    const usable = found.find((cand) => homeHasHarnessData(cand));
    if (usable) return usable;
    if (isDir(unix) && homeHasHarnessData(unix)) return unix;
    if (found.length) return found[0];
  }
  const shimDir = options.shimDir !== undefined ? options.shimDir : findShimDir();
  const prefix = options.prefix !== undefined ? options.prefix : findNpmPrefix();
  if (!desktopHost) {
    const portable = portableHomeFromLauncher(shimDir, prefix);
    if (portable) return portable;
  }
  const unix = path.join(os.homedir(), ".dsh");
  if (isDir(unix)) return unix;
  const wslWin = findWslWindowsDshHome(env);
  if (wslWin) return wslWin;
  return unix;
}

function findWslWindowsDshHome(env = process.env) {
  if (process.platform !== "linux") return "";
  const rel = env.WSL_DISTRO_NAME || env.WSLENV;
  if (!rel && !isDir("/mnt/c/Users")) return "";
  const users = "/mnt/c/Users";
  if (!isDir(users)) return "";
  let names = [];
  try {
    names = fs.readdirSync(users);
  } catch {
    return "";
  }
  for (const name of names) {
    if (name === "Public" || name === "Default" || name === "Default User" || name === "All Users") continue;
    const cand = path.join(users, name, ".dsh");
    if (isDir(cand)) return path.normalize(cand);
  }
  return "";
}

/**
 * 找 npm 全局前缀。
 * @returns {string|null}
 */
export function findNpmPrefix() {
  return remember("prefix", () => {
    const fromPath = pathEnvDirs().filter(dirHasDshLauncher);
    const collected = collectDirs([
      ...fromPath.map((dir) => (path.basename(dir) === "bin" ? path.dirname(dir) : dir)),
      ...guessedPrefixDirs(),
    ]);
    const withDsh = collected.filter((p) => launcherDirsOf(p).some(dirHasDshLauncher));
    if (withDsh[0]) return withDsh[0];
    const fromNpm = collectDirs([
      npmQuery(["prefix", "-g"]),
      npmQuery(["config", "get", "prefix"]),
    ]);
    const npmHit = fromNpm.filter((p) => launcherDirsOf(p).some(dirHasDshLauncher));
    return npmHit[0] || fromNpm[0] || collected[0] || null;
  });
}

/**
 * 桌面官方 CLI：resources/runtime/cli/bin 里的 dsh.cmd / dsh.ps1 / dsh。
 * @returns {string|null}
 */
export function findDesktopShimDir() {
  return remember("desktopShim", () => {
    const exe = desktop.findDesktopAppExecutable({ discover: false });
    if (exe) {
      const resources = desktop.resourcesDirForExecutable(exe);
      const cliBin = resources ? path.join(resources, "runtime", "cli", "bin") : "";
      if (cliBin && isDir(cliBin)) return path.normalize(cliBin);
    }
    const sealed = listDesktopCommandRuntimeDirs();
    return sealed.find(dirHasDshLauncher) || sealed[0] || null;
  });
}

/**
 * 找启动器目录（dsh.cmd / dsh.ps1 / dsh 所在处）。
 * @returns {string|null}
 */
export function findShimDir() {
  return remember("shim", () => {
    const fromPath = pathEnvDirs().find(dirHasDshLauncher);
    if (fromPath) return path.normalize(fromPath);
    const prefixHit = launcherDirsOf(findNpmPrefix()).find(dirHasDshLauncher);
    if (prefixHit) return path.normalize(prefixHit);
    // Windows 不跑 where.exe，部分宿主仍会闪控制台。
    const locateBin = isWindows
      ? ""
      : execFileText("/bin/sh", ["-c", "command -v dsh || which dsh"]);
    const located = locateBin
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((hit) => path.dirname(hit));
    const candidates = collectDirs([...located, ...guessedShimDirs()]);
    return candidates.find(dirHasDshLauncher) || null;
  });
}

/**
 * 一次 shim 注入要处理的全部启动器目录（不含桌面密封 bin）。
 * @returns {string[]}
 */
export function listShimDirsForPatch() {
  if (isDesktop()) return [];
  return collectDirs([
    findShimDir(),
    ...listDesktopCommandRuntimeDirs(),
    ...launcherDirsOf(findNpmPrefix()),
    ...pathEnvDirs(),
  ])
    .filter(dirHasDshLauncher)
    .filter((dir) => !isDesktopCommandRuntimeDir(dir));
}

/**
 * `child` 是否落在 `root` 目录之下（大小写与分隔符归一后比较）。
 *
 * 导出是因为 lib/core.js 的 `aiBaseBelongsToExe` 与补丁目标筛选也要用同一判据；
 * 判定只能有一份实现，否则「宿主目录算不算这份 exe 的」会在两处给出不同答案。
 */
export function pathIsUnder(child, root) {
  const c = path.normalize(String(child || "")).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const r = path.normalize(String(root || "")).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  if (!c || !r || /^[a-z]:$/.test(r)) return false;
  return c === r || c.startsWith(`${r}/`);
}

function findAiBaseDesktop() {
  const exe = desktop.findDesktopAppExecutable();
  const owned = exe
    ? desktop.resolveDesktopAiBase({
      execPath: exe,
      resourcesPath: path.join(path.dirname(exe), "resources"),
      argv: [],
      env: {},
    })
    : "";
  const envBase = String(process.env.DSH_BASE || "").trim();
  if (envBase) {
    const p = path.normalize(envBase);
    const officialProc = desktop.isOfficialHarnessExecutable(process.execPath);
    const underOwned = Boolean(owned && exe && pathIsUnder(p, path.dirname(exe)));
    if (isAiBase(p) && underOwned) return p;
    if (isAiBase(p) && !owned && !officialProc && desktop.isInsideDesktopInstall(p)) return p;
  }
  if (owned) return owned;
  // 当前进程就是官方 exe：只认这份安装的 resources/app。
  // 主目录旁边另一份也叫 DeepSeek Harness 的目录不是这次要洗的宿主。
  if (desktop.isOfficialHarnessExecutable(process.execPath)) return null;
  const resolved = desktop.resolveDesktopAiBase();
  if (resolved) return resolved;
  const starts = [];
  if (process.argv[1]) {
    try { starts.push(path.resolve(process.argv[1])); } catch {}
  }
  const resources = electronResourcesPath();
  if (resources) starts.push(resources);
  if (process.execPath) starts.push(path.dirname(process.execPath));
  try { starts.push(path.resolve(process.cwd())); } catch {}
  if (process.env.DSH_HOME) starts.push(path.normalize(process.env.DSH_HOME));
  for (const start of starts) {
    try {
      const hit = walkAncestorsForAiBase(isDir(start) ? start : path.dirname(start));
      if (hit && desktop.isInsideDesktopInstall(hit)) return hit;
    } catch {}
  }
  return null;
}

/**
 * 非桌面宿主的插件根发现（现在只服务「遗留环境」与显式 DSH_BASE）。
 *
 * 已删掉 `dsh web` CLI 宿主面，本函数不再是常规路径 —— 它只在两种情况下有意义：
 *   1. 用户显式设了 DSH_BASE（容器 / 非标准布局，唯一合法的旁路）
 *   2. 进程能自己报出正在加载的插件根（findAiBaseFromRunningProcess）
 *
 * 所以这里**不再启动 npm 子进程**。原来有三处会 spawn npm：
 *   findNpmPrefix()            → npm prefix -g + npm config get prefix（2 个进程，约 100 ms）
 *   npmQuery(["root", "-g"])   → 第 3 个进程
 * 三者都是为「web profile 装在 npm-global 里」服务的探测。
 * 现在 web profile 不是合法目标，为它跑 3 个 npm 子进程纯属启动负担。
 *
 * 需要旧的完整探测链时设 DSH_PURGE_DEEP_AIBASE_SCAN=1。
 */
function findAiBaseWeb() {
  const deep = String(process.env.DSH_PURGE_DEEP_AIBASE_SCAN || "").trim() === "1";

  const env = process.env.DSH_BASE;
  if (env && env.trim()) {
    const p = path.normalize(env.trim());
    if (isAiBase(p) && !desktop.isInsideDesktopInstall(p)) return p;
  }

  const fromProcess = findAiBaseFromRunningProcess();
  if (fromProcess && !desktop.isInsideDesktopInstall(fromProcess)) return fromProcess;

  const fromHome = findAiBaseFromDshHome(findDshHome());
  if (fromHome && !desktop.isInsideDesktopInstall(fromHome)) return fromHome;

  // 以上三条都是零成本检查（读环境变量 + 几次 existsSync）。
  // 落空之后原来要进 npm 子进程探测 —— 默认到此为止。
  if (!deep) return null;

  const nested = nestedAiPath();
  const prefix = findNpmPrefix();
  const shim = findShimDir();
  const search = [];
  for (const base of [prefix, ...launcherDirsOf(prefix), shim]) {
    search.push(...aiBaseGuessesFor(base));
  }
  for (const cand of search) {
    if (cand && isAiBase(cand) && !desktop.isInsideDesktopInstall(cand)) return path.normalize(cand);
  }
  const npmRoot = npmQuery(["root", "-g"]);
  for (const cand of [path.join(npmRoot, nested), path.join(npmRoot, "@deepseek-ai")]) {
    if (cand && isAiBase(cand) && !desktop.isInsideDesktopInstall(cand)) return path.normalize(cand);
  }

  const needle = path.join("node_modules", nested);
  // F16:递归兜底扫描按设计只是「上面所有便宜探测都落空」后的最后手段(容器 / 非标准布局)。
  // 实测这次扫描要 16 s、遍历 6 万个目录、结果为空 —— 纯启动负担。
  //
  // 现在这条必须默认关闭：
  // 1. 已删掉 `dsh web` CLI 宿主面，web profile 不再是合法目标
  //   2. SURFACE-3 让 detectSurface 对非桌面进程抛错 —— 走到这里说明宿主面本身就不对，
  //      再扫 6 万个目录也只会得到 null
  //   3. gatherState 是诊断入口，非桌面进程要能在毫秒级返回「为什么用不了」，
  //      而不是先卡 4.6 秒再给同样的结论
  //
  // 需要兜底扫描时显式设 DSH_PURGE_DEEP_AIBASE_SCAN=1。
  if (String(process.env.DSH_PURGE_DEEP_AIBASE_SCAN || "").trim() !== "1") {
    return null;
  }
  // #91:三个兜底根(DSH_HOME / DSH_HOME/.. / $HOME)在容器/非标准布局下常撞到同一目录,
  // 原来会把 $HOME 整个扫两遍。normalize+Set 去重后至少省掉重复的几万个 readdir。
  const scannedRoots = new Set();
  // F14:兜底三根的目录递归是每次启动最大的一次 fs 突发(实测 94 s / 十万次调用)。
  // 这一段内本进程不会改动文件系统,所以开启 asar 判定缓存,
  // 把每次 fs 调用的 12 层向上探测摊掉。作用域结束缓存即失效。
  return withFsProbeCache(() => {
    for (const sr of [findDshHome(), path.join(findDshHome(), ".."), os.homedir()]) {
      if (!sr) continue;
      const rootKey = path.normalize(sr);
      if (scannedRoots.has(rootKey)) continue;
      scannedRoots.add(rootKey);
      const found = findAiBaseRecursive(rootKey, needle, 0);
      if (found && !desktop.isInsideDesktopInstall(found)) return found;
    }
    return null;
  });
}

/**
 * 一次 Apply 要打到的全部 @deepseek-ai 插件根。
 *
 * 通常只有桌面安装树一个根，但本函数允许出现多个：
 * 用户显式设了 `DSH_BASE`、profile 下装了嵌套副本、或官方桌面同时留有
 * `app.asar.unpacked` 与 `app/` 两套。现在不再包含 npm-global / web profile。
 *
 * @param {{discover?: boolean}} [options] discover 为真时允许深度探测
 * @returns {string[]} 去重后的插件根
 */
export function enumeratePatchAiBases(options = {}) {
  const keys = new Set();
  const out = [];
  const discover = options.discover === true;
  const add = (p) => {
    if (!p) return;
    const n = path.normalize(p);
    if (!isAiBase(n)) return;
    // M37:realpath 归一化,避免 symlink / junction 两条路径打成两套。
    let real = n;
    try { real = fs.realpathSync.native(n); } catch { /* 保持 n */ }
    const k = String(real).replace(/\\/g, "/").toLowerCase();
    if (keys.has(k)) return;
    keys.add(k);
    out.push(n);
  };
  add(findAiBaseWeb());
  add(findAiBaseDesktop());
  for (const root of desktop.listDesktopPackageRoots({ discover })) add(root);
  const env = String(process.env.DSH_BASE || "").trim();
  if (env) add(path.normalize(env));
  add(findAiBaseFromDshHome(findDshHome()));
  return out;
}

/**
 * 找插件根（memo 化；启动早期找不到时不缓存）。
 * @returns {string|null}
 */
export function findAiBase() {
  return remember("ai", () => {
    if (isDesktop()) return findAiBaseDesktop();
    return findAiBaseWeb();
  });
}

function findAiBaseRecursive(root, needle, depth, visited, rootDev) {
  if (depth > 6) return null;
  // H21:realpath + Set 防 symlink 循环,否则 pnpm/junction 环会把栈打爆。
  const seen = visited || new Set();
  let real;
  try { real = fs.realpathSync.native(root); } catch { real = root; }
  const key = String(real).replace(/\\/g, "/").toLowerCase();
  if (seen.has(key)) return null;
  seen.add(key);
  // #91:第一次调用记下根设备号,之后 readdir 下钻时不跨设备 — 云盘/NFS/SMB 每层 readdir
  // 是一次网络往返,挂载点下有巨型目录树(如 macFUSE CloudDrive)会把 apply() 挂死永不返回。
  if (rootDev === undefined) {
    try { rootDev = fs.statSync(root).dev; } catch { rootDev = null; }
  }
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const child = path.join(root, e.name);
    // #91:跨挂载点不下钻 — 本盘枚举几千个本地目录没问题,踩进云盘就卡死
    // F15:Windows 上跨设备只可能发生在 reparse point(符号链接 / junction / 卷挂载点)上,
    // 普通子目录逐个 statSync 取 dev 是纯浪费 —— 6 万个目录约 7.2 s,占兜底扫描的一半开销。
    // 非 Windows 的挂载点不是符号链接,原判定保留。
    if (rootDev !== null && (process.platform !== "win32" || e.isSymbolicLink())) {
      let childDev;
      try { childDev = fs.statSync(child).dev; } catch { continue; }
      if (childDev !== rootDev) continue;
    }
    if (e.name === "node_modules") {
      const nestedHit = path.join(root, needle);
      if (isAiBase(nestedHit)) return path.normalize(nestedHit);
      const flatHit = path.join(root, "node_modules", "@deepseek-ai");
      if (isAiBase(flatHit)) return path.normalize(flatHit);
      if (isPnpmNodeModules(path.join(root, "node_modules"))) {
        const pnpmHit = firstAiBase(pnpmHoistAiBases(root));
        if (pnpmHit) return pnpmHit;
      }
    }
    const sub = findAiBaseRecursive(child, needle, depth + 1, seen, rootDev);
    if (sub) return sub;
  }
  return null;
}

// ── 路径分区（哪条路径允许被写）─────────────────────────────────────────

function realNorm(fp) {
  if (!fp) return "";
  try {
    return fs.realpathSync(fp).replace(/\\/g, "/").toLowerCase();
  } catch {
    return path.resolve(fp).replace(/\\/g, "/").toLowerCase();
  }
}

/**
 * 路径分区：desktop-install / desktop-profile / web-profile / web-install / shared / missing。
 * @param {string} fp
 * @returns {"desktop-install"|"desktop-profile"|"web-profile"|"web-install"|"shared"|"missing"}
 */
export function pathZone(fp) {
  if (!fp) return "missing";
  const n = realNorm(fp);
  if (desktop.isInsideDesktopInstall(fp) || desktop.isInsideDesktopInstall(n)) return "desktop-install";
  if (/\/profiles\/desktop(\/|$)/.test(n)) return "desktop-profile";
  if (/\/profiles\/web(\/|$)/.test(n)) return "web-profile";
  if (n.includes("/npm-global")) return "web-install";
  return "shared";
}

/**
 * 按当前宿主面判定一条路径能不能写。
 * @param {string} fp
 * @param {string} [surface] 已算好的宿主面
 * @returns {boolean}
 */
export function allowTargetPath(fp, surface = detectSurface()) {
  const zone = pathZone(fp);
  if (isDesktop(surface)) {
    // 桌面只动本机桌面树 + 共享的 $DSH_HOME/.agent-presets，不碰 Web / npm-global。
    return zone === "desktop-install" || zone === "desktop-profile" || zone === "shared";
  }
  return zone !== "desktop-install" && zone !== "desktop-profile";
}

/**
 * 按正在清洗的 aiBase 判定路径。
 *
 * 与 `allowTargetPath` 的区别：那个按**当前进程的宿主面**判，
 * 这个按**传入的 aiBase 落在哪**判 —— 一次 Apply 可能同时打到多个根
 * （见 `enumeratePatchAiBases`），此时不能只看当前进程。
 *
 * @param {string} fp
 * @param {string} aiBase
 * @returns {boolean}
 */
export function allowTargetPathForAiBase(fp, aiBase) {
  const zone = pathZone(fp);
  if (aiBase && desktop.isInsideDesktopInstall(aiBase)) {
    return zone === "desktop-install" || zone === "desktop-profile" || zone === "shared";
  }
  return zone !== "desktop-install" && zone !== "desktop-profile";
}

let _patchTargetAiBase = null;

function allowTargetForPatch(fp) {
  if (_patchTargetAiBase) return allowTargetPathForAiBase(fp, _patchTargetAiBase);
  return allowTargetPath(fp);
}

/**
 * 在「按某个 aiBase 判路径」的作用域里跑一段代码。
 *
 * targetFiles() 建候选表时要把门禁切到本次 aiBase，跑完必须还原 ——
 * 一次 Apply 可能连着打多个根，残留状态会让后一个根按前一个根的面判定。
 *
 * @template T
 * @param {string} aiBase 本次清洗的插件根
 * @param {() => T} fn 作用域内要跑的逻辑
 * @returns {T}
 */
export function withPatchTargetAiBase(aiBase, fn) {
  const prev = _patchTargetAiBase;
  _patchTargetAiBase = aiBase || null;
  try {
    return fn();
  } finally {
    _patchTargetAiBase = prev;
  }
}

/**
 * 宿主面门禁：存在 + 可写。
 * @param {string} fp
 * @returns {boolean}
 */
export function keepSurfaceFile(fp) {
  return fp && isFile(fp) && allowTargetPath(fp);
}

/** 内部：给 targets.js 用的候选过滤（同一套门禁）。 */
export function allowTargetForPatchFile(fp) {
  return allowTargetForPatch(fp);
}
