/**
 * lib/audit/accounting.js — 补丁表记账的自证：`detail.table.recorded` 与「声明在哪」。
 *
 * 为什么单列一个模块：`recorded` 是整份日志里**唯一一个不指向任何一行的汇总数** ——
 * 文件行有 `detail.patchId`，层结论有计数与 `unresolved`，唯独它写错时没有第二处能对照。
 * 判据只有拿定义去数：这一轮文件行里出现过的**不同补丁号个数**（不含 `unresolved`），
 * 定义写在 `docs/log-generations.json` 的 recorded 一行。放在这里是为了让「怎么数」只有一份，
 * `lib/audit/runs.js` 与 `scripts/check-audit-completeness.mjs` 各调一次，谁都不许另写一版。
 *
 * 分母不是补丁表全量：apply 可以带过滤（`core.pick` 之后 report 只含选中的补丁），
 * 合法过滤轮的 `recorded` 本来就小于全表。写侧把这一轮 report 里出现过的补丁号记在
 * `detail.table.selected`；读侧有它就对它记账，没有它的过渡日志才退回全表口径并留信息项。
 * 不这么分，「少的是没选中」与「少的是丢了」在日志里长得一样 —— 过滤轮会被判成静默丢失。
 */

/** 补丁号集合：审计侧写数字、读侧按字符串比，形状不同不算分歧。 */
function idSet(value) {
  return new Set((Array.isArray(value) ? value : []).map(String));
}

/**
 * 补丁表记账写在盖章那条结论上；没有盖章的老日志就从任一条结论里找，找不到就是没声明。
 *
 * @param {Map<string,object>} conclusions 层名 → `{detail}`
 * @returns {object|null} `detail.table` 那个对象，或 null
 */
export function tableDeclarationOf(conclusions) {
  for (const conclusion of conclusions.values()) {
    const detail = conclusion && conclusion.detail;
    if (detail && detail.table && typeof detail.table === "object") {
      return detail.table;
    }
  }
  return null;
}

/**
 * `recorded` 的自证：定义 + 与补丁表记账的差。
 *
 * 三条判据：
 *   一、`recorded` 必须等于文件行里不同 `detail.patchId` 的个数 —— 拿定义直接对账；
 *   二、有 `selected` 时，`recorded + |unresolved|` 必须等于「`selected` 里去掉 `exempt` /
 *       `unmapped` 之后的条数」—— 合法过滤只该少掉没选中的那些。`selected` 里有、却既没有
 *       文件行也没进 `unresolved` 的 id 会被逐个点名，那是过滤轮上的静默丢失；
 *   三、没有 `selected` 的过渡日志退回全表口径：`recorded + |unresolved|` 等于
 *       `total − |exempt| − |unmapped|`，并留一条「无 selected，按全表判」信息项。
 *
 * 没有 `detail.table` 的一代不判：判据没依据时报红等于报假，只留一条「这一档不可判」。
 *
 * @param {object} input
 * @param {Map<string,object>} input.conclusions 层名 → `{detail}`
 * @param {Array<string>} input.patchIds 这一轮文件行里出现过的补丁号
 * @param {Array<string>} input.unresolved 各层 `detail.unresolved` 的并集
 * @returns {{problems:Array<string>, notes:Array<string>}}
 */
export function verifyRecordedAccounting({ conclusions, patchIds, unresolved }) {
  const problems = [];
  const notes = [];
  const declared = tableDeclarationOf(conclusions);
  if (declared === null) return { problems, notes };
  const recorded = declared.recorded;
  if (!Number.isInteger(recorded)) {
    notes.push(
      "detail.table 上没有整数 recorded（只写了 total / exempt / unmapped / selected 的过渡形态）：这一档不可判",
    );
    return { problems, notes };
  }

  const actualIds = idSet(patchIds);
  if (recorded !== actualIds.size) {
    problems.push(
      `detail.table.recorded=${recorded}，但这一轮文件行里的不同补丁号是 ${actualIds.size} 个：`
      + "recorded 的定义是「有文件行的补丁号个数」，写错时只有这一处能对出来",
    );
  }

  const total = declared.total;
  const exempt = idSet(declared.exempt);
  const unmapped = idSet(declared.unmapped);
  const unresolvedIds = idSet(unresolved);
  const hasSelectedField = declared.selected !== undefined;
  const selected = Array.isArray(declared.selected) ? declared.selected.map(String) : null;

  if (selected !== null) {
    const selectedIds = new Set(selected);
    const wanted = [...selectedIds].filter((id) => !exempt.has(id) && !unmapped.has(id));
    const present = new Set([...actualIds, ...unresolvedIds]);
    const absent = wanted.filter((id) => !present.has(id));
    if (absent.length > 0) {
      problems.push(
        `detail.table.selected 里有、但这一轮既没有文件行也没有列进 unresolved 的补丁：`
        + `${absent.join(",")} —— 合法过滤只该少掉未选中的那些，selected 里的缺口不能静默消失`,
      );
    }
    const explained = recorded + unresolvedIds.size;
    if (explained !== wanted.length) {
      problems.push(
        `detail.table.recorded=${recorded} 加 unresolved ${unresolvedIds.size} 条 = ${explained}，`
        + `但 selected ${selectedIds.size} 条去掉 exempt / unmapped 之后 = ${wanted.length}：`
        + "两者不等说明有一批补丁既没有文件行、也没有列进 unresolved（静默丢失）",
      );
    }
    return { problems, notes };
  }

  if (hasSelectedField) {
    notes.push("detail.table.selected 不是数组：这一档按全表判");
  } else {
    notes.push("detail.table 没有 selected（过渡形态）：无 selected，按全表判");
  }
  if (Number.isInteger(total)) {
    const explained = recorded + unresolvedIds.size;
    const budget = total - exempt.size - unmapped.size;
    if (explained !== budget) {
      problems.push(
        `detail.table.recorded=${recorded} 加 unresolved ${unresolvedIds.size} 条 = ${explained}，`
        + `但 total ${total} − exempt ${exempt.size} − unmapped ${unmapped.size} = ${budget}：`
        + "两者不等说明有一批补丁既没有文件行、也没有列进 unresolved（静默丢失）",
      );
    }
  }
  return { problems, notes };
}
