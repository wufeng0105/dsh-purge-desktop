/**
 * lib/audit/report.js — 一次 apply 的落账：证据只认文件探针，不认成功字样。
 * 一次 apply 的审计落账：把补丁判定折成结论层事件，逐条写进 JSONL。
 *
 * 为什么证据必须是文件探针而不是「成功」两个字：一个月后要能回答「当时凭什么说
 * 这条补丁生效了」。凭据只能是「在哪个文件的哪个 marker 上命中几次、文件多少字节」——
 * 这三样都能被第三方重跑一次复现。`{"ok":true}` 是自述，复现不了。
 *
 * 落点由调用方解析（补丁表知道自己在哪些文件里找 marker），不取自 apply 报告行：
 * 真机上一次 apply 只有 6 行报告带 path，其余是空串，第一版据此落账时整份日志
 * 只覆盖了一个层 —— 「安静地少记」比记错更难发现，所以这里要求调用方给出完整目标。
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { fileEvidence, refEvidence } from "./events.js";
import { appendEvent, localIso } from "./store.js";
import { LAYER_ORDER, foldCompleteness, layerOf } from "./layers.js";
import { isSoftOk, onMissKind, resultOfStatus } from "../patch/status.js";

const sha256Of = (raw) => createHash("sha256").update(raw).digest("hex");

/**
 * 单文件摘要 {sha256, bytes}；读不到返回 null。
 * 供调用方在引擎动手前采集 before（apply 之后「改之前」就再也读不回来了）。
 */
export function fileDigest(file) {
  try {
    const raw = fs.readFileSync(file);
    return { sha256: sha256Of(raw), bytes: raw.length };
  } catch {
    return null;
  }
}

/** 读文件并数 marker 命中数、算内容摘要；同一文件在一次落账里只读一次。 */
function makeProbe(cache) {
  return (file, marker) => {
    let entry = cache.get(file);
    if (entry === undefined) {
      try {
        const raw = fs.readFileSync(file);
        entry = { text: raw.toString("utf8"), digest: { sha256: sha256Of(raw), bytes: raw.length } };
      } catch {
        // 读不到就记 hits=0、bytes=0：区分「文件不存在」与「文件在但没命中」
        // 由 bytes 承担，所以缺文件必须留一条实际记录，不能跳过。
        entry = { text: null, digest: null };
      }
      cache.set(file, entry);
    }
    let hits = 0;
    let firstAt = -1;
    if (entry.text !== null && marker) {
      let at = entry.text.indexOf(marker);
      while (at !== -1) {
        if (firstAt === -1) firstAt = at;
        hits += 1;
        at = entry.text.indexOf(marker, at + marker.length);
      }
    }
    // 首个命中的偏移按 UTF-8 字节算：读日志的人要能直接跳到那个位置，
    // 而 JS 的字符串下标在含中文的文件里比字节少，照抄会指到别的行上。
    const offset = firstAt === -1 ? null : Buffer.byteLength(entry.text.slice(0, firstAt), "utf8");
    return { hits, bytes: entry.digest ? entry.digest.bytes : 0, digest: entry.digest, offset };
  };
}

// 上溯层数：落点最深的形态是 `resources/app/dsh/node_modules/@deepseek-ai/<包>/lib/x.js`，
// 到 `resources/app` 是 7 级；留到 12 级是给更深的打包布局留余量，同时给上溯封顶。
const HOST_BUILD_WALK_LIMIT = 12;
// 来源说明是一句话，不是一次遍历的日志：超长就截断，宁可少列几个候选，也不让一行结论被它撑爆。
const HOST_BUILD_SOURCE_MAX = 600;

/**
 * 宿主 build 的标识与它的来源。
 *
 * 为什么需要这个字段：`hostVersion` 只比主次版本，宿主换 build 而版号不动时，
 * 日志里没有任何一列能回答「这条补丁是为哪个 build 写的」—— 软失败因此全部「看起来正常」。
 * 标识取 `resources/app/package.json` 的 `dshBuildCommit`（宿主桌面壳自己的字段），
 * 不走写死的相对路径：asar 密封与解包两种形态下落点的绝对层级不同，
 * 而补丁落点文件的绝对路径在两形态下都存在，是唯一共同的锚点。
 *
 * 取不到时 `hostBuild` 留空串，**但空串必须配一句来源说明**：只留空串的话，
 * 「读不到宿主」与「这一行压根没打算记」在日志里长得一模一样。
 *
 * 导出给 `scripts/check-host-upgrade-dryrun.mjs`：升级矩阵要的「实际 build」必须与
 * 落账时记的「声明 build」同源，另写一份取值逻辑就变成两个真相了。
 *
 * @param {string[]} files 本轮 apply 的落点文件（绝对路径）
 * @returns {{hostBuild:string, hostBuildSource:string}}
 */
export function resolveHostBuild(files) {
  const dirs = [];
  const seen = new Set();
  for (const file of files) {
    let dir = path.dirname(file);
    for (let step = 0; step < HOST_BUILD_WALK_LIMIT; step += 1) {
      // 到盘根就停：再往上是系统目录，不会有宿主 app 的 package.json。
      if (!dir || dir === path.dirname(dir)) break;
      if (!seen.has(dir)) {
        seen.add(dir);
        dirs.push(dir);
      }
      // asar 两种形态：落点可能在 `resources/app.asar.unpacked/...` 里，而宿主壳的
      // package.json 永远在没解包的那一支 `resources/app/`。同一个 resources 下补一条候选，
      // 否则「宿主就在旁边、只是不在上溯链上」会被记成「宿主不在」。
      if (path.basename(dir) === "resources") {
        const appDir = path.join(dir, "app");
        if (!seen.has(appDir)) {
          seen.add(appDir);
          dirs.push(appDir);
        }
      }
      dir = path.dirname(dir);
    }
  }
  // 只记「存在但不合用」的 package.json：目录里没有这个文件不算试错，
  // 把十几个空目录也列进来源说明，等于让真正的原因沉在噪音里。
  const rejected = [];
  for (const dir of dirs) {
    const pkgPath = path.join(dir, "package.json");
    let raw;
    try {
      raw = fs.readFileSync(pkgPath, "utf8");
    } catch {
      continue;
    }
    let pkg;
    try {
      pkg = JSON.parse(raw);
    } catch {
      rejected.push(`${pkgPath} 不是合法 JSON`);
      continue;
    }
    if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) {
      rejected.push(`${pkgPath} 不是对象`);
      continue;
    }
    const commit = typeof pkg.dshBuildCommit === "string" ? pkg.dshBuildCommit.trim() : "";
    if (commit === "") {
      rejected.push(`${pkgPath} 没有 dshBuildCommit`);
      continue;
    }
    // dirty 也是 build 的一部分：同一个 commit 上改过文件，产出的宿主不是那个 commit 的字节。
    const dirty = pkg.dshBuildDirty === true;
    return {
      hostBuild: dirty ? `${commit}+dirty` : commit,
      hostBuildSource: `${pkgPath} 的 dshBuildCommit${dirty ? "（dshBuildDirty=true）" : ""}`,
    };
  }
  const tried = rejected.length === 0
    ? `沿 ${files.length} 个落点向上 ${HOST_BUILD_WALK_LIMIT} 级，候选目录里没有 package.json`
    : `沿 ${files.length} 个落点向上 ${HOST_BUILD_WALK_LIMIT} 级，读到的 package.json 都不合用：`
      + rejected.slice(0, 4).join("；");
  const head = files.length === 0
    ? "本轮报告里没有任何落点文件，无从向上找宿主 resources/app/package.json"
    : `没找到带 dshBuildCommit 的宿主 package.json：${tried}`;
  return { hostBuild: "", hostBuildSource: head.slice(0, HOST_BUILD_SOURCE_MAX) };
}

/**
 * 记录一次 apply 的结果。
 *
 * 一条补丁可能落在多个文件上（`file` 是数组、同一处逻辑散在多个包里），
 * 每个落点单独一条事件：证据的最小单位是「一个文件上的一个 marker」，
 * 把三处落点压成一条，事后就分不清是哪一处没命中。
 *
 * v2：本次尝试的全部事件共用一个 runId 与 observedTs（观测起点），recordId 由存储层逐行分配；
 * 文件证据带 before/after 摘要（{sha256, bytes}，null = 那一侧读不到）与首个命中的字节偏移
 * （hits=0 时不写：没有命中就没有偏移可言）；每层结论带
 * detail.completeness{patches, files, layers}，任一为假该层 result 不许是 ok / skip。
 * 每一行还带 actor（写这一行的是 cli 还是 host）与 entry（哪个入口发起的），
 * 层结论另带 detail.considered / detail.expectedRows / detail.partialReason 三个可复算的字段，
 * 以及 detail.hostBuild / detail.hostBuildSource：宿主换了 build 而版号没动时，
 * 只有这一对字段能回答「这条补丁是为哪个 build 写的」。
 *
 * @param {object} input
 * @param {string} input.dshHome 状态目录（日志落在 `<dshHome>/dsh-purge/audit/`）
 * @param {Array<object>} input.rows 每行 `{id, name, layer, status, files, marker, softOk?}`。
 *   `softOk` 由折行方按补丁声明算好（`pattern_not_found` 且 on-miss 不是 fail）；缺省按
 *   「单看 status」的口径判，与旧调用方逐字节相同。
 * @param {object} [input.before] apply 前采集的 before 摘要表：file → {sha256,bytes} | null。
 *   不给（或给空表）时 completeness.files 记假 —— before 没采到就是没记全。
 * @param {Date} [input.now] 仅测试用，缺省取当前时刻
 * @param {string} [input.runId] 调用方已经开出的身份（同一次 apply 在 diag 侧用过的那一个）。
 *   给了就沿用它，让 diag 与 audit 两个文件按同一个值真 join；不给就照旧自己生成，
 *   行为与加这个参数之前逐字节相同。
 * @param {string} [input.entry] 触发这一轮的入口（`cli` / `http` / `command` / `tool` 等）。
 *   写进每一行的 `entry`：同一批补丁从哪个入口发起的，只读这一行就能答出来，
 *   不必再去诊断轨找 —— 诊断轨只留一代，滚掉之后那个答案就永久丢了。
 * @param {Array<object>} [input.patches] 补丁表。给了就把「这一轮该落账的补丁」按它记账
 *   （`detail.table`），并且只在**这一轮最后一条审计行**上盖结束标记（`detail.runEnd`）。
 *   记账里另写 `selected`：`rows` 里出现过的不同补丁号（含写不出证据、进了 unresolved 的）。
 *   `rows` 是过滤后的 apply 报告，不是补丁表全量 —— 合法过滤轮的分母只能从它来。
 *   不给时两样都不写 —— 那是旧调用方的形态，读侧会把这一轮判成「不可判」而不是「截断」。
 * @returns {{events:number, skipped:number, unresolved:Array<number>, layers:object,
 *   runId:string, entry:string, actor:string}}
 */
export function recordApply({ dshHome, rows, before, now, runId: runIdIn, entry: entryIn, patches } = {}) {
  if (typeof dshHome !== "string" || dshHome.trim() === "") {
    throw new Error("recordApply 需要 dshHome：日志路径由它派生，缺了就无从落盘");
  }
  const list = (Array.isArray(rows) ? rows : []).filter(
    (row) => row && LAYER_ORDER.includes(row.layer),
  );
  const probe = makeProbe(new Map());
  const stamp = now === undefined ? {} : { now };
  const start = now === undefined ? new Date() : now;
  // runId 是人可 grep 的时间戳 + 短随机段：第二次 apply 出现 failed=1 时靠它把那次尝试整批捞出。
  // observedTs 固定为本次观测起点，ts 由存储层逐行分配 —— 两者差值就是审计管道自身的积压。
  // 调用方带了身份就沿用（两轨按同一个值 join），没带就照旧自己生成。
  const runId = (typeof runIdIn === "string" && runIdIn.trim() !== "")
    ? runIdIn.trim()
    : `apply-${start.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${randomUUID().slice(0, 4)}`;
  // 入口与发起方分开记：`entry` 是「谁触发的」（四个 apply 入口各一个值），
  // `actor` 是「谁在写这一行」（CLI 进程自己写，其余三个入口都是宿主进程写）。
  // 两列都不许恒为同一个值 —— 恒为 host 的 actor 等于没有这一列。
  const entry = (typeof entryIn === "string" && entryIn.trim() !== "") ? entryIn.trim() : "";
  const actor = entry === "cli" ? "cli" : "host";
  const observedTs = localIso(start);
  const beforeOf = (file) => (before === undefined ? undefined : (before[file] ?? null));
  const filesOf = (row) => (Array.isArray(row.files) ? row.files : [row.files]).filter(
    (f) => typeof f === "string" && f !== "",
  );
  // 宿主 build 整轮只解析一次：同一轮 apply 的落点全在同一棵宿主树上，
  // 逐层各解析一遍会给出 N 个可能互不相同的答案，而「这一轮是为哪个 build 写的」只有一个。
  const hostBuildOf = resolveHostBuild(list.flatMap(filesOf));
  const layers = {};
  const unresolved = [];
  let events = 0;
  let skipped = 0;

  // 「三层是否都有结论」先算后写：只看每层有没有能落账的行（有落点、有 marker），
  // 与判定好坏无关 —— 补丁全 miss 的层照样算「结论记全了」。
  const layersComplete = LAYER_ORDER.every((layer) => list.some((row) => {
    if (row.layer !== layer) return false;
    return filesOf(row).length > 0 && typeof row.marker === "string" && row.marker !== "";
  }));

  // 结束标记写在哪一行：**这一轮最后一条会落盘的层结论**。先算出是哪一层，再在写它时盖章 ——
  // 事后按位置找「最后一行」是读侧的活，写侧在这里一次性定死，读侧就不必依赖排列。
  const writtenLayers = LAYER_ORDER.filter((layer) => list.some((row) => {
    if (row.layer !== layer) return false;
    if (row.exempt === true) return false;
    return filesOf(row).length > 0 && typeof row.marker === "string" && row.marker !== "";
  }));
  const sealLayer = writtenLayers.length > 0 ? writtenLayers[writtenLayers.length - 1] : "";
  // 补丁表记账：`total / exempt / unmapped` 是表的口径，`selected` 是**这一轮**的口径。
  // 没有层的那些（兼容类）单独列出来 —— 它们永远不会出现在任何层结论里，不列就是静默消失，
  // 而那正是「66 条只覆盖 63 条」的来路。
  // 为什么要写 `selected`：apply 可以带过滤（`core.pick` 之后 report 只含选中的补丁），
  // 合法过滤轮的 `recorded` 本来就小于补丁表全量。读侧只有拿到「这一轮真选过哪些」，
  // 才能把「少的是没选中」与「少的是丢了」分开；拿全表当分母会把过滤轮判成静默丢失。
  const tableList = Array.isArray(patches) ? patches.filter((patch) => patch && patch.id !== undefined) : [];
  const selectedIds = [];
  const selectedSeen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.id === undefined || row.id === null) continue;
    const key = String(row.id);
    if (selectedSeen.has(key)) continue;
    selectedSeen.add(key);
    // 补丁号在表里是数字，读侧统一按字符串比；写回去时保留原类型，夹具与真机都读得懂。
    selectedIds.push(Number.isFinite(Number(key)) && String(Number(key)) === key ? Number(key) : row.id);
  }
  selectedIds.sort((a, b) => (Number(a) - Number(b)) || String(a).localeCompare(String(b)));
  const tableAccounting = tableList.length === 0
    ? null
    : {
      total: tableList.length,
      exempt: tableList.filter((patch) => patch.auditExempt === true).map((patch) => String(patch.id)),
      unmapped: tableList
        .filter((patch) => patch.auditExempt !== true && !LAYER_ORDER.includes(layerOf(patch)))
        .map((patch) => String(patch.id)),
      selected: selectedIds,
    };
  const recordedIds = new Set();

  for (const layer of LAYER_ORDER) {
    const own = list
      .filter((row) => row.layer === layer)
      .slice()
      .sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
    if (own.length === 0) continue;
    let lastSeq = null;
    let lastName = "";
    const tally = { total: 0, applied: 0, failed: 0, skipped: 0 };
    const layerUnresolved = [];
    const layerExempt = [];
    // 这一层「本该落账」的补丁号：折行方在这里写下自己的分母，读的人才能对着它
    // 数「有没有少一条」。没有这份清单，缺行与「本来就没有这条补丁」在日志里长得一样。
    const layerConsidered = [];
    let expectedRows = 0;
    let writtenRows = 0;
    let digestsComplete = true;
    for (const row of own) {
      if (row.exempt === true) {
        // 审计不适用（PATCH-9）：无证据是设计使然 —— 不写事件、不进缺口分母，
        // 但必须在层结论的 detail.exempt 里单独列示，不许静默消失。
        if (row.id !== undefined && row.id !== null) layerExempt.push(row.id);
        continue;
      }
      const files = filesOf(row);
      if (files.length === 0 || typeof row.marker !== "string" || row.marker === "") {
        // 没有落点就写不出可复现的证据：宁可少一条，也不写一条查不回去的记录。
        // 这些 id 会出现在层结论的 detail.unresolved 里 —— 缺口必须是可见的。
        skipped += 1;
        if (row.id !== undefined && row.id !== null) {
          unresolved.push(row.id);
          layerUnresolved.push(row.id);
        }
        continue;
      }
      expectedRows += files.length;
      if (row.id !== undefined && row.id !== null) layerConsidered.push(row.id);
      // 补丁级口径由折行方带进来（`softOk`）：诊断轨、审计轨与设置页对同一条
      // `pattern_not_found` 用同一个判定，不再出现「诊断轨 0 硬失败、审计轨 fail」。
      const result = resultOfStatus(row.status, { softOk: row.softOk === true });
      // 读写失败也落 miss 这一支：后缀只有 applied / miss / skipped 三种，
      // 而 skipped 的含义是「这个落点这一轮不需要动」—— 把「没判出来」混进去，
      // 层结论的 skipped 计数就成了谎。真原因留在 detail.status 里。
      const suffix = result === "ok" ? "applied" : result === "fail" ? "miss" : "skipped";
      for (const file of files) {
        const { hits, bytes, digest, offset } = probe(file, row.marker);
        // after 是探针当场算出的摘要；before 来自调用方在引擎动手前的采集。
        // null 表示那一侧读不到 —— 这不是错误，是必须留痕的缺口。
        // offset 只在真命中时写：hits=0 时没有「第几个字节」可言，写 0 是把「没命中」说成「在第 0 字节」。
        const beforeDigest = beforeOf(file);
        if (digest === null || beforeDigest === undefined || beforeDigest === null) digestsComplete = false;
        const written = appendEvent(
          dshHome,
          {
            runId,
            observedTs,
            event: `${layer}.patch-${suffix}`,
            result,
            layer,
            actor,
            ...(entry === "" ? {} : { entry }),
            target: row.name || String(row.id ?? ""),
            evidence: fileEvidence({
              file,
              marker: row.marker,
              hits,
              bytes,
              ...(offset === null ? {} : { offset }),
              after: digest,
              ...(beforeDigest === undefined ? {} : { before: beforeDigest }),
            }),
            detail: { patchId: row.id ?? null, status: row.status ?? "" },
          },
          stamp,
        );
        events += 1;
        writtenRows += 1;
        lastSeq = written.seq;
        lastName = written.event;
      }
      if (row.id !== undefined && row.id !== null) recordedIds.add(String(row.id));
      tally.total += 1;
      if (result === "ok") tally.applied += 1;
      else if (result === "fail") tally.failed += 1;
      else tally.skipped += 1;
    }
    if (lastSeq === null) continue;
    const aggregate = tally.total === 0
      ? "skip"
      : tally.failed > 0
        ? "fail"
        : tally.applied === tally.total
          ? "ok"
          : tally.applied > 0
            ? "partial"
            : "skip";
    // 「记全了没有」是结论的一部分：该层没有 unresolved、应落行数与实落行数相等、
    // before/after 摘要齐全、三层都有结论，四者全真才许 ok / skip。
    const completeness = {
      patches: layerUnresolved.length === 0,
      files: writtenRows === expectedRows && digestsComplete,
      layers: layersComplete,
    };
    const folded = foldCompleteness(aggregate, completeness);
    // partial 有两个来路，读者分不清就会把「这一层只做了一部分事」当成「记录缺了一块」。
    // 记下是哪一档：`record` 是记录缺口（completeness 有假项），`layer` 是层内部分成功。
    // 记录缺口优先 —— 它比「只做了一部分」更需要人去看。
    const partialReason = folded !== "partial"
      ? ""
      : (completeness.patches === false || completeness.files === false || completeness.layers === false)
        ? "record"
        : "layer";
    // 层结论引用它最后一条探针事件：读的人顺着 refSeq 就能看到凭据，
    // 不必回翻整份日志去猜这条结论建立在哪一行上。
    appendEvent(
      dshHome,
      {
        runId,
        observedTs,
        event: `${layer}.apply-result`,
        result: folded,
        layer,
        actor,
        ...(entry === "" ? {} : { entry }),
        target: layer,
        evidence: refEvidence({ refSeq: lastSeq, quote: lastName }),
        detail: {
          applied: tally.applied,
          failed: tally.failed,
          skipped: tally.skipped,
          unresolved: layerUnresolved,
          exempt: layerExempt,
          completeness,
          // 宿主 build 与它的来源：同一版号的两份宿主只靠这一对字段分得开。
          // 它是纯增量，不参与 completeness 的三布尔、也不进 result 折算，
          // 读侧按三项布尔复算的那条口径（AUDIT-1）因此一字未动。
          ...hostBuildOf,
          // 分母写进日志本身：`considered` 是折进来的补丁号、`expectedRows` 是它们声明的
          // 落点总数。有这两个数，第三方只读这一行就能复算三项布尔，不必相信落账方。
          considered: layerConsidered,
          expectedRows,
          ...(partialReason === "" ? {} : { partialReason }),
          // 这一轮的最后一条：盖章 + 按补丁表记账。读侧判收尾只看这个键在不在，
          // 不看它排第几 —— 末尾再挂多少像收尾的事件，都不影响「盖过章没有」。
          // 盖章与记账分开：章是轮边界（一定要盖），记账要补丁表（调用方给得出才记）。
          ...(layer === sealLayer
            ? {
              runEnd: true,
              ...(tableAccounting === null ? {} : {
                table: { ...tableAccounting, recorded: recordedIds.size },
              }),
            }
            : {}),
        },
      },
      stamp,
    );
    events += 1;
    layers[layer] = { ...tally, result: folded };
  }

  return { events, skipped, unresolved, layers, runId, entry, actor };
}

/**
 * 审计口径对账：**一行 = 一条补丁的一个目标文件**。
 *
 * 为什么单列一个函数：apply 响应里要报一行「patches / rows / files / unresolved」，
 * 单看任何两个数都说不清覆盖率 —— 82 条补丁里有落在 1 个文件上的，也有落在 5 个上的。
 * 把三个数固定成同一个口径（rows 是「补丁 × 文件」的行数，files 是去重后的目标文件数），
 * 事后对账才不会出现「按补丁数」与「按文件数」两套说法。
 *
 * @param {Array<object>} rows auditRowsFromReport 的产物
 * @param {Array<object>} patches 补丁表（只为给出分母）
 * @returns {{patches:number, rows:number, files:number, represented:number}}
 */
export function auditCounts(rows, patches) {
  const list = Array.isArray(rows) ? rows : [];
  const files = new Set();
  const represented = new Set();
  let fileRows = 0;
  for (const row of list) {
    // 审计不适用（PATCH-9）的行不产生任何事件，也就不进 rows / files / represented——
    // 分母里混进不落账的行，「行数 = rows」的对账就永远对不上。
    if (row.exempt === true) continue;
    // 兼容类补丁折不进 prompt / code / tool 三档，recordApply 按同一判据丢弃、不落事件；
    // 这里若计入 rows，对账会永远差这几行。两边必须咬同一个口径。
    if (!LAYER_ORDER.includes(row.layer)) continue;
    const own = Array.isArray(row.files) ? row.files : [];
    for (const f of own) {
      if (typeof f !== "string" || f === "") continue;
      files.add(f);
      fileRows += 1;
    }
    if (own.length > 0) represented.add(row.id);
  }
  return {
    patches: Array.isArray(patches) ? patches.length : 0,
    rows: fileRows,
    files: files.size,
    represented: represented.size,
  };
}


/**
 * 取一条补丁的可复现字面量。
 *
 * 补丁表里两种写法并存：老的 `marker`（单数）与 plural schema 的 `markers` / `markersAny`。
 * 只认单数会让 76 条补丁在日志里全部落成「无落点」—— 真机第一次修完就是这么被挡住的：
 * audit_resolved 有 77，实际落盘只有 6 条，因为其余行的 marker 是空串。
 *
 * marker 字段上限 200 字符，优先挑一条不超限的；都超限就截断第一个（截断后仍是原文前缀，
 * 数命中数照样可复现）。
 */
function pickMarker(patch) {
  const raw = [];
  if (typeof patch.marker === "string" && patch.marker.trim() !== "") raw.push(patch.marker);
  for (const list of [patch.markers, patch.markersAny]) {
    if (!Array.isArray(list)) continue;
    for (const m of list) if (typeof m === "string" && m.trim() !== "") raw.push(m);
  }
  if (raw.length === 0) return "";
  const fits = raw.find((m) => m.length <= 200);
  return fits === undefined ? raw[0].slice(0, 200) : fits;
}

/**
 * 从 apply 报告行里折出审计行。
 *
 * @param {Array<object>} report 引擎的 apply 报告（只取 patch_id / status）
 * @param {Array<object>} patches 补丁表（取 name / layer / marker / markers）
 * @param {(patch:object)=>string[]} [resolveTargets] 目标解析器：给出该补丁声明的**全部**落点。
 *   不给时退回报告行的 `path`（只用于测试与旧调用方，生产路径必须给）。
 */
export function auditRowsFromReport(report, patches, resolveTargets) {
  const byId = new Map(
    (Array.isArray(patches) ? patches : []).map((patch) => [patch.id, patch]),
  );
  const rows = [];
  for (const item of Array.isArray(report) ? report : []) {
    const id = item && (item.patch_id ?? item.id);
    const patch = byId.get(id);
    if (!patch) continue;
    let files = [];
    if (typeof resolveTargets === "function") {
      const resolved = resolveTargets(patch);
      files = (Array.isArray(resolved) ? resolved : [resolved]).filter(
        (f) => typeof f === "string" && f !== "",
      );
    } else if (typeof item.path === "string" && item.path !== "") {
      files = [item.path];
    }
    rows.push({
      id,
      name: patch.name || item.name || String(id),
      layer: patch.layer === "提示词" ? "prompt" : patch.layer === "代码" ? "code" : patch.layer === "工具" ? "tool" : "",
      status: item.status,
      files,
      marker: typeof resolveTargets === "function"
        ? pickMarker(patch)
        : (typeof patch.marker === "string" ? patch.marker : ""),
      exempt: patch.auditExempt === true,
      // 补丁声明里的 on-miss 口径在这里就折成布尔：审计轨拿不到补丁表之外的上下文，
      // 而三轨对 `pattern_not_found` 的判法必须在同一点定下来。
      softOk: isSoftOk({ status: item.status }, patch, onMissKind),
    });
  }
  return rows;
}
