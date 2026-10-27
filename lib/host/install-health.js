/**
 * lib/host/install-health.js — 这棵宿主安装树还能启动吗？唯一的判据实现。
 *
 * 为什么需要它：官方升级把 `resources/runtime` 清成空目录之后，桌面端启动直接 fatal
 * （`dsh-skill-office` 无条件读 `runtime/office-skills/office/SKILL.md`），而插件当时能说的
 * 只有「补丁没对齐」—— 那是在描述另一件事。现场有三样东西从来没人建模：
 *
 *   · `resources/app.asar`（官方归档）、`resources/app`（解开后的补丁树）、
 *     `resources/app.asar.bak`（`--unseal` 挪走归档时留下的那份）三者的关系；
 *   · `resources/runtime` 里**必须**有哪几项（宿主启动时真的会去读它们）；
 *   · 官方更新器留下的痕迹：`app-update.yml` 的通道、缓存目录里的 `pending/*.exe`
 *     与 `update-info.json` —— 「用缓存的安装包原地修好」这条恢复命令就是从这三样推出来的。
 *
 * 判据只有一条：**宿主启动时真会读的东西，在不在，且不是空目录**。它不猜「为什么没了」，
 * 只把「有没有」与「怎么修」说清楚；归因（官方换的 / 人删的）需要那三样痕迹一起读。
 *
 * 边界：只读，不修。唯一的写入口是 `writeUnsealedMarker` —— 它记「我把归档挪走了」，
 * 供下一次官方升级之后归因。恢复动作由人执行（安装包是官方动作，插件不代跑）。
 */

import fs from "node:fs";
import path from "node:path";

/** 宿主启动路径真的会读的 runtime 顶层项（缺一项就可能在启动时 fatal）。 */
export const RUNTIME_REQUIRED = Object.freeze(["versions.json", "bin", "cli", "office-skills", "primary-runtime"]);

/** 崩溃日志里点名的那个文件：`dsh-skill-office` 在启动时无条件读它。 */
export const RUNTIME_KEY_ASSET = Object.freeze(["office-skills", "office", "SKILL.md"]);

/** unseal 标记的落点：`resources/dsh-purge-unsealed.json`，与 asar 同级。 */
export const UNSEAL_MARKER = "dsh-purge-unsealed.json";

/**
 * 标记路径。
 * @param {string} resourcesDir
 * @returns {string}
 */
export function unsealedMarkerPath(resourcesDir) {
  return resourcesDir ? path.join(resourcesDir, UNSEAL_MARKER) : "";
}

/**
 * 读 unseal 标记。读不到 / 坏数据一律 null —— 「没有标记」与「标记说没事」是两件事。
 *
 * @param {string} resourcesDir
 * @param {{readText?:(fp:string)=>string}} [io]
 * @returns {{asar?:string, size?:number, at?:string}|null}
 */
export function readUnsealedMarker(resourcesDir, io = {}) {
  const fp = unsealedMarkerPath(resourcesDir);
  if (!fp) return null;
  const readText = typeof io.readText === "function" ? io.readText : (file) => fs.readFileSync(file, "utf8");
  try {
    const raw = JSON.parse(readText(fp));
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * 记「我把归档挪走了」。写在 resources 里而不是 `$DSH_HOME`：官方更新器只看 resources，
 * 而这条事实回答的正是「resources 里少了 app.asar 是谁干的」。
 *
 * `state` 是这句话的强弱：`done` = 真挪了；`scheduled` = 安排了空闲时挪、**未确认**。
 * 调用方只在知道结果之后才写 —— 提前写会在「没挪成」的现场留下假供词。
 *
 * @param {string} resourcesDir
 * @param {{asar?:string, size?:number, state?:("done"|"scheduled")}} [info]
 * @returns {boolean} 写成了没有
 */
export function writeUnsealedMarker(resourcesDir, info = {}) {
  const fp = unsealedMarkerPath(resourcesDir);
  if (!fp) return false;
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, `${JSON.stringify({
      asar: String(info.asar || ""),
      size: Number(info.size) || 0,
      state: info.state === "scheduled" ? "scheduled" : "done",
      at: new Date().toISOString(),
    }, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * @typedef {{exists:(p:string)=>boolean, isDir:(p:string)=>boolean,
 *   stat:(p:string)=>({size:number, isDir:boolean, mtimeMs:number}|null),
 *   list:(p:string)=>string[], readText:(p:string)=>string, env?:Record<string,string>}} IoView
 * @typedef {{channel?:string, cacheDirName?:string}} UpdaterConfig
 * @typedef {{cacheDir:string, present:boolean, pending:string[], installer:string, info:object|null}} UpdaterPending
 * @typedef {{installer?:string}} TreeLike
 */

/** 默认 IO：真有盘的那一份。测试注入假的，判据本身不依赖真实文件系统。 */
function defaultIo() {
  return {
    exists: (p) => {
      try {
        fs.statSync(p);
        return true;
      } catch {
        return false;
      }
    },
    isDir: (p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    stat: (p) => {
      try {
        const st = fs.statSync(p);
        return { size: st.size, isDir: st.isDirectory(), mtimeMs: st.mtimeMs };
      } catch {
        return null;
      }
    },
    list: (p) => {
      try {
        return fs.readdirSync(p);
      } catch {
        return [];
      }
    },
    readText: (p) => fs.readFileSync(p, "utf8"),
    env: process.env,
  };
}

/**
 * 从 `app-update.yml` 里取两样：通道与更新器缓存目录名。
 *
 * 只认扁平的 `key: value` 行 —— 那份文件是 electron-updater 写的，就是要这么读。
 * 读不到返回空串，不猜。
 *
 * @param {string} resourcesDir
 * @param {IoView} view
 * @returns {{channel:string, cacheDirName:string}}
 */
export function readUpdaterConfig(resourcesDir, view) {
  const fp = path.join(resourcesDir, "app-update.yml");
  let text = "";
  try {
    text = view.readText(fp);
  } catch {
    return { channel: "", cacheDirName: "" };
  }
  const pick = (key) => {
    const m = text.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, "m"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
  };
  return { channel: pick("channel"), cacheDirName: pick("updaterCacheDirName") };
}

/**
 * 更新器缓存里的待装包。
 *
 * `pending/update-info.json` 的 `fileName` 与 `pending/<fileName>` 是 electron-updater 的
 * 落盘约定；恢复命令就是「用这个包原地再跑一遍」。缺一样就只报「有没有 pending 目录」。
 *
 * @param {string} cacheDir
 * @param {IoView} view
 * @returns {{cacheDir:string, present:boolean, pending:Array<string>, installer:string, info:object|null}}
 */
export function readUpdaterPending(cacheDir, view) {
  const out = { cacheDir: String(cacheDir || ""), present: false, pending: [], installer: "", info: null };
  if (!out.cacheDir) return out;
  out.present = view.isDir(out.cacheDir);
  if (!out.present) return out;
  const pendingDir = path.join(out.cacheDir, "pending");
  out.pending = view.list(pendingDir);
  try {
    const parsed = JSON.parse(view.readText(path.join(pendingDir, "update-info.json")));
    if (parsed && typeof parsed === "object") out.info = parsed;
  } catch {
    out.info = null;
  }
  const named = out.info && typeof out.info.fileName === "string" ? out.info.fileName : "";
  const exe = out.pending.find((name) => /\.exe$/i.test(name));
  const pick = named && out.pending.includes(named) ? named : exe || "";
  out.installer = pick ? path.join(pendingDir, pick) : "";
  return out;
}

/** 更新器缓存根：Windows 是 `%LOCALAPPDATA%`，其余平台按 XDG 习惯退一步。 */
function updaterCacheRoot(env) {
  const local = String(env.LOCALAPPDATA || "").trim();
  if (local) return local;
  const home = String(env.HOME || "").trim();
  return home ? path.join(home, ".cache") : "";
}

/**
 * 安装树体检。判据次序即优先级：只要有一项不过，`ok` 就是假。
 *
 * @param {string} exe 桌面端可执行文件（`<安装根>/<exe>`）
 * @param {{io?:Partial<IoView>, resourcesDir?:string, env?:Record<string,string>}} [options]
 * @returns {{ok:boolean, reason:string, detail:string, remedy:string, unsealed:boolean,
 *   resourcesDir:string, archive:{path:string, present:boolean, size:number},
 *   archiveBak:{path:string, present:boolean, size:number},
 *   appDir:{path:string, present:boolean, entries:number}, runtime:object,
 *   marker:object|null, updater:{channel:string, cacheDir:string, present:boolean,
 *   pending:string[], installer:string, info:object|null}}}
 */
export function inspectHostInstall(exe = "", options = {}) {
  const io = options.io && typeof options.io === "object" ? { ...defaultIo(), ...options.io } : defaultIo();
  /** @type {IoView} */
  const view = io;
  void view;
  const env = options.env && typeof options.env === "object" ? options.env : (io.env || process.env);
  const resourcesDir = String(options.resourcesDir || (exe ? path.join(path.dirname(String(exe)), "resources") : ""));
  const empty = {
    ok: false,
    reason: "no-resources",
    detail: resourcesDir ? `找不到 ${resourcesDir}` : "没有可用的安装目录（宿主未定位）",
    remedy: "",
    unsealed: false,
    resourcesDir,
    archive: { path: "", present: false, size: 0 },
    archiveBak: { path: "", present: false, size: 0 },
    appDir: { path: "", present: false, entries: 0 },
    runtime: { path: "", present: false, empty: false, entries: [], missing: [] },
    marker: null,
    updater: { channel: "", cacheDir: "", present: false, pending: [], installer: "", info: null },
  };
  if (!resourcesDir || !view.isDir(resourcesDir)) return empty;

  const asarPath = path.join(resourcesDir, "app.asar");
  const bakPath = `${asarPath}.bak`;
  const appDirPath = path.join(resourcesDir, "app");
  const runtimePath = path.join(resourcesDir, "runtime");
  const asarStat = view.stat(asarPath);
  const bakStat = view.stat(bakPath);
  const appEntries = view.isDir(appDirPath) ? view.list(appDirPath) : [];
  const runtimeEntries = view.isDir(runtimePath) ? view.list(runtimePath) : [];
  const missing = RUNTIME_REQUIRED.filter((name) => !runtimeEntries.includes(name));
  const keyAsset = path.join(runtimePath, ...RUNTIME_KEY_ASSET);
  const keyAssetPresent = view.exists(keyAsset);

  const config = readUpdaterConfig(resourcesDir, io);
  const cacheRoot = updaterCacheRoot(env);
  const cacheDir = config.cacheDirName && cacheRoot ? path.join(cacheRoot, config.cacheDirName) : "";
  const pending = readUpdaterPending(cacheDir, io);
  const marker = readUnsealedMarker(resourcesDir, io);

  const tree = {
    ok: true,
    reason: "ok",
    detail: "",
    remedy: "",
    // 「解封态」= 归档不在原位、旁边有 .bak、补丁树在。三者同时成立才是插件留下的形态。
    unsealed: !asarStat && bakStat?.size > 0 && appEntries.length > 0,
    resourcesDir,
    archive: { path: asarPath, present: Boolean(asarStat), size: asarStat?.size || 0 },
    archiveBak: { path: bakPath, present: Boolean(bakStat), size: bakStat?.size || 0 },
    appDir: { path: appDirPath, present: appEntries.length > 0, entries: appEntries.length },
    runtime: {
      path: runtimePath,
      present: view.isDir(runtimePath),
      empty: view.isDir(runtimePath) && runtimeEntries.length === 0,
      entries: runtimeEntries,
      missing: keyAssetPresent ? missing.filter((name) => name !== "office-skills") : missing,
    },
    marker,
    updater: { channel: config.channel, ...pending },
  };

  // 归档与解开的目录同时在：宿主会读归档，补丁树白写。这不是「坏了」，是「没生效」。
  if (tree.archive.present && tree.appDir.present) {
    return {
      ...tree,
      ok: false,
      reason: "archive-shadows-app",
      detail: "app.asar 与 resources/app 同时存在：Electron 读归档，补丁树不会生效",
      remedy: "把 app.asar 改名成 app.asar.bak（dsh-purge --unseal 做这一步）后重启",
    };
  }

  if (!tree.runtime.present) {
    return {
      ...tree,
      ok: false,
      reason: "runtime-missing",
      detail: "resources/runtime 不存在：宿主启动时读不到 runtime 资产",
      remedy: recoveryCommand(tree.updater),
    };
  }
  if (tree.runtime.empty) {
    return {
      ...tree,
      ok: false,
      reason: "runtime-empty",
      detail: "resources/runtime 是空目录：官方更新清空了它，而宿主启动必须读它",
      remedy: recoveryCommand(tree.updater),
    };
  }
  if (tree.runtime.missing.length > 0 || !keyAssetPresent) {
    const gaps = [...tree.runtime.missing];
    if (!keyAssetPresent) gaps.push(RUNTIME_KEY_ASSET.join("/"));
    return {
      ...tree,
      ok: false,
      reason: "runtime-incomplete",
      detail: `resources/runtime 缺 ${gaps.join("、")}：宿主启动时会 ENOENT`,
      remedy: recoveryCommand(tree.updater),
    };
  }
  if (tree.unsealed) {
    return {
      ...tree,
      ok: true,
      reason: "unsealed",
      detail: "归档已挪开，宿主读 resources/app（补丁树）；官方升级前必须先恢复归档",
      remedy: "升级官方版本前：把 app.asar.bak 改回 app.asar，或先 --revert 再升级",
    };
  }
  return tree;
}

/**
 * 恢复命令：优先用更新器缓存里的那个安装包（同版本静默重跑会补回 runtime），
 * 没有待装包时才让人去下载。命令是给人复制执行的，所以带引号、带 `/S --updated`。
 *
 * @param {TreeLike} updater `inspectHostInstall` 产物里的 `updater` 段（待装包在 `installer` 上）
 * @returns {string}
 */
export function recoveryCommand(updater) {
  const installer = String(updater?.installer || "");
  if (installer) return `"${installer}" /S --updated`;
  return "重新运行官方安装包（同版本即可，会补回 resources/runtime）";
}

/**
 * 盘上有没有待装的官方更新包（不看解封态）。
 *
 * 为什么单列：解封**不是**偶发的手工动作 —— 一轮清洗干净之后插件自己会把 `app.asar` 挪走，
 * 之后宿主长期处于「读解开的目录」这个稳态。而官方更新器是外部 actor：它把包下到 `pending/`，
 * 下次退出就装。两者相撞时更新器会重写 `resources` 并把 `runtime` 清空（实测：应用启动 fatal）。
 *
 * 插件拦不住官方更新器，所以这里只回答「盘上有没有那一包」与「装坏了怎么修」，
 * 由调用方决定写日志还是打提示 —— 判断与表述分开，两边不会各算一次。
 *
 * @param {string} exe
 * @param {{io?:Partial<IoView>, resourcesDir?:string, env?:Record<string,string>}} [options]
 * @returns {{installer:string, recovery:string, channel:string}|null}
 */
export function pendingOfficialUpdate(exe = "", options = {}) {
  const tree = inspectHostInstall(exe, options);
  if (!tree.updater.installer) return null;
  return {
    installer: tree.updater.installer,
    recovery: recoveryCommand(tree.updater),
    channel: tree.updater.channel || "",
  };
}

/**
 * 启动侧的同一对事实：**已经解封** + 盘上有待装包。
 *
 * 这一档比上面的更紧：宿主此刻正读解开的目录，官方更新一装就会把 `runtime` 清掉。
 * 返回 null 表示没问题，或判不出来（没有安装根）。
 *
 * @param {string} exe
 * @param {{io?:Partial<IoView>, resourcesDir?:string, env?:Record<string,string>}} [options]
 * @returns {{installer:string, recovery:string, channel:string, archiveBak:string}|null}
 */
export function describeUnsealedRisk(exe = "", options = {}) {
  const tree = inspectHostInstall(exe, options);
  if (!tree.unsealed || !tree.updater.installer) return null;
  return {
    installer: tree.updater.installer,
    recovery: recoveryCommand(tree.updater),
    channel: tree.updater.channel || "",
    archiveBak: tree.archiveBak.path,
  };
}
