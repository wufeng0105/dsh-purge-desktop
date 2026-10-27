/**
 * lib/redteam/score-keys.js — 服务键、端口解析与交付口径文本，一律纯函数。
 *
 * 为什么单独成文件：这些函数回答的是同一个问题 ——「这条命中属于哪个服务」。
 * 服务键（`scoreServiceKey`）是去重与封顶的粒度基础，端口与 authority 的解析
 * 又是服务键的前提，三件事共用同一套正则与归一规则，拆开就会漂移成两套。
 *
 * 依赖方向：零 import。全部纯函数（输入对象 → 字符串/数字/null），不查库、不读配置，
 * 所以可以在没有 SQLite 的情况下单独验证 —— 这也是计分口径能先建快照的原因。
 */

/** 这条隧道算不算"跨越了靶标边界"。未声明（老数据/没填）返回 null，界面按"待确认"显示。 */
export function tunnelIsLegit(entryKind) {
  const k = String(entryKind || '').trim()
  if (k === '') return null
  return k !== 'self-only'
}

/**
 * 从 target 里解析端口：`http://h:8080/x`、`10.0.0.5:6379`、`10.0.0.5:22`。
 * 没有端口或解析不出返回 null（**不要编造 80/443**，否则会把不同服务并成一个）。
 */
export function parseTargetPort(target) {
  const t = String(target || '').trim()
  if (t === '') return null
  const url = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]+)/i.exec(t)
  const authority = url !== null ? url[1] : (/^([^\s/?#]+)/.exec(t) || [])[1]
  if (!authority) return null
  const m = /:(\d{1,5})$/.exec(authority)
  if (m === null) return null
  const n = Number(m[1])
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null
}

/** 库列的 port 值（老库可能是 null/0/空串）。 */
function normalizePort(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null
}

/**
 * 从 target 里取「服务标识」：host[:port]。
 *   · 端口取显式写的那个；没写就按协议推默认端口（http→80、https→443、其它→不推断），
 *     这样 `http://h/x` 与 `http://h:80/y` 会归到同一个服务；
 *   · 路径/参数/查询串一律丢掉（`http://h:8080/a/b?c=1` → `h:8080`）。
 * 解析不出 host 时返回 null。
 */
function targetAuthority(target) {
  const t = String(target || '').trim()
  if (t === '') return null
  const url = /^([a-z][a-z0-9+.-]*):\/\/([^/?#\s]+)/i.exec(t)
  const scheme = url !== null ? url[1].toLowerCase() : null
  const authority = url !== null ? url[2] : (/^([^\s/?#]+)/.exec(t) || [])[1]
  if (!authority) return null
  const host = authority.replace(/:\d{1,5}$/, '').toLowerCase()
  if (host === '') return null
  let port = parseTargetPort(t)
  /* 没写端口时按协议补默认端口：避免同一个服务的两种写法被算成两个服务而被重复计分 */
  if (port === null) {
    if (scheme === 'http') port = 80
    else if (scheme === 'https') port = 443
  }
  return port === null ? host : host + ':' + port
}

/**
 * 「服务」键：得分封顶的粒度 = 同一个资产的同一个端口。
 *   · target 能解析出 host[:port] → 就用它（`t10.20.30.40:3306`）——
 *     同一个服务可能由不同的人记分，有的带 asset_id、有的只写 target，
 *     以目标为准才能把它们归到一起；
 *   · target 解析不出（缺失/只写了名字）→ 退到资产：有端口用 `a<id>:<port>`，
 *     没端口记 `a<id>:0`（该资产的未知端口）；
 *   · 两样都没有 → null（拿不到服务信息，这条不参与封顶）。
 */
export function scoreServiceKey(hit = {}) {
  const authority = targetAuthority(hit.target)
  if (authority !== null) return 't' + authority
  const assetId = hit.asset_id === null || hit.asset_id === undefined || hit.asset_id === '' ? null : Number(hit.asset_id)
  if (assetId === null) return null
  const port = normalizePort(hit.port)
  return 'a' + assetId + ':' + (port === null ? 0 : port)
}

/** 「服务」的可读标签，给告警/报告用（如 `10.1.2.3:8080`）。 */
export function serviceLabel(hit = {}, assetIp) {
  const ip = assetIp || hit.asset_ip || ''
  const port = normalizePort(hit.port) ?? parseTargetPort(hit.target)
  if (ip !== '') return port === null ? ip : ip + ':' + port
  /* 没有资产 id 时用 target 的 host[:port]（去掉路径与参数，别把整条 URL 当服务名）；
     端口来自库列而 target 里没写时补上，便于一眼看出是哪个服务。 */
  const authority = targetAuthority(hit.target)
  if (authority === null) return hit.target ? String(hit.target) : '(未标注服务)'
  if (port !== null && !/:\d{1,5}$/.test(authority)) return authority + ':' + port
  return authority
}

/**
 * 这条命中为什么不计分（告警 / 界面 / 报告共用一句话，避免三处口径写歪）。
 * @param hit - 命中行（带 code / target / port / rule / rule_cap / capped_reason_kind）
 * @param bestPoints - 去重时被哪条压住（该条的分值）
 */
export function scoreCapReasonText(hit = {}, bestPoints) {
  const label = serviceLabel(hit)
  if (hit.capped_reason_kind === 'cap') {
    return '「' + label + '」这条不计分：'
      + (hit.rule === null || hit.rule === undefined ? '' : '规则 ' + hit.rule + ' ')
      + '的**累计得分已达该规则上限（' + (Number(hit.rule_cap) || 0) + ' 分）**——同一规则超出上限的部分不再累加。'
      + '把精力换到别的规则或别的资产上，不要在已达上限的规则里继续刷。'
  }
  return '「' + label + '」这个目标上的权限已经拿满（计分口径：同一目标只算分值最高的那条'
    + (bestPoints === undefined || bestPoints === null ? '' : '，+' + bestPoints + ' 分')
    + '）——这条按规则不再计分，只作过程留痕；**换目标或换规则推进，不要在同一个目标上刷同类成果**。'
}

/**
 * 旧名 `serviceCapReason`（v0.10 及以前）已在 1.2.1 随 knip 死代码清零一并移除：
 * 唯一消费方 `store-core.js` 的 4 处引用全部走 `scoreCapReasonText`。
 * 需要旧名对读历史补丁时看 git 历史，不要再往导出面加回去。
 */

/**
 * 从证据文本里解析数据量（行/条/记录数）。
 * 支持「120 万条」「1300万行」「1,200,000 条记录」「2.5万行」「1200000 records」。
 * **只认带量词（条/行/记录/records/rows）或中文量级（亿/万…）的写法**——
 * 裸数字不认，否则会把口令里的 `123456`、端口号当成数据量。
 * 解析不出来返回 null（由调用方提示补齐量级，不猜、不编数）。
 */
export function parseRowCount(evidence) {
  const text = String(evidence || '')
  if (text.trim() === '') return null
  const units = { 亿: 1e8, 千万: 1e7, 百万: 1e6, 十万: 1e5, 万: 1e4, 千: 1e3 }
  const nums = []
  /* 「数字 + 单位 + 条/行/记录」：单位是中文量词，或英文 records/rows/entries */
  const cn = /(\d[\d,]*(?:\.\d+)?)\s*(亿|千万|百万|十万|万|千)?\s*(条|行|记录|数据|records?|rows?|entries)/gi
  for (const m of text.matchAll(cn)) {
    const base = Number(String(m[1]).replace(/,/g, ''))
    if (!Number.isFinite(base)) continue
    const mult = m[2] === undefined ? 1 : units[m[2]]
    nums.push(Math.round(base * mult))
  }
  if (nums.length > 0) return Math.max(...nums)
  /* 只写了「导出 120 万」这类（没写条/行）也认，但必须带中文量级 */
  for (const m of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(亿|千万|百万|十万|万|千)/g)) {
    const base = Number(String(m[1]).replace(/,/g, ''))
    if (Number.isFinite(base)) nums.push(Math.round(base * units[m[2]]))
  }
  return nums.length === 0 ? null : Math.max(...nums)
}

/** 千分位展示，告警里读数更直观。 */
export function formatRows(n) {
  return Number(n).toLocaleString('en-US')
}

/**
 * 得分点 → 交付口径（怎么算拿到、拿什么自证、怎么复现）。
 *
 * 为什么单独一张表而不是塞进 `score_point.description`：
 * 描述是"规则文档的条款"（给智能体判档位用），这张表是"给验收人看的复现口径"，
 * 两者受众不同、详略也不同。报告与界面按 code 取这里的说明，
 * 规则文档更新时不必动这张表，反之亦然。
 *
 * 字段：
 *   · need   —— 判定标准：满足什么才算拿到这一项（给验收人对账用）
 *   · proof  —— 自证材料：该附什么证据（G7 的证明材料要求）
 *   · replay —— 复现入口：用哪条请求 / 哪条命令重放（"可复现"最直接的答案）
 *   · script —— 一线可直接照做的动作（尽量是可复制执行的）
 */

export const SCORE_CONFIRM = {
  'domain-control': {
    need: '目标域名解析记录被改为我方可控（NS/A 记录生效），或域名管理后台可操作',
    proof: '管理后台截图 + 改记录前后的 dig/nslookup 对比',
    replay: 'nslookup <域名> <我方 NS>；或后台操作请求原文',
    script: 'dig NS <域名> @8.8.8.8\ndig <域名> @<我方NS>',
  },
  'terminal-access': {
    need: '能对终端下发指令并取回执行结果（不是"发现了一台设备"）',
    proof: '被控终端执行 id/hostname 的回显 + 与目标单位的关系证明（G7）',
    replay: '远控会话里执行 id；或木马/远控的 agent 上线记录',
    script: 'id; whoami; hostname',
  },
  'server-host': {
    need: '在主机上执行了命令并拿到回显（WebShell / 反弹 Shell / 远控均可）',
    proof: '命令回显（id / hostname）+ WebShell 连接要素或会话记录',
    replay: 'WebShell 请求原文（可直接重放）；或反弹 Shell 的监听记录',
    script: 'id; uname -a; cat /etc/passwd | head',
  },
  'db-credential': {
    need: '用账号成功连上数据库并执行了查询（未授权访问也算：能连上即成立）',
    proof: '登录成功后的查询回显（select user(), version()）+ 账号权限级别',
    replay: 'mysql -h <host> -P <port> -u <user> -p\'<pass>\' -e "select user(),version()"',
    script: 'mysql -h <host> -u <user> -p -e "select user(),version(),current_user()"',
  },
  'web-app': {
    need: '以目标已有账号登录进系统（普通或管理员），并访问了受保护页面',
    proof: '登录后的页面内容/回显 + 会话 Cookie 或 Token（证明不是只拿到口令）',
    replay: '登录请求原文（含见证 Cookie/Token）+ 一次带会话的受保护页面请求',
    script: 'curl -i -s -X POST <登录URL> -d "username=<u>&password=<p>" -c cookie.txt\ncurl -s -b cookie.txt <受保护页面>',
  },
  'central-system': {
    need: '登录进堡垒机/域控/SSO/终端管理后台等集权系统并取得管理权限',
    proof: '管理后台页面截图 + 能体现"可管控下属节点"的操作（登录 20% 托管节点或 20 台）',
    replay: '登录请求原文 + 一次管控操作（如列举托管主机）的请求与响应',
    script: 'curl -s -b cookie.txt "<管控列表接口>"',
  },
  'bigdata-system': {
    need: '获得大数据平台（Hadoop/Spark/ES 等）管理或普通权限',
    proof: '平台管理页/接口回显 + 可访问的数据规模（条数或容量）',
    replay: '平台接口请求原文（如 ES _cat/indices、YARN /ws/v1/cluster/apps）',
    script: 'curl -s "<平台接口>" | head -50',
  },
  netdev: {
    need: '登录网络设备（防火墙/路由器/交换机/VPN/网闸）并取得权限',
    proof: '设备管理页截图 + 路由表或连接量截图（G7 明确要求）',
    replay: '设备登录请求原文 + 读取路由表的命令回显',
    script: 'show ip route    # 或 display ip routing-table',
  },
  'netdev-redirect': {
    need: '借助该设备实际改变了流量走向（策略/路由/DNS 改动生效）',
    proof: '改动前后的路由表或策略对比 + 我方节点收到流量的证据',
    replay: '策略配置请求原文 + 我方可控节点上的抓包/访问日志',
    script: 'tcpdump -ni any port <端口> -c 10',
  },
  'netdev-implant': {
    need: '设备上植入了可执行的远控/持久化，**并且**借助它完成了后续攻击',
    proof: '远控进程或持久化项的证据 + 经该设备发起的后续成果记录',
    replay: '植入动作的请求/命令原文 + 后续经由该设备的访问日志',
    script: '',
  },
  iiot: {
    need: '获得工业互联网系统管理权限，或批量控制其下的互联设备',
    proof: '管理后台截图 + 被控设备清单与数量',
    replay: '登录请求原文 + 设备列表接口响应',
    script: '',
  },
  'cloud-platform': {
    need: '云管理平台管理员权限；或通过 ak/sk 批量控制云上节点（≥100 个才计节点分）',
    proof: '平台管理页截图；ak/sk 场景需给出被控节点清单与数量、或管理员证明（新增节点/改权限）',
    replay: '平台接口请求原文（列举实例、创建用户等）',
    script: 'curl -s -H "Authorization: Bearer <token>" "<平台/实例列表接口>"',
  },
  'iot-platform': {
    need: '获得物联网管控平台权限，或按其连接点批量控制设备',
    proof: '平台管理页截图 + 连接点/设备数量',
    replay: '平台登录与设备列表接口原文',
    script: '',
  },
  'iot-corenet': {
    need: '从物联网端点设备横向进入核心网，并控制了业务生产等重要系统',
    proof: '路径说明（哪个端点→核心网→哪个系统）+ 该系统的控制证据',
    replay: '从端点发起的横向动作命令 + 核心网系统的登录/操作请求',
    script: '',
  },
  secdev: {
    need: '获得非集权类安全设备（IPS/IDS/审计/WAF）管理员权限',
    proof: '设备管理页截图 + 能体现策略可控的操作',
    replay: '登录请求原文 + 一条策略读取接口响应',
    script: '',
  },
  'file-storage': {
    need: '获得文件存储系统后台权限（FTP/NAS/网盘/对象存储），或拿到其普通账号',
    proof: '目录列举截图 + 可读文件清单（数据成果另有计分，见 G2）',
    replay: '列举目录的请求原文（FTP LIST / S3 ListObjects / WebDAV PROPFIND）',
    script: 'curl -s "<存储接口>" | head -50',
  },
  'ai-agent': {
    need: '控制模型智能体/skill 等 agent 工具，并**实际驱动它执行了动作**',
    proof: '对话或调用记录 + 被驱动执行的动作与其结果（区间分按控制深度研判）',
    replay: '驱动 agent 的请求原文 + 它执行动作的回显',
    script: '',
  },
  'model-compute': {
    need: '获得算力管理平台/训练数据与知识库系统的系统管理权限',
    proof: '管理后台截图 + 能体现算力调度或数据可读写的操作',
    replay: '平台登录与调度/数据接口原文',
    script: '',
  },
  'model-data': {
    need: '获得模型相关数据系统管理员权限（可影响训练/推理/运营或窃取篡改权重）',
    proof: '管理后台截图 + 可读写的模型/数据集清单',
    replay: '平台接口原文（列举模型、下载权重）',
    script: '',
  },
  'computepower-admin': {
    need: '获得算力基础设施管理员权限',
    proof: '管理后台截图 + 可调度资源证明',
    replay: '平台登录与资源列表接口原文',
    script: '',
  },
  'computepower-cards': {
    need: '实际取得算力卡资源（10 分/卡）或卡池化平台控制权',
    proof: '卡资源清单（数量）+ 能提交任务或独占卡的证据',
    replay: 'nvidia-smi 回显 / 平台卡列表接口',
    script: 'nvidia-smi -L',
  },
  'boundary-logical': {
    need: '从靶标侧建立了通往内网的通道，并能**实际访问内网目标**',
    proof: '隧道登记（入口必须是目标侧）+ 经隧道访问内网目标的回显/截图（G7）',
    replay: '经隧道访问内网目标的那条命令与回显；隧道搭建命令',
    script: 'curl --socks5-hostname 127.0.0.1:<端口> http://<内网IP>/ -i',
  },
  'boundary-strong': {
    need: '突破网闸类强隔离，进入强隔离业务内网并实际访问到内网目标',
    proof: '网闸类隔离设备的控制截图 + 能访问内网的截图证明（G7）',
    replay: '经强隔离通道访问内网目标的命令与回显',
    script: '',
  },
  'boundary-physical': {
    need: '突破物理隔离/进入核心生产网并实际访问到目标',
    proof: '防火墙/VPN/多网卡主机/网闸的控制截图 + 能访问内网的截图（G7）',
    replay: '进入核心网后访问目标的命令与回显',
    script: '',
  },
  'boundary-supply': {
    need: '借助供应链运维通道或云服务进入主防单位内网（按情形分别计分）',
    proof: '供应链/云侧的控制证据 + 进入主防单位内网的证明；写明属于哪种情形',
    replay: '从供应链通道进入内网的命令与回显',
    script: '',
  },
}

/** 取某个得分点的交付口径；没有专门条目时返回 null（报告会退回只显示 evidence）。 */
export function scoreConfirmOf(code) {
  const key = String(code || '').trim()
  return SCORE_CONFIRM[key] === undefined ? null : SCORE_CONFIRM[key]
}


/* 门面要这两个：原本它们只在模块内部用，拆出来之后由 score-rules.js 原样再导出，
   调用方零改动。改签名前先看 store-core.js 的用法。 */
export { normalizePort, targetAuthority }
