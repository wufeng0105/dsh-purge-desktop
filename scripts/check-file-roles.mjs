#!/usr/bin/env node
/**
 * scripts/check-file-roles.mjs — 文件职责与体量的判定器。
 *
 * 为什么存在：一个文件一件事、单文件不超过 800 行，这两条原先只写在文档里靠自觉。
 * 结果是 lib/ 下 88 个文件里 13 个越过 800 行、几十个没有一句话说清自己为什么存在。
 * 判不了的才写文档；能按命令判的必须是命令 —— 这个脚本是「能判」的那一半。
 *
 * 判据一：文件头四行内有一行「<仓库相对路径> — <一句话>」。
 *   句子不超过 40 字；不许用「以及 / 同时 / 顺便 / 另外」把两件事拼成一句 ——
 *   一句话能拼出两件事，说明这个文件干了两件事。
 *
 * 判据二：单文件不超过 800 行。超了必须登记在 docs/布局约定.md 的豁免表里，
 *   类别只许三种：纯数据表、逐字复制的外部产物、已排期拆分（要写明排到哪一轮）。
 *   登记了却已经不存在、或已经降到 800 行以内的条目同样报红：豁免表是账本，不留死账。
 *
 * 判据三：豁免类别与理由都要能在豁免表里读到，缺「为什么不能切」的一句同样报红。
 *
 * 用法：node scripts/check-file-roles.mjs
 * 退出码：0 全过 / 1 有命中 / 2 环境错误（读不到 docs/布局约定.md）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { shouldSkipDir } from "./lib-skip-dirs.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAYOUT_DOC = join(ROOT, "docs", "布局约定.md");
const MAX_LINES = 800;
const MAX_SENTENCE = 40;
const CONJUNCTIONS = ["以及", "同时", "顺便", "另外"];
const EXEMPT_KINDS = ["纯数据表", "逐字复制的外部产物", "已排期拆分"];

const EXIT_OK = 0;
const EXIT_HIT = 1;
const EXIT_TOOLING = 2;

/** 扫描范围固定为交付物本身：运行期模块、脚本、CLI 入口。 */
const SCOPES = [
	{ dir: "lib", ext: [".js"] },
	{ dir: "scripts", ext: [".mjs"] },
	{ dir: "bin", ext: [".js"] },
];

const log = (msg) => process.stdout.write(`${msg}\n`);
const fail = (msg) => {
	process.stderr.write(`[check-file-roles] 无法完成检查：${msg}\n`);
	process.exit(EXIT_TOOLING);
};

function walk(dir, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) {
			// 跳过口径与其它扫树门禁共用一份，见 scripts/lib-skip-dirs.mjs。
			if (shouldSkipDir(entry.name)) continue;
			walk(abs, out);
		} else out.push(abs);
	}
	return out;
}

function collect() {
	const files = [];
	for (const scope of SCOPES) {
		const abs = join(ROOT, scope.dir);
		if (!existsSync(abs)) continue;
		for (const file of walk(abs)) {
			if (!scope.ext.includes(file.slice(file.lastIndexOf(".")))) continue;
			files.push(relative(ROOT, file).split(sep).join("/"));
		}
	}
	return files.sort();
}

/** 行数的唯一口径：数 LF，与 AGENTS.md 写的一致（Measure-Object 会把空行吃掉）。 */
function lineCount(rel) {
	const text = readFileSync(join(ROOT, rel), "utf8");
	return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/** 一行里抽出「路径 — 一句话」；路径必须与文件实际位置逐字相同，否则等于没写。 */
function roleLine(line) {
	const cleaned = line.replace(/^\s*(\/\/+|\*+|\/\*+)?\s*/, "").trim();
	const m = cleaned.match(/^(\S+?\.(?:js|mjs))\s+—\s+(.+)$/);
	if (!m) return null;
	return { path: m[1], sentence: m[2].trim().replace(/[。．.]+$/, "") };
}

function readExemptions() {
	if (!existsSync(LAYOUT_DOC)) fail(`找不到 ${relative(ROOT, LAYOUT_DOC)}（它是判据二的输入）`);
	const rows = new Map();
	for (const line of readFileSync(LAYOUT_DOC, "utf8").split("\n")) {
		if (!line.startsWith("|")) continue;
		const cells = line.split("|").slice(1, -1).map((c) => c.trim());
		if (cells.length < 3) continue;
		const path = cells[0].replace(/`/g, "").trim();
		if (!/\.(?:js|mjs)$/.test(path)) continue;
		rows.set(path, { kind: cells[1].replace(/`/g, "").trim(), why: cells[2].trim() });
	}
	return rows;
}

function main() {
	const exemptions = readExemptions();
	const files = collect();
	const roleHits = [];
	const sizeHits = [];
	const staleRows = [];
	const seen = new Set();

	for (const rel of files) {
		const lines = readFileSync(join(ROOT, rel), "utf8").split("\n");
		const candidates = lines.slice(0, 4).map(roleLine).filter(Boolean);
		const match = candidates.find((c) => c.path === rel) ?? candidates[0] ?? null;
		if (!match) {
			roleHits.push(`${rel}  头四行没有「路径 — 一句话」`);
		} else if (match.path !== rel) {
			roleHits.push(`${rel}  路径行写的是 ${match.path}（必须与文件位置逐字相同）`);
		} else if ([...match.sentence].length > MAX_SENTENCE) {
			roleHits.push(`${rel}  一句话 ${[...match.sentence].length} 字，超过 ${MAX_SENTENCE}`);
		} else {
			const conj = CONJUNCTIONS.find((c) => match.sentence.includes(c));
			if (conj) roleHits.push(`${rel}  一句话用「${conj}」拼了两件事`);
		}

		const n = lineCount(rel);
		seen.add(rel);
		if (n <= MAX_LINES) continue;
		const exemption = exemptions.get(rel);
		if (!exemption) {
			sizeHits.push(`${rel}  ${n} 行，超 ${MAX_LINES} 且未登记豁免`);
			continue;
		}
		const kind = EXEMPT_KINDS.find((k) => exemption.kind.startsWith(k));
		if (!kind) {
			sizeHits.push(`${rel}  豁免类别「${exemption.kind}」不属三种之一`);
		} else if (!exemption.why || [...exemption.why].length < 10) {
			sizeHits.push(`${rel}  豁免缺「为什么不能切」的一句`);
		} else if (kind === "已排期拆分" && !/第\s*[0-9一二三四五六七八九十]+\s*轮/.test(exemption.why)) {
			sizeHits.push(`${rel}  已排期拆分没写明排到哪一轮`);
		}
	}

	for (const path of exemptions.keys()) {
		if (!seen.has(path)) staleRows.push(`${path}  登记了豁免，但文件不存在或不在扫描范围`);
		else if (lineCount(path) <= MAX_LINES) staleRows.push(`${path}  登记了豁免，但已降到 ${MAX_LINES} 行以内`);
	}

	const groups = [
		["职责行", roleHits],
		["体量", sizeHits],
		["死账", staleRows],
	];

	log(`[check-file-roles] 扫描 ${files.length} 个文件（lib/**/*.js、scripts/**/*.mjs、bin/**/*.js）`);
	log(`[check-file-roles] 豁免表 ${exemptions.size} 条（${relative(ROOT, LAYOUT_DOC).split(sep).join("/")}）`);
	let total = 0;
	for (const [label, hits] of groups) {
		total += hits.length;
		if (hits.length === 0) continue;
		log(`\n${label}：${hits.length} 条`);
		for (const hit of hits) log(`  ${hit}`);
	}
	if (total > 0) {
		log(`\n[check-file-roles] 失败：${total} 条。`);
		process.exit(EXIT_HIT);
	}
	log("[check-file-roles] OK：所有文件都有一句话职责，超 800 行的都有豁免依据");
	process.exit(EXIT_OK);
}

main();
