// lib/surface.js — 宿主面判定零依赖，才能放进依赖链而不造出环。
// @ts-nocheck — 本文件不在类型检查范围内。
// 它是被 lib/host/*.js import 进来的老模块：checkJs 会顺着 import 链检查，
// 于是 Electron 的 process.resourcesPath / process.parentPort、Error.code
// 这些 Node 类型里没有的东西会淹掉新目录的真实报错。
// 本文件自己的 JSDoc（detectSurface / isDesktop 的 @param / @returns）是齐的，
// 缺的是「Electron 扩展了 Process」这件事 —— 加一份 Electron 类型声明时再开。
/**
 * 宿主面判定（唯一入口）。
 *
 * 零内部依赖 —— 这是它能当判定层的原因：`host.js` 依赖 `desktop.js`，
 * `desktop.js` 依赖 `core.js`，把判定放进那条链的任何一环都会造出环。
 *
 * 三个导出各司其职：
 *   detectSurface()     探测当前宿主面；探测不到 **抛错**（SURFACE-3 fail-fast）
 *   tryDetectSurface()  同上，但失败返回 null（诊断 / 日志用）
 *   isDesktop()         布尔判定，**永不抛错**（业务分支用）
 *
 * 分界线：业务路径该抛就抛，诊断路径不许因为面不对就整个崩掉。
 */
import path from "node:path";
import fs from "node:fs";

/**
 * 当前维护的宿主面（SURFACE-3 收缩：只留 desktop）。
 *
 * 已删掉 `dsh web` CLI 宿主面；`gui` / `tui` 从未单独适配过，只是占位。
 * 现在三者都不在列表里 —— 探测到它们会显式抛错，而不是静默回退。
 *
 * ⚠️ 这不影响 Web UI 层：`client.js` / `dsh.client.platform:"web"` / `webServer`
 * 仍在用（桌面端 Electron 也加载它们），见 SURFACE-4。
 */
export const SURFACES = Object.freeze(["desktop"]);

/** ：探测不到 desktop 时抛的错误码，方便调用方区分"版本不对"与"代码 bug"。 */
export const SURFACE_UNSUPPORTED = "DSH_PURGE_UNSUPPORTED_SURFACE";

function norm(value) {
  return String(value || "").trim().toLowerCase();
}

function slash(value) {
  return String(value || "").replace(/\\/g, "/").toLowerCase();
}

function exeName(execPath) {
  return path.basename(String(execPath || "")).toLowerCase();
}

export function pathLooksDesktop(p) {
  const n = slash(p);
  if (!n) return false;
  // 安装目录可能叫 "DeepSeek Harness" / "deepseek-harness" / "DeepseekHarnessDesktop"。
  // 源码仓库也常带 deepseek-harness 名字，所以还要带 resources/、exe、.app/ 才算桌面安装。
  const harnessDir =
    n.includes("/deepseek harness/") ||
    n.includes("/deepseek-harness/") ||
    n.includes("/deepseekharness") ||
    /\/deepseek[\s._-]*harness/.test(n);
  return (
    n.includes("/dsh desktop/") ||
    n.includes("/dsh desktop.app/") ||
    n.includes("dsh-desktop") ||
    n.includes("dsh-plugin-desktop") ||
    n.includes("/deepseek harness.app/") ||
    (harnessDir && (n.includes("/resources/") || n.includes("/contents/resources/") || n.endsWith("/resources"))) ||
    /\/dsh desktop\.exe$/i.test(n) ||
    /\/deepseek[\s._-]*harness\.exe$/i.test(n) ||
    n.endsWith("/host-process-entry.js") ||
    n.endsWith("/desktop-cli.js")
  );
}

function resourcesLookLikeDesktopInstall(resourcesPath) {
  if (!resourcesPath) return false;
  if (pathLooksDesktop(resourcesPath)) return true;
  const n = slash(resourcesPath);
  if (!(n.endsWith("/resources") || n.includes("/contents/resources"))) return false;
  try {
    const asar = path.join(resourcesPath, "app.asar");
    if (fs.existsSync(asar) && fs.statSync(asar).isFile()) return true;
    if (fs.existsSync(path.join(resourcesPath, "app", "dsh"))) return true;
    if (fs.existsSync(path.join(resourcesPath, "app.asar.unpacked", "dsh"))) return true;
  } catch {
    /* ignore */
  }
  return false;
}

export function isDesktopSurface(input = {}) {
  const env = input.env ?? process.env;
  const forced = norm(env.DSH_SURFACE);
  if (forced === "desktop") return true;
  if (forced && SURFACES.includes(forced)) return false;

  const execPath = input.execPath ?? process.execPath;
  const name = exeName(execPath);
  if (
    name === "dsh desktop.exe" ||
    name === "dsh desktop" ||
    name === "deepseek harness.exe" ||
    name === "deepseek-harness.exe" ||
    name === "deepseek harness" ||
    name === "deepseek-harness" ||
    /^deepseek[\s._-]*harness(\.exe)?$/.test(name)
  ) return true;
  if (pathLooksDesktop(execPath)) return true;

  const resourcesPath = input.resourcesPath ?? process.resourcesPath;
  if (resourcesLookLikeDesktopInstall(resourcesPath)) return true;

  const argv = input.argv ?? process.argv;
  if ((Array.isArray(argv) ? argv : []).some((arg) => pathLooksDesktop(arg))) return true;

  const parentPort = input.parentPort !== undefined ? input.parentPort : process.parentPort;
  if (parentPort && (pathLooksDesktop(execPath) || resourcesLookLikeDesktopInstall(resourcesPath))) return true;

  if (env.ELECTRON_RUN_AS_NODE && (pathLooksDesktop(execPath) || resourcesLookLikeDesktopInstall(resourcesPath))) return true;
  return false;
}

function forcedSurface(env) {
  const forced = norm(env.DSH_SURFACE);
  return SURFACES.includes(forced) ? forced : "";
}

/**
 * 探测当前宿主面（：fail-fast）。
 *
 * SURFACE-3 之前的行为是「所有探测都失败 = web」，这是删 web 面时最危险的静默回退：
 * 删掉 web 适配器后，这个兜底会返回一个不存在的适配器名，调用方拿到 undefined。
 *
 * 现在：探测不到 desktop 就**抛错**。宁可启动时报一句明确的话，
 * 也不要在 web 宿主上跑一半再静默失效。
 *
 * `DSH_SURFACE` 仍可强制指定，但只接受 SURFACES 里的值（现在只有 desktop）。
 * 这保留了测试的注入能力，同时不给"强制一个不存在的面"留口子。
 *
 * @param {object} [input] 探测输入（env / execPath / resourcesPath / argv / parentPort）。
 * @returns {"desktop"}
 * @throws {Error} 探测不到 desktop 时抛错，error.code = SURFACE_UNSUPPORTED。
 */
export function detectSurface(input = {}) {
  const env = input.env ?? process.env;
  const forced = forcedSurface(env);
  if (forced) return forced;
  if (isDesktopSurface(input)) return "desktop";

  const detail = {
    execPath: String(input.execPath ?? process.execPath ?? ""),
    resourcesPath: String(input.resourcesPath ?? ""),
    forced: String(env.DSH_SURFACE ?? ""),
  };
  const error = new Error(
    "dsh-purge 只支持官方桌面端（DeepSeek Harness EXE）。"
    + "当前进程不是桌面宿主："
    + `execPath=${detail.execPath || "(空)"}`
    + (detail.resourcesPath ? ` resourcesPath=${detail.resourcesPath}` : "")
    + (detail.forced ? ` DSH_SURFACE=${detail.forced}（不在支持列表 ${SURFACES.join("/")} 内）` : "")
    + "。`dsh web` CLI 宿主面已在 1.0.0 移除；"
    + "如果你确实在桌面端上跑，请确认装的是官方 EXE 而不是 dsh web。",
  );
  error.code = SURFACE_UNSUPPORTED;
  throw error;
}

/** 适配器名。现在只有 desktop，其余一律抛错。 */
export function adapterFor(kind) {
  if (kind === "desktop") return "desktop";
  const error = new Error(
    `不支持的宿主面: ${JSON.stringify(kind)}。`
    + `dsh-purge 1.0.0 只维护官方桌面端（支持列表: ${SURFACES.join(", ")}）。`,
  );
  error.code = SURFACE_UNSUPPORTED;
  throw error;
}

/**
 * 探测 surface，失败时返回 null（不抛错）。
 *
 * 给「诊断 / 日志 / 降级路径」用：那些地方需要知道"当前是什么面"，
 * 但不该因为面不对就整个崩掉。业务逻辑仍用 detectSurface（fail-fast）。
 *
 * @param {object} [input]
 * @returns {"desktop"|null}
 */
export function tryDetectSurface(input = {}) {
  try {
    return detectSurface(input);
  } catch {
    return null;
  }
}

/**
 * 唯一的 surface 判定入口（收口点）。
 *
 * 为什么在这里而不是 host.js：host.js 依赖 desktop.js，desktop.js 依赖 core.js，
 * core.js 依赖 host.js —— 把判定放进 host.js 会立刻造出一个新环。
 * surface.js 零内部依赖，是唯一能放的地方；host.js 只做转发。
 *
 * 三种调用形态：
 *   isDesktop()                      → 探测当前进程
 *   isDesktop({ env: {...} })        → 注入探测输入（测试用）
 *   isDesktop(surfaceString)         → 已算好的 surface 值（函数入参透传）
 *
 * 现在：非 desktop 一律返回 false（**不抛错**）。
 * 判定函数不该抛 —— 调用方用 `if (isDesktop())` 是在问"是不是桌面"，
 * 答案"不是"是合法结果。抛错留给 detectSurface / adapterFor 这类"必须有值"的地方。
 *
 * @param {string|object} [input] surface 值，或 detectSurface 的输入对象。
 * @returns {boolean}
 */
export function isDesktop(input) {
  if (typeof input === "string") return input === "desktop";
  try {
    return detectSurface(input || {}) === "desktop";
  } catch {
 // ：探测失败 = 不是桌面。判定函数不抛错。
    return false;
  }
}
