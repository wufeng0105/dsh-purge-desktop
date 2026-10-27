#!/usr/bin/env node
/**
 * scripts/verify-rollback-point.mjs — tag 能不能当回滚点，得在临时目录里真装一次才知道。
 * 回滚点验证工具。
 *
 * ## 为什么需要它
 *
 * 本仓库发现「v1.0.1 / v1.0.2 / v1.1.0 三个 tag 的产物加载即炸」这件事，
 * 靠的是验收阶段临时拼的一次性流程 —— 因为**没有可复用的检查手段**，那三个
 * tag 才会在语法检查、`npm test`、CI、字节 drift **全绿**的情况下发出去。
 * 这个脚本把那次流程固化下来：给一个 rev，输出三项矩阵与结论。
 *
 * ## 三项矩阵
 *
 * | 行 | 判据 | 抓的是 |
 * |---|---|---|
 * | 导入 | `import('<tree>/lib/index.js')` 不抛 | 插件代码层面的硬伤（缺文件、坏 import） |
 * | 测试 | 在该 tree 里跑 `node --test`，`fail` 必须为 0 | 那个版本自己的契约测试是否自洽 |
 * | factory | 在 VM 里真的执行 `client.js` 的 ModuleLoader factory | **产物能不能打开**（v1.0.1→v1.1.0 就是死在这） |
 *
 * 三行全绿才叫「可作回滚点」。只有 factory 那一行能抓到「语法合法但一加载就
 * `ReferenceError`」—— 这正是当年所有门禁一起漏掉的那类病。
 *
 * ## 解包为什么不用 `tar`
 *
 * Windows 自带的 bsdtar 用 GBK 解 UTF-8 文件名会**丢文件**并报
 * `Invalid empty pathname`（本仓库的 CJK 文件名就中招）。
 * 所以主路径是 `git archive --format=tar` + Python `tarfile`（UTF-8 安全），
 * `tar` 只作兜底，并且**每个解包结果都要对着 `git ls-tree` 的文件清单逐个核对**：
 * 缺文件就换下一个解包器，全都缺就退出 2 —— 绝不拿一份残缺的树去下结论。
 *
 * ## 用法
 *
 * ```
 * node scripts/verify-rollback-point.mjs v1.2.0-clientsrc
 * node scripts/verify-rollback-point.mjs v1.1.0-semantics
 * node scripts/verify-rollback-point.mjs v1.1.0-semantics --with-deps   # 把工作区 node_modules 挂进去
 * node scripts/verify-rollback-point.mjs v1.1.0-semantics --keep        # 保留解包目录供人工排查
 * ```
 *
 * 退出码：`0` 三项全绿 / `1` 有红项 / `2` 工具或环境错误（rev 不存在、解包不全、缺共享桩）。
 *
 * 关于「测试」这一行：树里没有 `node_modules` 时，依赖二进制的用例会失败
 * （`rules-ratchet` 需要 ast-grep）。这种红**不是产物的错**，
 * 加 `--with-deps` 复跑即可区分；输出里会显式标注。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXIT_OK = 0;
const EXIT_RED = 1;
const EXIT_TOOLING = 2;

const GREEN = "[绿]";
const RED = "[红]";

const log = (msg) => process.stdout.write(`${msg}\n`);

/** 临时目录的清理登记：`fail()` 与正常收尾都要走它（process.exit 不会跑 finally）。 */
let cleanupDir = null;
let keepWorkDir = false;

const fail = (msg) => {
  if (cleanupDir && !keepWorkDir) rmSync(cleanupDir, { recursive: true, force: true });
  process.stderr.write(`[verify-rollback-point] 无法完成验证：${msg}\n`);
  process.exit(EXIT_TOOLING);
};

// ── 参数 ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { rev: null, withDeps: false, keep: false };
  for (const arg of argv) {
    if (arg === "--with-deps") opts.withDeps = true;
    else if (arg === "--keep") opts.keep = true;
    else if (arg === "--help" || arg === "-h") {
      log("用法：node scripts/verify-rollback-point.mjs <rev> [--with-deps] [--keep]");
      log("  <rev>        任意 git rev（tag / 分支 / commit）");
      log("  --with-deps  把工作区的 node_modules 以 junction/软链挂进解包目录（跑那个版本的完整测试用）");
      log("  --keep       保留解包目录，便于人工排查");
      process.exit(EXIT_OK);
    } else if (arg.startsWith("-")) fail(`未知参数 ${arg}`);
    else if (opts.rev === null) opts.rev = arg;
    else fail(`只接受一个 rev（多给了 ${arg}）`);
  }
  if (!opts.rev) fail("缺少 rev 参数。用法：node scripts/verify-rollback-point.mjs <rev> [--with-deps] [--keep]");
  return opts;
}

function run(cmd, args, { cwd = ROOT, timeout = 120_000, allowFailure = false } = {}) {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    timeout,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.error) {
    if (allowFailure) return { status: null, stdout, stderr: `${stderr}${result.error.message}`, error: result.error };
    fail(`执行 ${cmd} 失败：${result.error.message}`);
  }
  if (!allowFailure && result.status !== 0) {
    fail(`${cmd} ${args.join(" ")} 退出码 ${result.status}：\n${stderr || stdout}`);
  }
  return { status: result.status, stdout, stderr };
}

// ── git 侧：rev 校验、文件清单、归档 ────────────────────────────────────────
function resolveRev(rev) {
  const res = run("git", ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { allowFailure: true });
  const commit = res.stdout.trim();
  if (res.status !== 0 || !commit) fail(`rev 不存在或不是 commit：${rev}（git rev-parse 退出码 ${res.status}）`);
  return commit;
}

/** `git ls-tree` 给出权威文件清单（Git 自己解 UTF-8，不受本地 tar 影响）。 */
function expectedBlobs(commit) {
  const res = run("git", ["ls-tree", "-r", "-z", commit]);
  const blobs = [];
  for (const entry of res.stdout.split("\0")) {
    if (!entry) continue;
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type] = entry.slice(0, tab).split(" ");
    // 只看 blob：gitlink（子模块，mode 160000）在 archive 里本来就不会有内容
    if (type !== "blob" || mode === "160000") continue;
    blobs.push(entry.slice(tab + 1));
  }
  return blobs;
}

// ── 解包：Python tarfile 主路径 + tar 兜底，逐个校验完整性 ───────────────────
const PY_UNPACK = [
  "import sys, tarfile",
  "src, dst = sys.argv[1], sys.argv[2]",
  "try:",
  "    tf = tarfile.open(src, 'r')",
  "except Exception as exc:",
  "    sys.stderr.write('tarfile.open: %s' % exc)",
  "    sys.exit(3)",
  "try:",
  "    tf.extractall(dst, filter='data')",
  "except TypeError:",
  "    tf.extractall(dst)",
  "finally:",
  "    tf.close()",
].join("\n");

function findPython() {
  const candidates = process.env.DSH_PYTHON ? [process.env.DSH_PYTHON] : [];
  candidates.push("python3", "python");
  if (process.platform === "win32") candidates.push("py");
  for (const cmd of candidates) {
    const probe = run(cmd, ["-c", "import tarfile"], { allowFailure: true, timeout: 30_000 });
    if (probe.status === 0) return cmd;
  }
  return null;
}

function unpackers(tarPath, destRoot) {
  const list = [];
  const python = findPython();
  if (python) list.push({ name: `python tarfile（${python}，UTF-8 安全）`, cmd: python, args: ["-c", PY_UNPACK, tarPath, destRoot] });
  list.push({ name: "tar 兜底（Windows bsdtar 可能丢 CJK 文件名）", cmd: "tar", args: ["-xf", tarPath, "-C", destRoot] });
  return list;
}

function unpackArchive(tarPath, destRoot, blobs) {
  const attempts = [];
  for (const method of unpackers(tarPath, destRoot)) {
    rmSync(destRoot, { recursive: true, force: true });
    mkdirSync(destRoot, { recursive: true });
    const res = run(method.cmd, method.args, { allowFailure: true, timeout: 300_000 });
    if (res.status !== 0) {
      attempts.push(`${method.name}：退出码 ${res.status} ${(res.stderr || res.stdout).trim().split("\n")[0] ?? ""}`);
      continue;
    }
    const missing = blobs.filter((blob) => !existsSync(join(destRoot, blob.split("/").join(sep))));
    if (missing.length === 0) {
      return { method: method.name, files: blobs.length, attempts };
    }
    attempts.push(
      `${method.name}：解出 ${blobs.length - missing.length}/${blobs.length} 个文件，缺 ${missing.length} 个` +
        `（例：${missing.slice(0, 3).join("、")}）`,
    );
  }
  fail(`归档解包后文件不全，拒绝用残缺的树下结论：\n  ${attempts.join("\n  ")}`);
}

// ── 三项判据 ────────────────────────────────────────────────────────────────
async function checkImport(tree) {
  const entry = join(tree, "lib", "index.js");
  if (!existsSync(entry)) return { ok: false, detail: `缺 lib/index.js（这个 rev 的产物结构不同？）` };
  try {
    const mod = await import(pathToFileURL(entry).href);
    const keys = Object.keys(mod).sort();
    return { ok: true, detail: `lib/index.js 可 import（exports: ${keys.slice(0, 6).join(", ")}${keys.length > 6 ? ", …" : ""}）` };
  } catch (error) {
    return { ok: false, detail: `${error.name}: ${error.message.split("\n")[0]}`, error };
  }
}

function checkTests(tree, { hasDeps }) {
  const res = run(process.execPath, ["--test", "--test-reporter=tap"], { cwd: tree, allowFailure: true, timeout: 900_000 });
  const num = (key) => {
    const m = new RegExp(`^# ${key} (\\d+)$`, "m").exec(res.stdout);
    return m ? Number(m[1]) : null;
  };
  const total = num("tests");
  const failed = num("fail");
  const passed = num("pass");
  const skipped = num("skipped");
  if (total === null || failed === null) {
    return {
      ok: false,
      detail: `没有解析到 TAP 摘要（退出码 ${res.status}）—— 这个 rev 可能没有 test/ 目录或跑不起来`,
      counts: null,
      depsRelated: false,
    };
  }

  const notOk = [...res.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1].trim());
  // 树里没有 node_modules 时，缺的只可能是**开发期**二进制（ast-grep 等）。
  // 这种红不是产物的错，但也不能改成绿 —— 只把它指认出来，让人知道要不要加
  // --with-deps 复跑（`|| true` 那种「把红吞掉」的做法正是 WORKFLOW-1 的老账）。
  const missingDeps = /Cannot find module '[^']*node_modules[^']*'/.test(res.stdout);
  const depsRelated = !hasDeps && failed > 0 && missingDeps && notOk.length > 0;

  let detail = `pass ${passed ?? "?"} / fail ${failed} / skipped ${skipped ?? "?"} / 共 ${total}`;
  if (depsRelated) {
    detail += `（树里没有 node_modules：这 ${notOk.length} 条失败全是依赖解析失败，不是产物问题 —— ${notOk.slice(0, 2).join("、")}${notOk.length > 2 ? " …" : ""}。加 --with-deps 复跑）`;
  } else if (failed > 0 && !hasDeps) {
    detail += `（未挂依赖，失败可能来自缺二进制；加 --with-deps 复跑可区分）`;
  } else if (failed > 0) {
    detail += `（失败项：${notOk.slice(0, 3).join("、")}${notOk.length > 3 ? " …" : ""}）`;
  }
  return { ok: failed === 0, detail, counts: { total, passed, failed, skipped }, depsRelated };
}

async function checkFactory(tree) {
  const clientPath = join(tree, "client.js");
  if (!existsSync(clientPath)) return { ok: false, detail: "缺 client.js（这个 rev 还没提交产物）" };
  let evaluateFactory;
  try {
    ({ evaluateFactory } = await import(pathToFileURL(join(ROOT, "test", "helpers", "client-factory.mjs")).href));
  } catch (error) {
    fail(`共享桩 test/helpers/client-factory.mjs 不可用：${error.message}`);
  }
  try {
    const mod = evaluateFactory(clientPath);
    const shape = ["name", "inject", "apply"].filter((key) => key in mod).join("/");
    return { ok: true, detail: `factory 求值通过，exports 面 ${shape || "（空）"}` };
  } catch (error) {
    // 这一行就是主判据：语法合法但一加载就炸（v1.0.1/v1.0.2/v1.1.0 三个 tag 的死因）
    return { ok: false, detail: `${error.name}: ${error.message.split("\n")[0]}`, error };
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const commit = resolveRev(opts.rev);
  const short = commit.slice(0, 8);

  log(`[verify-rollback-point] rev：${opts.rev}（${short}）`);
  log(`[verify-rollback-point] 工作区：${ROOT}`);

  const workDir = mkdtempSync(join(tmpdir(), "dsh-rollback-"));
  cleanupDir = workDir;
  keepWorkDir = opts.keep;
  const tarPath = join(workDir, "archive.tar");
  const tree = join(workDir, "tree");
  try {
    log(`[verify-rollback-point] $ git archive --format=tar -o <tmp>/archive.tar ${opts.rev}`);
    run("git", ["archive", "--format=tar", "-o", tarPath, commit], { timeout: 300_000 });
    mkdirSync(tree, { recursive: true });

    const blobs = expectedBlobs(commit);
    if (blobs.length === 0) fail(`${opts.rev} 里没有文件（空 commit？）`);
    const unpacked = unpackArchive(tarPath, tree, blobs);
    log(`[verify-rollback-point] 解包：${unpacked.method} → ${blobs.length} 个文件逐个核对通过`);

    if (opts.withDeps) {
      const link = join(tree, "node_modules");
      try {
        symlinkSync(join(ROOT, "node_modules"), link, process.platform === "win32" ? "junction" : "dir");
        log(`[verify-rollback-point] 依赖：已把工作区 node_modules 挂进解包目录（${process.platform === "win32" ? "junction" : "软链"}）`);
      } catch (error) {
        log(`[verify-rollback-point] 依赖：挂载失败（${error.message}），继续按无依赖跑`);
      }
    } else {
      log("[verify-rollback-point] 依赖：未挂载（需要跑那个版本的完整测试时加 --with-deps）");
    }

    const artifact = join(tree, "client.js");
    if (existsSync(artifact)) {
      const bytes = readFileSync(artifact);
      log(
        `[verify-rollback-point] 产物：client.js ${bytes.toString("utf8").split("\n").length - 1} 行 / ` +
          `${bytes.length} B / sha256 ${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}…`,
      );
    }

    const importRow = await checkImport(tree);
    const testRow = checkTests(tree, { hasDeps: opts.withDeps });
    const factoryRow = await checkFactory(tree);

    log("");
    log(`回滚点验证矩阵：${opts.rev}（${short}）`);
    log(`  ${importRow.ok ? GREEN : RED} 导入    ${importRow.detail}`);
    log(`  ${testRow.ok ? GREEN : RED} 测试    ${testRow.detail}`);
    log(`  ${factoryRow.ok ? GREEN : RED} factory ${factoryRow.detail}`);

    const failed = [importRow, testRow, factoryRow].filter((row) => !row.ok);
    log("");
    if (failed.length === 0) {
      log(`结论：**可作回滚点** —— 导入 / 测试 / factory 三项全绿。`);
    } else {
      log(`结论：**不可作回滚点** —— ${failed.length}/3 项红。`);
      if (!factoryRow.ok) {
        log(`  factory 红 = 这个 rev 的产物一加载就炸（插件面板打不开），当年的 v1.0.1/v1.0.2/v1.1.0 就是这个形态。`);
      }
      if (!testRow.ok && testRow.depsRelated) {
        log(`  测试行的红是**环境**造成的（树里没有 node_modules，失败全是依赖解析），不是产物的错：加 --with-deps 复跑。`);
      } else if (!testRow.ok && !opts.withDeps) {
        log(`  测试行的红可能是「树里没有 node_modules」造成的，加 --with-deps 复跑一次再判。`);
      }
    }

    if (opts.keep) {
      log(`[verify-rollback-point] --keep：解包目录保留在 ${tree}`);
    } else {
      // 先清干净再设退出码：process.exit 会跳过 finally，所以收尾不能交给 finally
      rmSync(workDir, { recursive: true, force: true });
      cleanupDir = null;
    }
    process.exitCode = failed.length === 0 ? EXIT_OK : EXIT_RED;
  } finally {
    if (cleanupDir && !keepWorkDir) rmSync(cleanupDir, { recursive: true, force: true });
  }
}

await main();
