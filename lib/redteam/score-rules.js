/**
 * lib/redteam/score-rules.js — 计分口径的门面：三份实现原样再导出，导出面冻结在 26 个名字。
 *
 * 为什么保留这个文件而不让调用方直接指向新文件：fan-in 侧（store-core.js 与 schema.js）
 * 的 import 语句一行都不用改，调用方也不需要知道哪个名字现在落在哪个文件。
 * 门面把「实现切成了三份」这件事关在门里 —— 功能很多，接口没变复杂。
 *
 * 分工（三份新文件各管一件事，且互不反向依赖）：
 *   · score-points.js —— 口径数据：默认得分点、类别、封顶 code 名单与量级门槛；
 *   · score-board.js  —— 判定：去重、规则上限与统一评估入口的唯一实现；
 *   · score-keys.js   —— 服务键与解析：服务粒度、端口归一与交付口径文本。
 *
 * `export … from` 本身就是「import 并原样再导出」：依赖图上三条边与写成 import 再 export
 * 完全一样，但不在这里建本地绑定（本文件没有代码，建了也只是多一份可能被误用的局部名）。
 */

export {
  TUNNEL_ENTRY_KINDS, SERVICE_CAPPED_POINT_CODES, SENSITIVE_DATA_MIN_ROWS,
  SCORE_GROUPS, DEFAULT_SCORE_POINTS,
} from './score-points.js'

export {
  tunnelIsLegit, parseTargetPort, normalizePort, targetAuthority, scoreServiceKey,
  serviceLabel, scoreCapReasonText, parseRowCount, formatRows, SCORE_CONFIRM, scoreConfirmOf,
} from './score-keys.js'

export {
  applyScoreCaps, loadScoreMeta, loadAssetNames,
  hitPointsOf, targetHasIpv6Host, scoreMultiplierOf, evaluateScoreBoard,
} from './score-board.js'

/**
 * @public
 *
 * 这三个是 score-board.js 的内部辅助（`system` 口径的系统键、同口径择优、旧口径分组），
 * 在仓库里**没有外部调用方**。它们仍然留在导出面上，是因为这个文件对外是 26 个名字的
 * 冻结契约（拆分前后必须一字不差），而不是因为有人要用它们。
 *
 * `@public` 标的就是这层意图：knip 会把「无人 import 的 re-export」判成漏删，
 * 而这里的正确答案是「契约的一部分，删了就是破坏导出面」。真要让它们退场，
 * 得先改导出契约，不能顺手在这里删。
 */
export { systemKeyOf, pickBestHit, legacyCapGroup } from './score-board.js'
