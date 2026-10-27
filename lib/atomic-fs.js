/**
 * lib/atomic-fs.js — 原子写原语单独成层，为的是断掉 core 与 desktop 的依赖环。
 * 原子写原语（零内部依赖，只依赖 node 内置模块）。
 *
 * 从 core.js 抽出来，目的不是"分层好看"，是**断开一个真环**：
 *
 *   core.js:14    → desktop.js        （安装探测）
 *   desktop.js:9  → core.js           （atomicCopyFile / atomicWriteSync）
 *   core.js:13    → hide-console.js
 *   hide-console.js:4 → desktop.js    （isAsarSealedPath / isInsideDesktopInstall）
 *
 * 抽完之后 desktop.js 从这里取原子写，不再回引 core.js，
 * 上面两条环边消失，`.dependency-cruiser.mjs` 的 no-circular 才能从 warn 升 error。
 *
 * 导出面与 core.js 里的原名完全一致，core.js 会原样再导出一次 ——
 * 调用方（desktop.js / update.js / rules.js / skills.js）零改动。
 * 这与 lib/redteam/ip-utils.js 的既有抽取先例一致。
 */
import nodeFs from "node:fs";
import path from "node:path";

// hostFs 是 extract-asar.js 的 fs 包装（asar 归档内走映射）。
// 但它零内部依赖，所以本文件直接用它不会引入新环。
import { hostFs } from "./extract-asar.js";

const fs = hostFs;
const fsp = hostFs.promises;

// H19:原子写。write-to-tmp + rename。EBUSY/ENOSPC 都不会半写坏原文件。
// 不走 FileHandle:hostFs.promises 只包了 readFile/writeFile/mkdir/unlink/rm/copyFile,无 open。
// 不显式 fsync:原子性靠 rename;KB 级配置文件断电丢最新一次写入可接受,下一次 apply 会补。
export function atomicWriteSync(fp, content, encoding = "utf8") {
  const dir = path.dirname(fp);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, encoding);
  try {
    fs.renameSync(tmp, fp);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

export async function atomicWriteFile(fp, content, encoding = "utf8") {
  const dir = path.dirname(fp);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, content, encoding);
  try {
    await fsp.rename(tmp, fp);
  } catch (e) {
    try { await fsp.unlink(tmp); } catch { /* ignore */ }
    throw e;
  }
}

export async function atomicCopyFile(src, dst) {
  const dir = path.dirname(dst);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = `${dst}.${process.pid}.${Date.now()}.copytmp`;
  await fsp.copyFile(src, tmp);
  try {
    await fsp.rename(tmp, dst);
  } catch (e) {
    try { await fsp.unlink(tmp); } catch { /* ignore */ }
    throw e;
  }
}
