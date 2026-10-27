#!/usr/bin/env node
/**
 * scripts/check-comments.mjs — 注释四条硬规矩的判定器。
 *
 * 为什么存在：注释规范的绝大部分要求（写为什么、不复述代码）人才能判，
 * 但其中四条可以逐字符判，那就别留给自觉。判据全部只看注释正文，
 * 不看字符串字面量 —— 演练台报告里的「§」是产出内容，不是坐标引用。
 *
 * 判据 A：块注释的第一行是散文时必须是简体中文。带 @ 的 JSDoc 标签行不算散文。
 * 判据 B：不许坐标式引用（「§」后跟数字，或「见某文档 §几」）。
 *   结论要自包含：读者不该为了看懂一句注释去翻另一份文档的某一节。
 * 判据 C：不许出现未登记的编号（形如 `大写字母开头的前缀-数字`，前缀可含数字）。
 *   合法编号的唯一权威是 docs/约束索引.md；编码名与 CVE 号不是本仓库编号。
 *   白名单按约束索引全表构造 —— 只认短前缀会让 SURFACE/PATCH/AUDIT 这类编号整族漏检。
 * 判据 D：待办与待修标记必须带条件，形如 `TODO(条件)`；空条件等于没人负责。
 * 判据 E：连续两行空注释（只有 // 的行）算红 —— 那是拿注释拼块，不是写为什么。
 *
 * 用法：node scripts/check-comments.mjs
 * 退出码：0 全过 / 1 有命中 / 2 环境错误（读不到约束索引）。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { shouldSkipDir } from "./lib-skip-dirs.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONSTRAINTS = join(ROOT, "docs", "约束索引.md");
const SCOPES = ["lib", "scripts", "test", "bin"];
const EXTS = [".js", ".mjs"];
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;
const PROSE_MAX = 20;

const EXIT_OK = 0;
const EXIT_HIT = 1;
const EXIT_TOOLING = 2;

/** 编号形状：前缀以大写字母开头、可含数字，短横后接 1–3 位序号。白名单与扫描共用这一条。 */
const ID_PATTERN = /\b[A-Z][A-Z0-9]*-\d{1,3}\b/g;

/** 不是本仓库编号的短横编号：编码名与 CVE 号，它们有各自的外部权威。 */
const FOREIGN_IDS = new Set(["UTF-8", "UTF-16", "ISO-8859-1", "SHA-1", "SHA-256", "SHA-384", "SHA-512"]);

const log = (msg) => process.stdout.write(`${msg}\n`);
const fail = (msg) => {
	process.stderr.write(`[check-comments] 无法完成检查：${msg}\n`);
	process.exit(EXIT_TOOLING);
};

function walk(dir, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) {
			// 跳过口径与其它扫树门禁共用一份，见 scripts/lib-skip-dirs.mjs。
			if (shouldSkipDir(entry.name)) continue;
			walk(abs, out);
		} else if (EXTS.includes(abs.slice(abs.lastIndexOf(".")))) out.push(abs);
	}
	return out;
}

/**
 * 注释抽取：只认注释，跳过单引号 / 双引号 / 模板字符串与正则字面量。
 * 不追求完整解析器，只要求「字符串里的 § 与编号不算命中」这条判据成立。
 */
function scanComments(text) {
	const out = [];
	let i = 0;
	let line = 1;
	let quote = null;
	const regexStart = /[=(,:![&|?{};+\-*%<>~^]$/;

	while (i < text.length) {
		const c = text[i];
		const next = text[i + 1];
		if (quote) {
			if (c === "\\") {
				i += 2;
				continue;
			}
			if (c === "\n") line += 1;
			if (c === quote) quote = null;
			i += 1;
			continue;
		}
		if (c === "\n") {
			line += 1;
			i += 1;
			continue;
		}
		if (c === "'" || c === '"' || c === "`") {
			quote = c;
			i += 1;
			continue;
		}
		if (c === "/" && next === "/") {
			const start = line;
			let j = i + 2;
			let body = "";
			while (j < text.length && text[j] !== "\n") {
				body += text[j];
				j += 1;
			}
			out.push({ kind: "line", line: start, body });
			i = j;
			continue;
		}
		if (c === "/" && next === "*") {
			const start = line;
			const doc = text[i + 2] === "*";
			let j = i + 2;
			let body = "";
			while (j < text.length && !(text[j] === "*" && text[j + 1] === "/")) {
				if (text[j] === "\n") line += 1;
				body += text[j];
				j += 1;
			}
			out.push({ kind: doc ? "doc" : "block", line: start, body });
			i = j + 2;
			continue;
		}
		if (c === "/" && (i === 0 || regexStart.test(text[i - 1]))) {
			let j = i + 1;
			let inClass = false;
			while (j < text.length) {
				const d = text[j];
				if (d === "\\") {
					j += 2;
					continue;
				}
				if (d === "[") inClass = true;
				else if (d === "]") inClass = false;
				else if (d === "/" && !inClass) break;
				else if (d === "\n") break;
				j += 1;
			}
			i = j + 1;
			continue;
		}
		i += 1;
	}
	return out;
}

function firstProseLine(body) {
	for (const raw of body.split("\n")) {
		const text = raw.replace(/^\s*\*+/u, "").trim();
		if (text) return text;
	}
	return "";
}

function readWhitelist() {
	if (!existsSync(CONSTRAINTS)) fail(`找不到 ${relative(ROOT, CONSTRAINTS)}（编号的唯一权威）`);
	const ids = new Set();
	// 全表构造：不按前缀长度筛，否则新增一个长前缀领域就会整族静默漏检。
	for (const m of readFileSync(CONSTRAINTS, "utf8").matchAll(ID_PATTERN)) ids.add(m[0]);
	for (const id of FOREIGN_IDS) ids.add(id);
	return ids;
}

function main() {
	const whitelist = readWhitelist();
	const files = [];
	for (const scope of SCOPES) {
		const abs = join(ROOT, scope);
		if (existsSync(abs)) files.push(...walk(abs));
	}
	files.sort();

	const hits = [];
	for (const abs of files) {
		const rel = relative(ROOT, abs).split(sep).join("/");
		const text = readFileSync(abs, "utf8");
		const comments = scanComments(text);
		for (const comment of comments) {
			const head = ` ${rel}:${comment.line}`;
			if (comment.kind === "doc") {
				const prose = firstProseLine(comment.body);
				const isTag = prose.startsWith("@");
				if (!isTag && !CJK.test(prose) && [...prose].length > PROSE_MAX) {
					hits.push(`A${head}  块注释首行不是中文：${prose.slice(0, 48)}`);
				}
			}
			if (/§\s*\d/.test(comment.body)) {
				hits.push(`B${head}  坐标式引用：${comment.body.trim().split("\n")[0].slice(0, 48)}`);
			}
			// CVE 号自身带短横，先整段抹掉再找编号；只认年份格式会让 CVE-123 这类残留被误报。
			const withoutCve = comment.body.replace(/\bCVE-\d+(?:-\d+)*\b/g, "");
			for (const m of withoutCve.matchAll(ID_PATTERN)) {
				if (whitelist.has(m[0])) continue;
				hits.push(`C${head}  未登记编号 ${m[0]}`);
			}
			for (const m of comment.body.matchAll(/\b(TODO|FIXME)\b(\s*\(([^)]*)\))?/g)) {
				if (!m[2] || !m[3].trim()) hits.push(`D${head}  ${m[1]} 没有条件`);
			}
		}
		const lines = text.split("\n");
		for (let i = 1; i < lines.length; i += 1) {
			if (/^\s*\/\/\s*$/.test(lines[i]) && /^\s*\/\/\s*$/.test(lines[i - 1])) {
				hits.push(`E ${rel}:${i + 1}  连续两行空注释`);
			}
		}
	}

	log(`[check-comments] 扫描 ${files.length} 个文件（lib / scripts / test / bin）`);
	log(`[check-comments] 白名单编号 ${whitelist.size} 个（docs/约束索引.md + 编码名与 CVE）`);
	if (hits.length === 0) {
		log("[check-comments] OK：四条判据零命中");
		process.exit(EXIT_OK);
	}
	const byRule = new Map();
	for (const hit of hits) {
		const rule = hit[0];
		byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
	}
	log(`[check-comments] 命中 ${hits.length} 条：${[...byRule].sort().map(([k, n]) => `${k}×${n}`).join(" ")}`);
	for (const hit of hits) log(`  ${hit}`);
	process.exit(EXIT_HIT);
}

main();
