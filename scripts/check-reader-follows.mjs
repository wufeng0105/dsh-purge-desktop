#!/usr/bin/env node
/**
 * scripts/check-reader-follows.mjs — 日志规格常量的读者必须跟随常量，不许重抄字面量。
 *
 * 为什么存在：写侧把 `LOG_ROLLING.generations` 从 1 改成 8 时，读侧仍写着 `[.1, file]` ——
 * 磁盘上留着 8 代，而 `audit why` 永远说「查无此轮」。证据在、读不到，这是最坏的一种
 * 不一致：它看起来像「那一轮没跑过」。跟随原先靠人肉，改一次常量就得回想一遍谁在读，
 * 漏一个不会有任何症状。这里把「法规常量 → 读者清单」登记成表，两件事逐条判：
 *
 *   一、**读者引用了常量**：登记在清单里的每个读者，源码里必须出现那个常量名。
 *      读者自己算一遍所谓「常识数字」，就等于把规格抄了第二份。
 *   二、**读者没有重抄字面量**：按常量各自的「抄写形状」扫（例如把「上一代」写死成
 *      `` `${file}.1` ``、或者 `generations: 8`）。形状逐条写在登记表里，都是有来历的：
 *      每一条都对应一次「写侧改了、读侧没跟」。
 *   三、**行为探针**（`LOG_ROLLING.generations` 独有）：在临时 DSH_HOME 里把唯一一条
 *      诊断行放进**最老那一代**，再跑一遍真正的读侧入口（`audit why`）。读者只认两代
 *      时这一条必然红 —— 这是把「跟随」从文本判据升级成行为判据的那一半。
 *
 * 规格值只从定义文件里读一次，不 import 运行期代码：脚本与 lib 的生命周期不许绑在一起
 * （依赖规则里 `scripts/` 不许 import `lib/`），要行为就起子进程。
 *
 * 用法：node scripts/check-reader-follows.mjs
 * 退出码：0 全过 / 1 有读者没跟随 / 2 环境错误（读不到定义文件或探针跑不起来）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const EXIT_OK = 0;
const EXIT_HIT = 1;
const EXIT_TOOLING = 2;

/**
 * 规格常量 → 读者清单。
 *
 * `valuePattern` 是这个常量在定义文件里的唯一声明形状：脚本只从这里取数值，
 * 定义与取值仍然是同一个权威（定义文件），不存在第二份数字。
 *
 * `forbidden` 的每条 `re` 都是「读者重抄了这个规格」的形状。逐条都有来历：
 *   · `${file}.1` —— `diagFiles` 曾经写死 `[.1, file]`，多代日志只读得到两代；
 *   · `generations: <数字>` / `rotation <= <数字>` / `retainDays: <数字>` —— 读者自己
 *     另订一个上限，写侧改常量的那天它不会跟着动；
 *   · `MAX_FILE_BYTES = <数字>` —— 在读者里重新定义上限，等于有了两个上限。
 */
const SPECS = [
  {
    spec: "LOG_ROLLING.generations",
    definedIn: "lib/log-rolling.js",
    valuePattern: /generations:\s*(\d+)/,
    readers: [
      { file: "lib/audit/query.js", needle: "LOG_ROLLING.generations" },
      { file: "lib/diag-log.js", needle: "LOG_ROLLING" },
    ],
    forbidden: [
      { re: /`\$\{[^}`]*\}\.\d+`/g, why: "把「上一代」写死成 .<数字>：代数变了读者不会跟" },
      { re: /\bgenerations\s*[:=]\s*\d+/g, why: "读者里重抄代数：应从 lib/log-rolling.js 取" },
    ],
    probe: "diag-generations",
  },
  {
    spec: "MAX_DAY_ROTATIONS",
    definedIn: "lib/audit/store.js",
    valuePattern: /const MAX_DAY_ROTATIONS = (\d+);/,
    exporters: ["lib/audit/store.js"],
    readers: [{ file: "lib/audit/store.js", needle: "MAX_DAY_ROTATIONS" }],
    forbidden: [
      { re: /\brotation\s*<=\s*\d+/g, why: "读者自己写死同日代数上限" },
    ],
  },
  {
    spec: "RETAIN_DAYS",
    definedIn: "lib/audit/store.js",
    valuePattern: /const RETAIN_DAYS = (\d+);/,
    exporters: ["lib/audit/store.js"],
    readers: [{ file: "lib/audit/store.js", needle: "RETAIN_DAYS" }],
    forbidden: [
      { re: /\bretainDays\s*[:=]\s*\d+/g, why: "读者自己写死保留天数" },
    ],
  },
  {
    spec: "MAX_FILE_BYTES",
    definedIn: "lib/audit/store.js",
    valuePattern: /export const MAX_FILE_BYTES = (\d+);/,
    readers: [{ file: "lib/audit/store.js", needle: "MAX_FILE_BYTES" }],
    forbidden: [
      { re: /\bMAX_FILE_BYTES\s*=\s*\d+/g, why: "读者里重新定义单文件上限：等于有两个上限" },
    ],
  },
];

const log = (msg) => process.stdout.write(`${msg}\n`);
const fail = (msg) => {
  process.stderr.write(`[check-reader-follows] 无法完成检查：${msg}\n`);
  process.exit(EXIT_TOOLING);
};

/** 定义文件里的数值。取不到就是登记表与代码脱节，按环境错误报 2。 */
function specValue(entry) {
  const abs = join(ROOT, entry.definedIn);
  if (!existsSync(abs)) fail(`读不到规格定义文件 ${entry.definedIn}`);
  const text = readFileSync(abs, "utf8");
  const m = entry.valuePattern.exec(text);
  if (!m) fail(`${entry.definedIn} 里找不到 ${entry.spec} 的声明（登记表的形状过时了）`);
  // 声明所在行是唯一允许出现那个数字的地方：定义文件同时是「写侧」，不属于重抄。
  return { value: Number(m[1]), declaredLine: lineOf(text, m.index) };
}

/** 一行里的位置，只为人能直接跳过去看。 */
function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

function checkEntry(entry, hits) {
  const { value, declaredLine } = specValue(entry);
  const ownText = readFileSync(join(ROOT, entry.definedIn), "utf8");
  for (const rel of entry.exporters ?? []) {
    if (!new RegExp(`export const ${entry.spec}\\b`).test(ownText)) {
      hits.push(`${rel}  没有导出 ${entry.spec}：读者拿不到它，只能自己写死`);
    }
  }
  if (!Number.isInteger(value) || value < 1) {
    hits.push(`${entry.definedIn}  ${entry.spec} 的值不是正整数（读到 ${value}）`);
  }
  for (const reader of entry.readers) {
    const abs = join(ROOT, reader.file);
    if (!existsSync(abs)) {
      hits.push(`${reader.file}  登记为 ${entry.spec} 的读者，但文件不存在`);
      continue;
    }
    const text = readFileSync(abs, "utf8");
    if (!text.includes(reader.needle)) {
      hits.push(`${reader.file}  读者没有引用 ${reader.needle}：规格改了它不会跟`);
    }
    for (const rule of entry.forbidden) {
      for (const m of text.matchAll(rule.re)) {
        const line = lineOf(text, m.index);
        if (reader.file === entry.definedIn && line === declaredLine) continue;
        hits.push(`${reader.file}:${line}  ${rule.why}（${m[0].trim()}）`);
      }
    }
  }
  return value;
}

/**
 * 行为探针：把唯一一条诊断行放进最老那一代，再用真正的读侧入口捞它。
 *
 * 为什么还要这一条：文本判据只能证明「读者提到了常量名」，证明不了「循环真的跑到第 N 代」。
 * 早先那次回归（`[.1, file]`）里，读者本来就没有引用常量 —— 文本判据能抓到；但反过来
 * 写的 `for (let i = 1; i <= 2; i++)` 也能叫出常量名。探针按规格值造夹具，改常量它跟着变。
 *
 * @param {number} generations `LOG_ROLLING.generations` 的当前值
 * @returns {string[]} 失败明细
 */
function probeDiagGenerations(generations) {
  const home = mkdtempSync(join(os.tmpdir(), "dsh-purge-reader-"));
  const runId = "apply-19700101T000000Z-0000";
  try {
    const dir = join(home, "dsh-purge", "logs");
    mkdirSync(dir, { recursive: true });
    const row = {
      ts: "2026-01-01T00:00:00.000Z",
      event: "apply.start",
      patches: "1",
      selected: "1",
      entry: "cli",
      runId,
    };
    // 主文件故意不写：要读到它，只能按代数一路找过去。
    writeFileSync(join(dir, `diag.jsonl.${generations}`), `${JSON.stringify(row)}\n`, "utf8");
    const run = spawnSync(process.execPath, [join(ROOT, "bin", "dsh-purge.js"), "audit", "why", runId], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, DSH_HOME: home, DSH_PURGE_LOG: "0" },
    });
    if (run.status === 0 && String(run.stdout).includes("event=apply.start")) return [];
    if (run.status === 1 && String(run.stdout).includes("查无此 runId")) {
      return [
        `lib/audit/query.js  只放在第 ${generations} 代的诊断行读不到（audit why 报查无此轮）：`
        + "读者没有跟到 LOG_ROLLING.generations 那一代",
      ];
    }
    fail(`探针跑不起来：bin/dsh-purge.js 退出码 ${run.status}\n${String(run.stderr).slice(0, 800)}`);
    return [];
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function main() {
  const hits = [];
  const values = new Map();
  for (const entry of SPECS) values.set(entry.spec, checkEntry(entry, hits));
  for (const entry of SPECS) {
    if (entry.probe !== "diag-generations") continue;
    hits.push(...probeDiagGenerations(values.get(entry.spec)));
  }

  log(
    `[check-reader-follows] 登记 ${SPECS.length} 个规格常量、`
    + `${SPECS.reduce((n, e) => n + e.readers.length, 0)} 个读者；`
    + `数值 ${[...values].map(([k, v]) => `${k}=${v}`).join(" / ")}`,
  );
  if (hits.length === 0) {
    log("[check-reader-follows] OK：读者全部引用常量，无重抄字面量，行为探针通过");
    process.exit(EXIT_OK);
  }
  for (const hit of hits) console.error(`[check-reader-follows] ${hit}`);
  console.error(
    `[check-reader-follows] 命中 ${hits.length} 处：读者改成引用常量（或把规格值从定义文件取），别自己再订一份`,
  );
  process.exit(EXIT_HIT);
}

main();
