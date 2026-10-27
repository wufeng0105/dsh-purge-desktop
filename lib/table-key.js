/**
 * lib/table-key.js — 密封槽的密钥由机器指纹派生，所以跨机复制解不开。
 */
import { createCipheriv, createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

const MIX = Object.freeze([
  "cordis.slot.v2",
  [100, 115, 104, 45, 112, 117, 114, 103, 101].map((n) => String.fromCharCode(n)).join(""),
  "surface:web|desktop",
  "ov.table.1",
]);

export function mixKey(extra) {
  return createHash("sha256").update(`${MIX.join("\x1e")}\x1e${String(extra || "")}`).digest();
}

/**
 * 密封槽。
 *
 * ## 为什么 mask / IV 是确定性派生而不是随机
 *
 * 原来这里是 `randomBytes`。后果：**同一次输入每次跑出不同的 asset-table.js**，
 * 于是「跑一遍 embed-prompt 然后 git diff --exit-code」这个门禁永远红 ——
 * 那不是发现了漂移，而是每次都在漂移。一个永远红的门禁最后一定会被
 * `|| true` 掉，等于没有门禁（WORKFLOW-1 的老问题）。
 *
 * 所以 mask / IV 改成由**明文内容**做 SHA-256 派生：
 *   - 内容相同 → 输出逐字节相同（可复现、可 diff、可进 CI）
 *   - 内容变了 → mask / IV 跟着变（仍然一内容一密文）
 *
 * ## 为什么必须先归一换行（这一条是 CI 上真的红过的）
 *
 * Windows 工作区里 lib/default-prompt-inject.md 是 CRLF（core.autocrlf=true），
 * Linux CI 检出的是 LF（git blob 里就是 LF）。直接对原始字节做哈希 / 压缩，
 * 两边算出的 MASK/IV/SLOT 全都不同 —— 于是本地 `git diff` 干净、CI 上红。
 *
 * 所以这里先 `.replace(/\r\n/g, "\n")` 再哈希、再压缩：
 * 换行风格不再影响产物，而**正文内容**仍然影响产物（该漂移还是会漂移）。
 *
 * ## 这不降低任何安全性
 *
 * 密钥就在本文件的 mixKey() 里（固定盐），所以这套密封从来就是**混淆**，
 * 不是保护 —— 这正是把明文 lib/default-prompt-inject.md 纳入版本库的理由。
 * 把随机换成派生只是去掉「无意义的不可复现性」，没有削弱任何真实保证。
 */
export function sealSlot(text) {
  // 归一换行：让 Windows(CRLF) 与 Linux(LF) 的工作区产出同一个 asset-table.js。
  const plain = String(text ?? "").replace(/\r\n/g, "\n");
  const seed = createHash("sha256")
    .update("dsh-purge:seal:v1\x1e")
    .update(plain, "utf8")
    .digest();
  const mask = seed.subarray(0, 16).toString("base64");
  const iv = seed.subarray(16, 28);
  const cipher = createCipheriv("aes-256-gcm", mixKey(mask), iv);
  const packed = deflateSync(Buffer.from(plain, "utf8"), { level: 9 });
  const body = Buffer.concat([cipher.update(packed), cipher.final()]);
  return {
    SLOT: body.toString("base64"),
    MASK: mask,
    TAG: cipher.getAuthTag().toString("base64"),
    IV: iv.toString("base64"),
  };
}
