/**
 * lib/host/shim-repair.js — shim 原地写回：写不成落 pending，绝不许静默失败。
 * shim 写回：把「写 .tmp 再 rename」换成「原地截断写 + 失败落 pending」。
 *
 * 为什么不能用 rename：目标被 cmd.exe / 正在执行的 CLI 占用时，rename 必然 EPERM，
 * 重试没有意义（真机实测 dsh.cmd 两次 apply 都是 EPERM，错误被塞进响应体）。
 *
 * 三条路，任何一条都不许静默：
 *   1 目标路径已存在 → 整段跳过（这一次什么都不用做，响应里也不报 cli_repair）。
 *   2 目标不存在且可写 → 原地截断写，status=ok。
 *   3 原地写失败（EPERM/EBUSY）→ 内容落到 `<pendingDir>/<文件名>.pending`，status=deferred；
 *     下次进程启动（插件加载期，没有 CLI 在执行）补落盘，成功即删 pending。
 */
import fs from "node:fs";
import path from "node:path";

/** shim 正文里那个 `.js` 目标路径（cmd 与 sh 两种写法都取第一个引号里的 .js）。 */
export function parseTargetPath(text) {
  if (typeof text !== "string") return "";
  const m = /["']([^"']+\.js)["']/.exec(text);
  return m ? m[1] : "";
}

const exists = (p) => {
  try { return fs.existsSync(p); } catch { return false; }
};

/**
 * 目标路径存在吗？
 * 判据是「shim 指向的那个 .js 在不在」，不是「shim 文件在不在」—— 后者恒真，等于没判。
 */
export function targetIsValid(text) {
  const target = parseTargetPath(text);
  return Boolean(target) && exists(target);
}

/**
 * 原地写：以可写方式打开、截断、写完整内容、关闭。不碰 rename。
 * @returns {{status:"ok"|"deferred"|"failed", path:string, error?:string, pending?:string}}
 */
export function writeShimInPlace(fp, content, pendingDir) {
  try {
    const fd = fs.openSync(fp, "w");
    try {
      fs.writeFileSync(fd, content, "utf8");
    } finally {
      fs.closeSync(fd);
    }
    return { status: "ok", path: fp };
  } catch (e) {
    const code = e && e.code;
    if (code === "EPERM" || code === "EBUSY" || code === "EACCES") {
      try {
        fs.mkdirSync(pendingDir, { recursive: true });
        const pendingPath = path.join(pendingDir, `${path.basename(fp)}.pending`);
        fs.writeFileSync(pendingPath, content, "utf8");
        return { status: "deferred", path: fp, pending: pendingPath };
      } catch (e2) {
        return { status: "failed", path: fp, error: String(e2 && e2.message ? e2.message : e2) };
      }
    }
    return { status: "failed", path: fp, error: String(e && e.message ? e.message : e) };
  }
}

/** 补落盘：扫描 pending，写成功后删除 pending；失败保留并返回 failed。 */
export function flushPending(pendingDir) {
  const out = { ok: true, flushed: [], failed: [] };
  let names = [];
  try { names = fs.readdirSync(pendingDir); } catch { return out; }
  for (const name of names) {
    if (!name.endsWith(".pending")) continue;
    const pendingPath = path.join(pendingDir, name);
    const target = path.join(path.dirname(pendingDir), name.slice(0, -".pending".length));
    try {
      const content = fs.readFileSync(pendingPath, "utf8");
      fs.writeFileSync(target, content, "utf8");
      fs.unlinkSync(pendingPath);
      out.flushed.push(target);
    } catch (e) {
      out.ok = false;
      out.failed.push({ path: pendingPath, error: String(e && e.message ? e.message : e) });
    }
  }
  return out;
}

/** 当前 shim 状态：pending 存在即 deferred，否则 ok（failed 由调用方在写失败时直接给出）。 */
export function pendingStatus(pendingDir) {
  let names = [];
  try { names = fs.readdirSync(pendingDir).filter((n) => n.endsWith(".pending")); } catch { return null; }
  if (names.length === 0) return null;
  return { status: "deferred", path: path.join(pendingDir, names[0]) };
}
