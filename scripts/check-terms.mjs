#!/usr/bin/env node
/**
 * scripts/check-terms.mjs — 术语账本禁用的同物异名，在白名单外零命中。
 *
 * 为什么存在：术语账本（docs/术语账本.md）禁用的同物异名原先靠自觉守——早先一轮的
 * 「槽位」三分收编走的是 grep 验收，仓中没有脚本，改词口径留不下机械护栏，新写
 * 一个禁用词就回来了。这里把「账本禁用的词不许出现在白名单外」变成逐行扫描的
 * 硬门禁，守的是全组文档与代码共用一个名字这条主线。
 *
 * 判据：禁用词在仓库全部文本文件里零命中，白名单两处——
 *   一、术语账本自身：它要能讨论禁词，否则禁用列失去对象；
 *   二、docs/dsh-native-primer.md：宿主文档语境把宿主概念的 slot 译作「槽位」，
 *      这是对原词的翻译，账本三条边界第三条明文豁免。
 *
 * 第三处白名单（`docs/rebuild/**` 冻结区）随 rebuild 组于 2026-10-27 整组退役而撤销：
 * 那一轮的历史文档已不在盘上，豁免没有对象；账本冻结区条款同步改写。
 *
 * 白名单的权威在术语账本而不在本脚本：账本不再出现某个禁用词、或不再写明 primer
 * 豁免时，本脚本 exit 2 逼人决策（要么改回账本，要么连同本门禁一起退役），不许
 * 静默放行。新增禁用词时改 TERMS 常量，并在账本禁用列能查到该词。
 *
 * 扫描范围也是判据：`SKIP_DIRS` 里的目录**不进扫描**，草稿区 `.scratch` 就在里头 ——
 * 它整份拷上游文档当审计对象，不按本仓库的措辞规范走。这个跳过必须能被证明是真的：
 * `test/terms-scope.test.mjs` 用同一份扫描实现分别带 / 不带 `.scratch` 跑一遍，
 * 带跳过时零命中、去掉跳过时命中 —— 少一边，那条豁免就是纸面承诺。
 *
 * 用法：node scripts/check-terms.mjs
 * 退出码：0 全过 / 1 有命中 / 2 环境错误（账本缺失或与白名单脱节）。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SKIP_DIRS, shouldSkipDir } from "./lib-skip-dirs.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER = join(ROOT, "docs", "术语账本.md");

const EXIT_OK = 0;
const EXIT_HIT = 1;
const EXIT_TOOLING = 2;

/**
 * 扫描范围也是判据：跳过清单里的目录**不进扫描**，草稿区 `.scratch` 就在里头 ——
 * 它整份拷上游文档当审计对象，不按本仓库的措辞规范走。清单只有一份，在
 * `scripts/lib-skip-dirs.mjs`：四个扫树门禁共用它，谁都不许再存一份自己的。
 *
 * 这个跳过必须能被证明是真的：`test/terms-scope.test.mjs` 用同一份扫描实现分别带 / 不带
 * `.scratch` 跑一遍，带跳过时零命中、去掉跳过时命中 —— 少一边，那条豁免就是纸面承诺。
 */
/** 二进制素材不扫：它们不是文本，读进来只会得到替换字符。 */
const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp",
  ".tgz", ".zip", ".woff", ".woff2", ".ttf", ".eot", ".pdf",
]);

/** 守卫的禁用词。新增词先改 docs/术语账本.md 的禁用列，再到这里登记。 */
export const TERMS = ["槽位"];

/**
 * 白名单路径（相对仓库根，正斜杠）。
 * 权威在术语账本：三条边界第三条豁免 primer。
 * 本脚本自身也在白名单里——门禁要能写出它守的词，否则判据无处安放。
 * 目录级豁免曾有一条 `docs/rebuild/`，随那组文档退役而撤销；再加目录前先改账本。
 */
const WHITELIST_FILES = new Set([
  "docs/术语账本.md",
  "docs/dsh-native-primer.md",
  "scripts/check-terms.mjs",
]);
const WHITELIST_PREFIXES = [];

const log = (msg) => process.stdout.write(`${msg}\n`);
const fail = (msg) => {
  process.stderr.write(`[check-terms] 无法完成检查：${msg}\n`);
  process.exit(EXIT_TOOLING);
};

/**
 * 递归收集待扫文本文件。
 *
 * `skipDirs` / `skipPrefixes` 由调用方给：缺省就是共享清单，用例换一份
 * （去掉 `.scratch`）再跑，用来证明「跳过确实生效」而不是「恰好在那边没有禁词」。
 *
 * @param {string} dir 起点目录
 * @param {string[]} [out] 结果累积
 * @param {{skipDirs?:Set<string>, skipPrefixes?:string[]}} [scope] 跳过口径
 * @returns {string[]} 绝对路径
 */
export function walk(dir, out = [], scope = {}) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name, scope)) continue;
      walk(abs, out, scope);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = abs.slice(abs.lastIndexOf("."));
    if (BINARY_EXTS.has(ext.toLowerCase())) continue;
    out.push(abs);
  }
  return out;
}

function isWhitelisted(rel, files = WHITELIST_FILES, prefixes = WHITELIST_PREFIXES) {
  return files.has(rel) || prefixes.some((p) => rel.startsWith(p));
}

/**
 * 扫描一棵树，返回命中明细。
 *
 * 与 CLI 入口用的是同一份实现：用例换 `skipDirs` 就能把「跳过清单生效」变成一条判据，
 * 而不是另写一份「测试专用的扫描」—— 两份实现里必然只有一份是真判据。
 *
 * @param {object} [options]
 * @param {string} [options.root] 树的根（相对路径的基准，也是白名单的基准）
 * @param {Set<string>} [options.skipDirs] 不进入扫描的目录名
 * @param {(msg: string) => void} [options.onReadError] 单个文件读不动时的回调
 * @returns {{scanned:number, hits:string[]}}
 */
export function scanTree(options = {}) {
  const root = options.root ?? ROOT;
  const skipDirs = options.skipDirs ?? SKIP_DIRS;
  const whitelistFiles = options.whitelistFiles ?? WHITELIST_FILES;
  const whitelistPrefixes = options.whitelistPrefixes ?? WHITELIST_PREFIXES;
  const terms = options.terms ?? TERMS;
  const onReadError = options.onReadError ?? (() => {});
  const files = walk(root, [], { skipDirs }).sort();
  const hits = [];
  let scanned = 0;
  for (const abs of files) {
    const rel = relative(root, abs).split(sep).join("/");
    if (isWhitelisted(rel, whitelistFiles, whitelistPrefixes)) continue;
    scanned += 1;
    let text;
    try {
      text = readFileSync(abs, "utf8");
    } catch (error) {
      onReadError(`${rel}: ${error.message}`);
      continue;
    }
    if (!terms.some((term) => text.includes(term))) continue;
    text.split("\n").forEach((line, i) => {
      for (const term of terms) {
        if (line.includes(term)) {
          hits.push(`${rel}:${i + 1}  禁用术语「${term}」：${line.trim().slice(0, 60)}`);
        }
      }
    });
  }
  return { scanned, hits };
}

/**
 * 账本与白名单不许脱节：禁词还在账本里、primer 豁免还写着，两个前提各查一句。
 * 账本被改写而脚本没跟上时，这里 exit 2 —— 门禁守的词以账本为权威。
 */
function checkLedgerAlignment() {
  if (!existsSync(LEDGER)) fail(`找不到 docs/术语账本.md（禁用词的唯一权威）`);
  const text = readFileSync(LEDGER, "utf8");
  for (const term of TERMS) {
    if (!text.includes(term)) {
      fail(`术语账本不再出现「${term}」——本门禁守的词已不在禁用表，请改回账本或连同本脚本一起退役`);
    }
  }
  const boundary = text.split("\n").find((line) => line.includes("三条边界"));
  if (!boundary || !boundary.includes("primer") || !boundary.includes("槽位")) {
    fail("术语账本的三条边界不再写明 primer 豁免——白名单失去依据，请改回账本或连同本脚本一起退役");
  }
}

function main() {
  checkLedgerAlignment();
  const { scanned, hits } = scanTree();

  log(`[check-terms] 扫描 ${scanned} 个文件（白名单外）；守卫 ${TERMS.length} 个禁用词，白名单 ${WHITELIST_FILES.size} 个文件 + ${WHITELIST_PREFIXES.length} 个目录`);
  if (hits.length === 0) {
    log("[check-terms] OK：白名单外禁用词零命中");
    process.exit(EXIT_OK);
  }
  for (const hit of hits) console.error(`[check-terms] ${hit}`);
  console.error(`[check-terms] 命中 ${hits.length} 处：按 docs/术语账本.md 的账本改词（禁用列查同物异名），确需豁免先改账本再改本脚本白名单`);
  process.exit(EXIT_HIT);
}

// 只在被当 CLI 调用时执行；被用例 import 时（取 scanTree）不产生副作用，
// 否则整轮测试会在导入阶段被 process.exit 带走。
const invoked = process.argv[1] ? resolve(process.argv[1]).toLowerCase() : "";
if (invoked && invoked === fileURLToPath(import.meta.url).toLowerCase()) main();
