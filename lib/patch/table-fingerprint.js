/**
 * lib/patch/table-fingerprint.js — 补丁表指纹：把「这一版表会把宿主改成什么样」压成一个 sha256。
 *
 * 为什么需要它：补丁「是否已生效」原先只问 marker 是否出现在文件里，而 marker 是痕量
 * 字面量、不含替换正文。于是正文换代而 marker 不变的补丁照旧判已生效，启动也不重打，
 * 宿主文件停在旧内容上 —— 这类失效没有任何症状，面板照样是绿的。
 *
 * 指纹把「表变了」变成可比对的字节事实：收尾时把表指纹与逐补丁指纹写进版本账本，
 * 读侧拿当前表再算一次；指纹不等即不认 marker，状态回落到内容判据。
 *
 * 两条边界：
 *   · 只 import `./table.js`（数据）与 node 内置模块，不 import core —— 补丁层是纯函数层，
 *     反向依赖引擎会让「表是什么」与「表怎么用」重新缠在一起。
 *   · 规范化只按 LF 归一（与引擎写文件前的归一同一套），否则同一份表在行尾不同的
 *     两台机器上会算出两个指纹，账本一对不上就整批重打。
 */
import { createHash } from "node:crypto";
// 指纹要覆盖**活跃补丁全表**（四个分组拼起来的 66 条），不是分组里的第一个数组。
// 表文件把四段导出成四个数组、再用 ALL_PATCHES 拼起来，取错一个就会只算 5 条。
import { ALL_PATCHES } from "./table.js";

const HASH = "sha256";

/**
 * 一条补丁或一份账本的实际形状。
 *
 * 为什么不写成精确结构：补丁表是数据，字段集合由表自己决定（plural / singular 两套
 * schema 并存、还有 forbid / markersAny 这类可选位）。这里只做「按键取值」，
 * 精确结构写成类型会在表增字段时变成噪声。
 *
 * @typedef {Record<string, any>} LooseRecord
 */

/** 与 core.js 的 asLf 同义：CRLF 与裸 CR 都归成 LF。指纹只认归一后的正文。 */
function asLf(value) {
  return String(value == null ? "" : value).replace(/\r\n?/g, "\n");
}

/**
 * 一个 pattern 的规范化文本。
 *
 * 正则要带 flags：同一个 source 带不带 `m` 在真实宿主上可能匹配到不同的行数，
 * 那不是同一个替换，不该算出同一个指纹。
 */
function patternText(pattern) {
  if (pattern instanceof RegExp) return `re:${pattern.source}/${pattern.flags}`;
  return `str:${asLf(pattern)}`;
}

/**
 * 该补丁声明的全部替换（plural 与 singular 两套 schema 归一到同一种形状）。
 * @param {LooseRecord} patch
 * @returns {Array<LooseRecord>}
 */
function replacementList(patch) {
  if (Array.isArray(patch?.replacements)) return patch.replacements;
  if (Array.isArray(patch?.patterns)) {
    return patch.patterns.map((pattern) => ({ pattern, replace: patch.replace }));
  }
  return [];
}

/**
 * 该补丁声明的全部 marker（单数 marker 包成一元数组）。
 * @param {LooseRecord} patch
 * @returns {string[]}
 */
function markerList(patch) {
  if (Array.isArray(patch?.markers)) return patch.markers.map(asLf);
  return patch?.marker ? [asLf(patch.marker)] : [];
}

/**
 * 一条补丁的指纹：id + 规范化后的替换正文 + marker。
 *
 * `markersAny` 也进去：它决定「任一命中」还是「全部命中」，同一条 marker 集在这两种
 * 语义下打出来的证据不同，不该同指纹。
 *
 * @param {LooseRecord} patch 补丁条目
 * @returns {string} 64 位十六进制 sha256
 */
export function patchFingerprint(patch) {
  const lines = [`id:${patch?.id}`, `any:${patch?.markersAny ? 1 : 0}`];
  for (const replacement of replacementList(patch)) {
    lines.push(`rep:${patternText(replacement?.pattern)}\u0000${asLf(replacement?.replace)}`);
  }
  for (const marker of markerList(patch)) lines.push(`mark:${marker}`);
  return createHash(HASH).update(lines.join("\n"), "utf8").digest("hex");
}

/**
 * 整张表的逐补丁指纹，键是补丁 id 的十进制字符串。
 *
 * 键用字符串是为了让它能原样进 JSON（版本账本是 JSON 文件），读侧拿 id 查时
 * 统一 `String(id)`，不依赖对象的数字键枚举顺序。
 *
 * @param {LooseRecord[]} [patches] 补丁表；缺省是活跃补丁全表
 * @returns {Record<string, string>}
 */
export function patchFingerprints(patches = ALL_PATCHES) {
  const out = {};
  for (const patch of patches) out[String(patch.id)] = patchFingerprint(patch);
  return out;
}

/**
 * 整张表的指纹：逐补丁指纹按 id 数值排序后取 sha256。
 *
 * 排序是判据的一部分：补丁表的顺序可以变（新补丁只能追加，但分组会重排），
 * 而「表的集合与正文」没变时指纹必须不变，所以先排序再算。
 *
 * @param {LooseRecord[]} [patches] 补丁表；缺省是活跃补丁全表
 * @returns {string} 64 位十六进制 sha256
 */
export function tableFingerprint(patches = ALL_PATCHES) {
  const pairs = Object.entries(patchFingerprints(patches))
    .sort((left, right) => Number(left[0]) - Number(right[0]))
    .map(([id, sha]) => `${id}:${sha}`);
  return createHash(HASH).update(pairs.join("\n"), "utf8").digest("hex");
}

/**
 * 非空字符串才算指纹字段；`null` / 数字 / 对象一律当缺失。
 * @param {unknown} value
 * @returns {string}
 */
function shaText(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 指纹映射：只收非空字符串值，键统一成字符串。坏数据整条丢掉，不猜。
 * @param {unknown} value
 * @returns {Record<string,string>}
 */
function shaMap(value) {
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, raw] of Object.entries(value)) {
    const sha = shaText(raw);
    if (sha) out[String(key)] = sha;
  }
  return out;
}

/**
 * 一串标识：去空、去重、统一成字符串。
 *
 * `patchesWritten` 是「这一版表真写过的补丁」，数字与字符串两种写法都可能出现
 * （JSON 里是字符串，内存里是数字），读侧只按字符串比对。
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function idList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    const id = String(raw == null ? "" : raw).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * 排除记录：这一版表**没有写**某个文件、但核对过它已经是这版补丁产物的那一档。
 *
 * 为什么需要它：client bundle 在启动自愈轮不许写（client-hmr 会拿旧 rev 找脚本，
 * 见 `isWatchedClientBundle` 的说明），于是它永远拿不到写入证据；只按写入清单判，
 * 这条补丁在每次表换代之后都会挂成「待应用」，而下一轮自愈仍然不写它 —— 假红永不自愈。
 *
 * 记录只收四样事实：补丁 id、记录时的补丁指纹、文件键、核对时的内容 sha256。
 * 读侧要两样都对上才认（补丁这一版的指纹没变、文件字节还是核对时那份），
 * 所以「排除」不是免检通行证：正文换代或文件被动过，记录自动失效。
 *
 * @param {unknown} value applied.json 里的 evidenceExcluded
 * @returns {Array<{patch:string, patchSha:string, file:string, contentSha:string, verified:boolean}>}
 */
function exclusionList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const patch = String(raw.patch == null ? "" : raw.patch).trim();
    const file = fileContentKey(raw.file);
    if (!patch || !file) continue;
    const key = `${patch}\u0000${file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      patch,
      patchSha: shaText(raw.patchSha),
      file,
      contentSha: shaText(raw.contentSha),
      verified: raw.verified === true,
    });
  }
  return out;
}

/**
 * 版本账本里的指纹字段，规范化成读侧能直接比对的一组事实。
 *
 * 旧戳（本次改造之前写下的）没有指纹字段：表指纹与逐补丁指纹都为空，写入清单为空数组。
 * 读侧拿到空指纹时按痕量放行一次、并在启动路径把指纹补写进账本（这次迁移写会留下
 * `migratedAt`，但**不**认证任何字节）；从下一次判定起走真判据 —— 把旧戳一律判成
 * 「未生效」会让升级后的第一次启动把 66 条全报成要重打，那是另一种假结论；
 * 把空指纹当成匹配则等于这次改造没做。
 *
 * @param {unknown} raw applied.json 解析出来的对象
 * @returns {{tableSha:string, patchShas:Record<string,string>, contentSha:Record<string,string>,
 *   patchesWritten:string[], patchesSettled:string[],
 *   evidenceExcluded:Array<{patch:string, patchSha:string, file:string,
 *   contentSha:string, verified:boolean}>, migratedAt:string}}
 */
export function readStampIdentity(raw) {
  /** @type {LooseRecord} */
  const stamp = raw && typeof raw === "object" && !Array.isArray(raw) ? /** @type {LooseRecord} */ (raw) : {};
  return {
    tableSha: shaText(stamp.tableSha),
    patchShas: shaMap(stamp.patchShas),
    contentSha: shaMap(stamp.contentSha),
    // 「这一版表真写过哪些补丁」是「已生效」的第二半证据：指纹只回答「表还是那一版吗」，
    // 这一项回答「这一版表到底动没动过这条补丁」。旧账本没有它，读成空数组。
    patchesWritten: idList(stamp.patchesWritten),
    // 「这一版表核对过哪些补丁已经在目标态」：文件早就在目标态、那一轮没有可写的字节
    // （远端 #2/#3/#50）。它不带内容指纹 —— 内容指纹只属于真写过的字节。
    // 旧账本没有这一项时读成空数组，认证口径回落到只认 patchesWritten。
    patchesSettled: idList(stamp.patchesSettled),
    // 自愈轮跳过 client bundle 时留下的核对记录：它回答「没写，但现场是不是这一版的产物」。
    evidenceExcluded: exclusionList(stamp.evidenceExcluded),
    // 旧账本迁移到指纹判据的那一次写会留下时间；状态侧据此只给旧账本放行一次。
    migratedAt: shaText(stamp.migratedAt),
  };
}

/**
 * 目标文件在内容指纹表里的键。
 *
 * 只用「反斜杠换正斜杠」这一条归一：两端（写戳与读状态）拿到的是
 * `targetFiles()` 产出的同一条路径串，大小写与盘符本来就一致；
 * 再叠一层 `toLowerCase` 会在大小写敏感的文件系统上把两个文件并成一个。
 *
 * @param {string} fp 目标文件绝对路径
 * @returns {string}
 */
export function fileContentKey(fp) {
  return String(fp == null ? "" : fp).trim().replace(/\\/g, "/");
}
