/**
 * lib/launcher.js — 启动器指向哪一棵插件树，决定补丁该落到哪里。
 * 启动器（shim）解析：看清 `dsh.cmd` / `dsh.ps1` / `dsh` 当前指向哪一棵树。
 *
 * ## 为什么需要
 *
 * 官方桌面端的启动器是**硬编码**的：
 *
 * ```bat
 * "%~dp0..\..\..\..\DeepSeek Harness.exe" --expose-internals "%~dp0..\..\..\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" %*
 * ```
 *
 * `--unseal` 把 `app.asar` 改名成 `app.asar.bak` 之后，这行就指向一个不存在的路径，
 * 于是 `dsh` 命令全线失效（`MODULE_NOT_FOUND`），装卸插件、doctor 这类操作全部做不了 ——
 * 而桌面端 GUI 本身仍然正常（Electron 会回落到 `resources/app`）。
 *
 * 本模块**只读不写**：把「当前指向哪、目标在不在」变成可查询的事实，让 `--diagnose`
 * 一眼看出这种不一致。改写启动器是另一件事（要备份 + 回落判定），不在这里做。
 */
import fs from "node:fs";
import path from "node:path";

/** `app.asar` 出现在启动器里 = 指向归档；解封后这个路径就不存在了。 */
const ASAR_NEEDLE = "app.asar";

/**
 * 从启动器正文里判断目标形态。
 *
 * @param {string} text 启动器文件全文
 * @returns {{kind:"asar"|"app"|"unknown", evidence:string}}
 */
export function parseLauncherTarget(text) {
  const body = String(text || "");
  if (!body.trim()) return { kind: "unknown", evidence: "empty" };
  // 先判 asar：它是更具体、也是解封后唯一会失效的形态。
  if (body.includes(ASAR_NEEDLE)) {
    const line = body.split(/\r?\n/).find((l) => l.includes(ASAR_NEEDLE)) || "";
    return { kind: "asar", evidence: line.trim().slice(0, 160) };
  }
  // 解包形态：`resources\app\dsh\...` 或 `resources/app/dsh/...`。
  const appHit = body.split(/\r?\n/).find((line) => {
    const normalized = line.replace(/\\/g, "/");
    return /\/app\/dsh\//.test(normalized) || /resources\/app\b/.test(normalized);
  });
  if (appHit) return { kind: "app", evidence: appHit.trim().slice(0, 160) };
  return { kind: "unknown", evidence: body.trim().slice(0, 160) };
}

/**
 * 检查一个目录下的三个启动器，并判断它们是否指向同一种形态。
 *
 * @param {string} shimDir 启动器目录（通常是 `<安装根>/resources/runtime/cli/bin`）
 * @param {(fp:string)=>string} [readText] 读正文的注入点；默认读磁盘（测试可传桩）
 * @returns {{shimDir:string, exists:boolean, consistent:boolean, kinds:string[], files:Array<object>}}
 */
export function inspectLauncher(shimDir, readText = (fp) => fs.readFileSync(fp, "utf8")) {
  const dir = String(shimDir || "");
  if (!dir) return { shimDir: "", exists: false, consistent: false, kinds: [], files: [] };
  const files = ["dsh.cmd", "dsh.ps1", "dsh"].map((name) => {
    let text = "";
    try {
      text = readText(path.join(dir, name));
    } catch {
      text = "";
    }
    const parsed = parseLauncherTarget(text);
    return { name, present: Boolean(text), kind: parsed.kind, evidence: parsed.evidence };
  });
  const present = files.filter((f) => f.present);
  const kinds = [...new Set(present.map((f) => f.kind))];
  return {
    shimDir: dir,
    exists: present.length > 0,
    // 三个启动器指向同一形态才算一致；混着就是「改了一半」。
    consistent: present.length > 0 && kinds.length === 1,
    kinds,
    files,
  };
}
