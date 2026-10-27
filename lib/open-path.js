/**
 * lib/open-path.js — 打开目录只收语义 key，路径由服务端自己算，调用方插不了手。
 * 打开本地目录：只接受「语义 key」，不接受调用方传路径。
 *
 * 为什么只收 kind：把路径交给调用方，就等于让外部输入决定去开哪一条命令。
 * 这里两个目录都由服务端自己算，kind 用白名单校验，命令行里只出现服务端算出的路径。
 */
import { spawn } from "node:child_process";
import path from "node:path";

/** kind → 目录。未知 kind 返回 null（调用方据此回 400）。 */
export function dirFor(kind, dshHome) {
  if (kind === "logs") return path.join(String(dshHome || ""), "dsh-purge", "audit");
  if (kind === "config") return String(dshHome || "");
  /* 知识库的库文件与配置同在 `$DSH_HOME/redteam`：知识库空态的「打开知识库目录」开的就是这一层。 */
  if (kind === "knowledge") return path.join(String(dshHome || ""), "redteam");
  return null;
}

/**
 * 打开目录。spawn 失败不抛，返回 { ok:false, error }。
 * @param {"logs"|"config"} kind
 * @param {string} dshHome
 * @param {{spawnFn?:Function, platform?:string}} [opts] 测试注入用
 */
export function openPathFor(kind, dshHome, opts = {}) {
  const spawnFn = typeof opts.spawnFn === "function" ? opts.spawnFn : spawn;
  const platform = opts.platform || process.platform;
  const dir = dirFor(kind, dshHome);
  if (!dir) return { ok: false, error: `unsupported kind: ${kind}`, status: 400 };
  const args = platform === "win32" ? [dir] : [dir];
  const cmd = platform === "win32" ? "explorer" : platform === "darwin" ? "open" : "xdg-open";
  try {
    const child = spawnFn(cmd, args, { detached: true, stdio: "ignore" });
    // 不等待返回：目录自己会浮出来。但子进程错误必须接住，否则会冒成未捕获异常。
    if (child && typeof child.on === "function") child.on("error", () => {});
    if (child && typeof child.unref === "function") child.unref();
    return { ok: true, path: dir };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}
