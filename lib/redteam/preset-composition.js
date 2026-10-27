/**
 * lib/redteam/preset-composition.js — 预设 YAML 子集的只读解析器，只认随包那一份。
 * 智能体预设组成读取器。
 * 为 registry.register() 解析 presets/redteam/{agent.cordis.yml,preset.yml}。
 */
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
* 演练台预设组成读取器：够用的 YAML 就到这里为止，把随包的
* `presets/redteam/agent.cordis.yml` —— 连同它旁边那份扁平的 `preset.yml`
* 展示映射 —— 转成智能体预设注册表接受的那份声明。
*
* 0.1.7 起预设是一份普通的注册声明，不再是宿主自己发现的目录，所以本插件把
* **自己**那份组成的行交给 `ctx.agentPresets`。本包解析不到任何 YAML 包，
* 宿主的读取器也无法从这里导入，所以这个子集由本文件自己持有；随包那份组成
* 是它唯一必须读的文件，测试就拿整份文件给它圈边界。受支持的写法：块映射与
* 块序列、带引号与无引号的标量、单行流式序列、字面块与折叠块标量、注释，以及
* 按数据原样保留的 `!!js` 表达式（`{ __jsExpr }`，即 Loader 交给插件的形状）。
*
* 失败即拒：子集之外的构造 —— 锚点、别名、`!!js` 之外的标签、嵌套流式集合、
* 多文档、制表符 —— 抛 {@link CompositionError}，而不是去猜，所以读不懂的组成
* 会被拒绝，不会被声明一半。
*
* 相对模块名（`name: ./minimal-prompt.mjs`）按交给 {@link readCompositionRows}
* 的预设目录解析，并以 file URL 形式给出：注册表把声明挂到**声明方 Loader** 的
* 基址下，相对名否则会解析到本包之外去。
* @module dsh-purge/redteam/preset-composition
*/
/** 子集之外的构造，或格式错误的 YAML。 */
var CompositionError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "CompositionError";
	}
};
const BLANK_OR_COMMENT_RE = /^[ \t]*(?:#.*)?$/;
const INTEGER_RE = /^[+-]?\d+$/;
const FLOAT_RE = /^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/;
/** 一行的缩进宽度（即行首空格数）。 */
function indentOf(line) {
	const match = /^ */.exec(line);
	return match === null ? 0 : match[0].length;
}
/**
* 一行结构上有意义的缩进。这里出现制表符是 YAML 禁止的；块标量的内容是
* 逐字原文，从不在这里量缩进。
*/
function significantIndent(line, lineNumber) {
	const leading = /^[ \t]*/.exec(line)?.[0] ?? "";
	if (leading.includes("	")) throw new CompositionError(`line ${String(lineNumber)}: tabs must not be used for indentation`);
	return leading.length;
}
/** 跳过空行与只含注释的行。 */
function skipInsignificant(cursor) {
	while (cursor.index < cursor.lines.length && BLANK_OR_COMMENT_RE.test(cursor.lines[cursor.index] ?? "")) cursor.index += 1;
}
/** `indent` 处这一行是否开启一个块序列条目。 */
function isSequenceEntry(line, indent) {
	if (line[indent] !== "-") return false;
	return line.length === indent + 1 || line[indent + 1] === " ";
}
/** 从下标 0 起的带引号标量，其收尾引号所在的下标。 */
function closingQuote(text) {
	const quote = text[0];
	for (let index = 1; index < text.length; index += 1) {
		const char = text[index];
		if (quote === "\"" && char === "\\") {
			index += 1;
			continue;
		}
		if (quote === "'" && char === "'" && text[index + 1] === "'") {
			index += 1;
			continue;
		}
		if (char === quote) return index;
	}
	return -1;
}
/** 解析一个带引号标量；不带引号时原样返回文本。 */
function unquote(text) {
	const trimmed = text.trim();
	if (trimmed.startsWith("\"")) {
		const end = closingQuote(trimmed);
		if (end !== trimmed.length - 1) throw new CompositionError(`unterminated double-quoted scalar: ${trimmed}`);
		return trimmed.slice(1, end).replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, escape) => {
			switch (escape[0]) {
				case "n": return "\n";
				case "t": return "	";
				case "r": return "\r";
				case "0": return "\0";
				case "u":
				case "x": return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
				default: return escape;
			}
		});
	}
	if (trimmed.startsWith("'")) {
		const end = closingQuote(trimmed);
		if (end !== trimmed.length - 1) throw new CompositionError(`unterminated single-quoted scalar: ${trimmed}`);
		return trimmed.slice(1, end).replaceAll("''", "'");
	}
	return trimmed;
}
/** 把一行块映射拆成键与冒号之后的原始文本。 */
function matchKeyEntry(text) {
	if (text.startsWith("'") || text.startsWith("\"")) {
		const end = closingQuote(text);
		if (end === -1) return void 0;
		const after = text.slice(end + 1).trimStart();
		if (!after.startsWith(":")) return void 0;
		return {
			key: unquote(text.slice(0, end + 1)),
			rest: after.slice(1).trim()
		};
	}
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (char === "#" && index > 0 && text[index - 1] === " ") break;
		if (char === ":" && (index + 1 === text.length || text[index + 1] === " ")) return {
			key: text.slice(0, index),
			rest: text.slice(index + 1).trim()
		};
	}
}
/** 把无引号标量解析成 YAML 的 JSON schema 会给出的那个值。 */
function plainScalar(text) {
	const comment = text.indexOf(" #");
	const value = (comment === -1 ? text : text.slice(0, comment)).trim();
	if (value === "" || value === "~" || value === "null" || value === "Null" || value === "NULL") return null;
	if (value === "true" || value === "True" || value === "TRUE") return true;
	if (value === "false" || value === "False" || value === "FALSE") return false;
	if (INTEGER_RE.test(value)) return Number(value);
	if (FLOAT_RE.test(value)) return Number(value);
	return value;
}
/**
* 读一个单行流式序列（`['mcp__*']`），取出它的各项标量。
* 嵌套的流式集合在子集之外，一律拒绝。
*/
function flowSequence(text) {
	const end = text.lastIndexOf("]");
	if (end === -1) throw new CompositionError(`unterminated flow sequence: ${text}`);
	const tail = text.slice(end + 1).trim();
	if (tail !== "" && !tail.startsWith("#")) throw new CompositionError(`unexpected content after a flow sequence: ${tail}`);
	const body = text.slice(1, end);
	if (body.trim() === "") return [];
	const items = [];
	for (const raw of body.split(",")) {
		const item = raw.trim();
		if (item === "") throw new CompositionError(`empty item in a flow sequence: ${text}`);
		if (item.startsWith("[") || item.startsWith("{")) throw new CompositionError(`nested flow collections are not supported: ${item}`);
		items.push(inlineScalar(item));
	}
	return items;
}
/** 解析同一行里冒号或破折号之后的那段文本。 */
function inlineScalar(text) {
	const value = text.trim();
	if (value.startsWith("!!js")) {
		const expression = value.slice(4).trim();
		if (expression === "") throw new CompositionError("!!js requires an expression");
		return { __jsExpr: unquote(expression) };
	}
	if (value.startsWith("'") || value.startsWith("\"")) {
		const end = closingQuote(value);
		if (end === -1) throw new CompositionError(`unterminated quoted scalar: ${value}`);
		const tail = value.slice(end + 1).trim();
		if (tail !== "" && !tail.startsWith("#")) throw new CompositionError(`unexpected content after a quoted scalar: ${tail}`);
		return unquote(value.slice(0, end + 1));
	}
	if (value.startsWith("[")) return flowSequence(value);
	if (value.startsWith("{")) throw new CompositionError(`flow mappings are not supported: ${value}`);
	if (value.startsWith("|") || value.startsWith(">")) throw new CompositionError(`block scalars need their own line: ${value}`);
	if (value.startsWith("!") || value.startsWith("&") || value.startsWith("*")) throw new CompositionError(`unsupported YAML node: ${value}`);
	return plainScalar(value);
}
/**
* 读一个字面（`|`）或折叠（`>`）块标量，并吃掉它占的那些行。
* @param cursor - 行游标，停在头部那一行的下一行。
* @param parentIndent - 拥有该标量的那个节点的缩进。
* @param header - 头部文本（`|-`、`>+2` 等），可能带注释。
* @returns 去掉缩进并按 chomping 规则处理之后的标量文本。
*/
function blockScalar(cursor, parentIndent, header) {
	const style = header[0];
	const indicators = header.slice(1).split("#")[0]?.trim() ?? "";
	let explicitIndent;
	let chomp = "clip";
	for (const char of indicators) if (char === "-") chomp = "strip";
	else if (char === "+") chomp = "keep";
	else if (char >= "1" && char <= "9") explicitIndent = Number(char);
	else throw new CompositionError(`unsupported block scalar header: ${header}`);
	const body = [];
	let blockIndent;
	let trailing = 0;
	while (cursor.index < cursor.lines.length) {
		const line = cursor.lines[cursor.index] ?? "";
		if (line.trim() === "") {
			body.push("");
			trailing += 1;
			cursor.index += 1;
			continue;
		}
		const indent = indentOf(line);
		if (indent <= parentIndent) break;
		if (blockIndent === void 0) blockIndent = explicitIndent === void 0 ? indent : parentIndent + explicitIndent;
		if (indent < blockIndent) break;
		body.push(line.slice(blockIndent));
		trailing = 0;
		cursor.index += 1;
	}
	const lines = body.slice(0, body.length - trailing);
	if (style === ">") {
		let folded = "";
		let blank = 0;
		let started = false;
		for (const line of lines) {
			if (line === "") {
				blank += 1;
				continue;
			}
			if (!started) {
				folded = line;
				started = true;
				blank = 0;
				continue;
			}
			folded += blank === 0 ? " " + line : "\n".repeat(blank) + line;
			blank = 0;
		}
		if (chomp === "strip") return folded;
		if (chomp === "keep") return folded + "\n".repeat(trailing + 1);
		return folded === "" ? "" : folded + "\n";
	}
	const text = lines.join("\n");
	if (chomp === "strip") return text;
	if (chomp === "keep") return text + "\n".repeat(trailing + 1);
	return text === "" ? "" : text + "\n";
}
/** 解析一个条目的值，该条目所在的行已经被吃掉。 */
function parseValue(cursor, parentIndent, rest) {
	if (rest !== "") {
		if (rest.startsWith("|") || rest.startsWith(">")) return blockScalar(cursor, parentIndent, rest);
		return inlineScalar(rest);
	}
	skipInsignificant(cursor);
	const line = cursor.lines[cursor.index];
	if (line === void 0 || indentOf(line) <= parentIndent) return null;
	return parseNode(cursor, parentIndent + 1);
}
/** 解析一个块映射，它的键正好落在 `indent` 处。 */
function parseMap(cursor, indent) {
	const map = {};
	while (true) {
		skipInsignificant(cursor);
		const line = cursor.lines[cursor.index];
		if (line === void 0) break;
		const lineIndent = significantIndent(line, cursor.index + 1);
		if (lineIndent < indent) break;
		if (lineIndent > indent) throw new CompositionError(`line ${String(cursor.index + 1)}: unexpected indentation`);
		if (isSequenceEntry(line, indent)) break;
		const entry = matchKeyEntry(line.slice(indent));
		if (entry === void 0) throw new CompositionError(`line ${String(cursor.index + 1)}: expected "key: value", got "${line.trim()}"`);
		if (Object.hasOwn(map, entry.key)) throw new CompositionError(`line ${String(cursor.index + 1)}: duplicate key "${entry.key}"`);
		cursor.index += 1;
		map[entry.key] = parseValue(cursor, indent, entry.rest);
	}
	return map;
}
/** 解析一个块序列，它的破折号正好落在 `indent` 处。 */
function parseSequence(cursor, indent) {
	const items = [];
	while (true) {
		skipInsignificant(cursor);
		const line = cursor.lines[cursor.index];
		if (line === void 0) break;
		if (significantIndent(line, cursor.index + 1) !== indent || !isSequenceEntry(line, indent)) break;
		const rest = line.slice(indent + 1);
		const content = rest.trimStart();
		if (content === "") {
			cursor.index += 1;
			skipInsignificant(cursor);
			const nested = cursor.lines[cursor.index];
			const nestedIndent = nested === void 0 ? -1 : significantIndent(nested, cursor.index + 1);
			items.push(nestedIndent <= indent ? null : parseNode(cursor, indent + 1));
			continue;
		}
		const contentIndent = indent + 1 + (rest.length - content.length);
		if (matchKeyEntry(content) !== void 0) {
			cursor.lines[cursor.index] = " ".repeat(contentIndent) + content;
			items.push(parseMap(cursor, contentIndent));
			continue;
		}
		cursor.index += 1;
		items.push(parseValue(cursor, indent, content));
	}
	return items;
}
/** 解析从游标处开始的块节点。 */
function parseNode(cursor, minIndent) {
	skipInsignificant(cursor);
	const line = cursor.lines[cursor.index];
	if (line === void 0) return null;
	const indent = significantIndent(line, cursor.index + 1);
	if (indent < minIndent) return null;
	return isSequenceEntry(line, indent) ? parseSequence(cursor, indent) : parseMap(cursor, indent);
}
/** 读一个 cordis YAML 文档（条目列表，或 `preset.yml` 的扁平映射）。 */
function readYaml(text) {
	const cursor = {
		lines: (text.startsWith("﻿") ? text.slice(1) : text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n"),
		index: 0
	};
	const value = parseNode(cursor, 0);
	skipInsignificant(cursor);
	const extra = cursor.lines[cursor.index];
	if (extra !== void 0) throw new CompositionError(`line ${String(cursor.index + 1)}: unexpected content "${extra.trim()}"`);
	return value;
}
/** 解析出来的值是否是一条组成行（带字符串 `name` 的映射）。 */
function asRow(value, at) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CompositionError(`${at} is not a plugin row (expected a map with a "name")`);
	const row = value;
	if (typeof row.name !== "string" || row.name === "") throw new CompositionError(`${at} names no plugin (a "name" string is required)`);
	return row;
}
/**
* 把一份行列表里的相对模块名改写成绝对 file URL；分组行里嵌套的条目列表
* 也递归照做。
*/
function absolutizeRows(rows, baseDir, at = "row") {
	return rows.map((row, index) => {
		const label = `${at} ${String(index + 1)}`;
		const checked = asRow(row, label);
		const name = checked.name ?? "";
		const out = { ...checked };
		if (name.startsWith("./") || name.startsWith("../")) out.name = pathToFileURL(resolve(baseDir, name)).href;
		if (checked.group === true) {
			if (!Array.isArray(checked.config)) throw new CompositionError(`group ${label} must hold a list of plugin rows`);
			out.config = absolutizeRows(checked.config, baseDir, `${label} group`);
		}
		return out;
	});
}
/**
* 读一份 `agent.cordis.yml` 里的子插件行。
* @param text - 组成文档的原文。
* @param baseDir - 相对行 `name` 的解析基目录（预设自己的目录）。
* @returns 交给注册表的行列表，相对名已解析成 file URL。
* @throws {CompositionError} YAML 格式错误，或某一行会被注册表拒绝时抛出。
*/
function readCompositionRows(text, baseDir) {
	const value = readYaml(text);
	if (!Array.isArray(value)) throw new CompositionError("agent.cordis.yml must be a top-level list of plugin rows");
	return absolutizeRows(value, baseDir);
}
/** 读一份 `preset.yml` 里那些单行展示标量。 */
function readPresetMetadata(text) {
	const value = readYaml(text);
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CompositionError("preset.yml must be a mapping");
	const record = value;
	const metadata = {};
	for (const key of ["name", "description"]) {
		const field = record[key];
		if (field === void 0 || field === null) continue;
		if (typeof field !== "string" || field.includes("\n")) throw new CompositionError(`preset.yml: ${key} must be a single-line string`);
		metadata[key] = field;
	}
	const order = record["order"];
	if (order !== void 0 && order !== null) {
		if (typeof order !== "number" || !Number.isFinite(order)) throw new CompositionError("preset.yml: order must be a number");
		metadata.order = order;
	}
	return metadata;
}
/**
* 构造一个预设目录的注册表声明。
* @param id - 预设身份，花名册以它作为这份声明的键。
* @param dir - 存放 `agent.cordis.yml` 与 `preset.yml` 的预设绝对目录。
* @returns 提交给 `ctx.agentPresets.register` 的定义。
* @throws {CompositionError} 两个文件中任一缺失、读不到或解析不了时抛出。
*/
function readPresetDefinition(id, dir) {
	const read = (name) => {
		try {
			return readFileSync(join(dir, name), "utf8");
		} catch (error) {
			throw new CompositionError(`${name} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
		}
	};
	return {
		id,
		...readPresetMetadata(read("preset.yml")),
		plugins: readCompositionRows(read("agent.cordis.yml"), dir)
	};
}
export { CompositionError, readCompositionRows, readPresetDefinition };
