/**
 * lib/redteam/ui.js — 面板到事实库的私有 HTTP 桥，只为浏览器半侧服务。
 * 演练台 —— 宿主侧
 *
 * 职责：为浏览器半侧提供一条 Package 私有的 HTTP 桥接 `POST /redteam/api`：
 *   · 资产库相关 op 转交 `ctx.redteam`（dsh-redteam-store 发布的进程级服务）；
 *   · 会话连通性 op（probeSessions）在 host 侧真实发起 TCP/HTTP 探测；
 *   · 技能目录 op（skillCatalog / skillRead）直接读 `ctx.skills`，按红队 preset
 *     的 standing scope 取目录——技能由 DSH 原生 skill 体系管理（$DSH_HOME/skills、
 *     项目 .dsh/skills、.agents/skills），演练台只做浏览。
 *
 * 为什么走 webServer 而不是 typert/@Remote：本包与 store 包都刻意保持零外部依赖
 * （profile 下解析不到 node_modules），具名路由是最小且稳定的接缝。
 * 跨源请求由 Origin/Host 校验挡住（同源 POST 才放行）。
 */
import { fileURLToPath } from 'node:url'
import { resolve, join, dirname } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { spawn, execFileSync } from 'node:child_process'
import { request as httpsRequest } from 'node:https'
import { dispatch, dispatchAsync } from './store-core.js'
/* 技能可用性判定与 redteam_preflight 共用同一份实现（环境变量 / 本机路径 / 占位符） */
import { checkSkill, officialSkillSummaries, skillLibraryOf, summarizeSkills } from './skill-availability.js'
import { maxAgentsOf, maxAgentsSourceOf, saveMaxAgents, DEFAULT_MAX_AGENTS, MAX_AGENTS_LIMIT } from './settings.js'
import {
  loadPlatformConfig, mergeConfigEnv, redteamRoot, envAdaptStatus, markEnvAdaptSkip,
  platformSummary, savePlatformConfig, assignToolkitFolder,
} from './platform-config.js'
/* 状态层契约：只读字段从这一份声明取，演练台不再把 envAdaptStatus 原样透给浏览器。 */
import * as contract from '../state/contract.js'
/* 技能目录的唯一枚举处：目录清单、优先级、库归属都从这一份来，演练台不再自己拼。 */
import * as skillsCatalog from '../state/skills-catalog.js'

/** DSH_HOME：显式环境变量优先；Windows 上 HOME 常空，回退 homedir()。 */
function dshHomeOf() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  return join(homedir(), '.dsh')
}

/**
 * 本包自带技能目录候选。
 * 桌面端经 profile/node_modules 符号链接加载时，单靠 import.meta.url 拼相对路径
 * 可能指到不存在的位置（空格路径、未解析的 junction）；所以多路探测并 realpath。
 * 不从 index.js 引 packagePaths，避免与 cordis 插件入口互相拖拽。
 */
/** `$DSH_HOME` 的两个可能来源（插件进程 env 与宿主 dshHomePath 用的 home 会分叉）。 */
function dshHomeCandidates() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(process.env.DSH_HOME)
  push(join(homedir(), '.dsh'))
  return out
}

function resolvePluginSkillsDir() {
  const candidates = []
  try {
    const root = fileURLToPath(new URL('../..', import.meta.url))
    candidates.push(join(root, 'skills', 'redteam'))
  } catch { /* ignore */ }
  try {
    candidates.push(resolve(fileURLToPath(new URL('../../skills/redteam/', import.meta.url))))
  } catch { /* ignore */ }
  /* installBundledSkills 落盘位置：包内路径失效时仍能列出技能。两个候选 home 都探。 */
  for (const home of dshHomeCandidates()) {
    candidates.push(join(home, 'redteam', 'skills'))
    for (const profile of ['desktop', 'web', 'headless']) {
      candidates.push(join(home, 'profiles', profile, 'node_modules', 'dsh-purge', 'skills', 'redteam'))
    }
  }
  /* 不扫官方 $DSH_HOME/skills：技能只认本包 / 同步副本（与上游插件包内分发一致）。 */
  for (const raw of candidates) {
    if (!raw) continue
    try {
      if (!existsSync(raw)) continue
      const real = realpathSync(raw)
      const md = readdirSync(real).filter((f) => f.endsWith('.md'))
      if (md.length > 0 || /skills[/\\]redteam$/i.test(real) || /[/\\]skills$/i.test(real)) return real
    } catch { /* try next */ }
  }
  return null
}

const PLUGIN_SKILLS_DIR = resolvePluginSkillsDir()

/**
 * 演练台看到的技能目录：**与设置页同一份集合**。
 *
 * 枚举与合并都在 `../state/skills-catalog.js`：`$DSH_HOME/skills` 在前、随包同步副本在
 * 后，同名取先出现者。这里只把共享条目摊成演练台的字段名，并补上「这一份能不能编辑」——
 * 可用性判定（缺工具 / 缺密钥 / 占位符没换）仍由 `checkSkill` 按现场逐条做，那是演练台
 * 独有的口径，但它不改集合本身。
 *
 * @param {string} [dshHome] 宿主数据目录；缺省按 DSH_HOME / 用户目录推断
 * @returns {{roots:Array<object>, items:Array<object>, total:number,
 *   byLibrary:Record<string,number>, shadowed:Array<object>}}
 */
export function skillCatalogOfHome(dshHome = '') {
  const home = String(dshHome || '').trim() || dshHomeOf()
  const view = skillsCatalog.readSkillCatalog(home)
  const items = view.items.map((item) => {
    const official = item.library === skillsCatalog.SKILL_LIBRARIES.official
    return {
      name: item.name || item.id,
      description: item.description || '',
      whenToUse: '',
      provider: official ? 'dsh' : 'dsh-purge',
      source: official ? 'official' : 'plugin',
      dir: item.dir,
      path: item.path,
      modelInvocable: true,
      userInvocable: true,
      fromPlugin: !official,
      library: official ? 'official' : 'redteam',
      editable: item.editable === true,
    }
  })
  return {
    roots: view.roots.map((root) => ({ library: root.library, dir: root.dir, rank: root.rank })),
    items,
    total: items.length,
    byLibrary: view.byLibrary,
    shadowed: view.shadowed,
  }
}

function readOfficialSkill(name) {
  if (typeof name !== 'string' || name.length === 0) return { ok: false, error: 'name required' }
  const found = officialSkillSummaries().find((skill) => skill.name === name)
  if (!found) return { ok: false, error: 'skill not found: ' + name }
  return {
    ok: true,
    name: found.name,
    description: found.description,
    whenToUse: '',
    provider: 'dsh',
    source: 'official',
    path: found.path,
    content: found.content,
    library: 'official',
  }
}

function officialCatalogItems() {
  return officialSkillSummaries().map((skill) => ({
    name: skill.name,
    description: skill.description,
    whenToUse: '',
    provider: 'dsh',
    source: 'official',
    dir: skill.resourceBase && skill.resourceBase.path,
    path: skill.path,
    modelInvocable: true,
    userInvocable: true,
    fromPlugin: false,
    library: 'official',
    availability: 'listed',
    problems: [],
    needs_user: [],
  }))
}

/**
 * 把「官方 + 红队」并成一份，规则来自目录模块。
 *
 * 旧实现自己写合并：红队条目原样留着、官方摘要按名过滤掉已出现的那些 —— 于是
 * 「红队有一条、官方也有一条同名」时两条都在，界面上是同名两行；而 preset 的
 * `customSkillDirs` 早就规定了「同名取先出现者」。现在合并（含遮蔽记录与按库计数）
 * 只有 `buildSkillsCatalog` 一份实现，两个页面的集合因此逐项相同。
 */
function withBothLibraries(payload) {
  if (!payload || payload.ok === false || !Array.isArray(payload.items)) return payload
  const roots = skillsCatalog.skillRootsFor(dshHomeOf())
  const entries = payload.items
    .map((item) => Object.assign({}, item, {
      id: item.name,
      library: item.library === 'official' ? 'official' : 'redteam',
    }))
    .concat(officialCatalogItems())
  const merged = skillsCatalog.buildSkillsCatalog({ roots, entries })
  return Object.assign({}, payload, {
    items: merged.items,
    total: merged.total,
    shadowed: merged.shadowed.length,
    libraries: {
      redteam: merged.byLibrary.redteam || 0,
      official: merged.byLibrary.official || 0,
    },
  })
}
/** 目录比较要规范化：注册表给的是 `/a/b/skills`，URL 拼出来可能带结尾斜杠。 */
const sameDir = (a, b) => {
  if (a === null || b === null) return false
  try {
    const left = existsSync(a) ? realpathSync(a) : resolve(a)
    const right = existsSync(b) ? realpathSync(b) : resolve(b)
    return left === right
  } catch {
    try { return resolve(a) === resolve(b) } catch { return false }
  }
}

/** Cordis 插件名。 */
export const name = 'dsh-purge-redteam-ui'

/**
 * 硬依赖只留资产库 + HTTP。
 * skills / agentPresets 在桌面端时常序更晚或名称不同；写成硬依赖会导致整条
 * `/redteam/api` 挂不上，界面里技能库/知识库/SQLite 全部读不到。
 */
export const inject = ['redteam', 'webServer']

/** 请求体上限（资产导入可能较大）。 */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/* ------------------------------------------------------------------ 版本与更新 */

/** 运行 shell 命令，带超时；返回 `{ code, stdout, stderr, timedOut }`。 */
function run(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    let child
    try {
      /* ⚠️ 三个都踩过：
         · env 必须显式传 process.env —— spawn 默认给的是空环境，空 PATH 下
           npm/pnpm 会直接 `spawn npm ENOENT`（版本检查永远失败）；
         · cwd 必须是**真实存在**的目录 —— 传一个不存在的路径同样是 ENOENT
           （报错长得像"命令找不到"，很容易误判）；
         · Windows 上 npm/npx/pnpm/yarn 都是 .cmd 批处理，Node 的 spawn 不走
           shell 时直接找不到可执行文件 —— 必须 `shell: true`（或补 .cmd 后缀）
           才能解析 PATHEXT，不然红队面板「检测新版本」永远 code=-1。 */
      const cwd = typeof options.cwd === 'string' && options.cwd !== '' && existsSync(options.cwd) ? options.cwd : undefined
      const isWin = process.platform === 'win32'
      const needsShim = isWin && /^(npm|npx|pnpm|pnpx|yarn)$/i.test(command)
      child = spawn(needsShim ? `${command}.cmd` : command, args, {
        cwd,
        env: options.env || process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: needsShim,
        windowsHide: isWin,
      })
    } catch (error) {
      resolvePromise({ code: -1, stdout: '', stderr: error && error.message ? error.message : String(error) })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const CHILD_IO_CAP = 1 << 20 // 子进程 stdout/stderr 各 1MB 上限,防失控子进程 OOM 宿主
    const done = (value) => { if (!settled) { settled = true; resolvePromise(value) } }
    const cleanupPipes = () => {
      try { child.stdout.removeAllListeners(); child.stderr.removeAllListeners() } catch { /* ignore */ }
      try { child.stdout.destroy(); child.stderr.destroy() } catch { /* ignore */ }
    }
    // kill 子孙:child.kill 只杀直接子,孙子(npm → node → tool)活着。Windows 用 taskkill /T 杀树,
    // POSIX 兜底 SIGKILL + 尝试 process group kill。
    const killTree = () => {
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      try {
        if (process.platform === 'win32' && child.pid) {
          execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
            stdio: 'ignore', windowsHide: true, timeout: 2000,
          })
        } else if (child.pid) {
          try { process.kill(-child.pid, 'SIGKILL') } catch { /* 不是 group leader,忽略 */ }
        }
      } catch { /* taskkill 失败也无所谓,child.kill 已先触发 */ }
    }
    const timer = setTimeout(() => {
      killTree()
      cleanupPipes()
      done({ code: -1, stdout: stdout, stderr: stderr, timedOut: true })
    }, Math.max(Number(options.timeoutMs) || 30000, 1000))
    child.stdout.on('data', (c) => {
      if (settled) return
      if (stdout.length + c.length > CHILD_IO_CAP) {
        killTree()
        clearTimeout(timer); cleanupPipes()
        done({ code: -1, stdout, stderr, oversize: 'stdout' }); return
      }
      stdout += c.toString('utf8')
    })
    child.stderr.on('data', (c) => {
      if (settled) return
      if (stderr.length + c.length > CHILD_IO_CAP) {
        killTree()
        clearTimeout(timer); cleanupPipes()
        done({ code: -1, stdout, stderr, oversize: 'stderr' }); return
      }
      stderr += c.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer); cleanupPipes()
      done({ code: -1, stdout: stdout, stderr: String((error && error.message) || error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer); cleanupPipes()
      done({ code: code === null ? -1 : code, stdout: stdout, stderr: stderr })
    })
  })
}

/** 本插件包身份（由 store 壳读取 package.json 后挂上；读不到则报"未知版本"）。 */
function pluginIdentity(ctx) {
  const store = ctx.redteam
  const info = store && store.plugin ? store.plugin : null
  return {
    name: (info && info.name) || 'dsh-purge',
    version: (info && info.version) || null,
    description: (info && info.description) || '',
    homepage: (info && info.homepage) || null,
  }
}

/**
 * profile 目录：DSH 的 `ctx.baseUrl` 就是它（loader.internal.import(name, profileDir) 的 base）。
 * ⚠️ `ctx.baseUrl` 实际是 `file:///...` URL —— 直接当路径传给 join/existsSync 会把
 *    `node_modules` 拼到 URL 后面，`updatePreflight` 把 `devLinked` 永久判成 true，
 *    之后面板的「更新」按钮永远灰着。必须 fileURLToPath 转回系统路径。
 */
function profileDirOf(ctx) {
  try {
    const raw = ctx && typeof ctx.baseUrl === 'string' ? ctx.baseUrl : ''
    if (raw) return raw.startsWith('file://') ? fileURLToPath(raw) : raw
  } catch { /* 忽略：转换失败走兜底路径 */ }
  // 兜底只认 desktop：SURFACE-1 之后只支持官方桌面端，profiles/web 恒不存在。
  // 这里曾经是 'web'，桌面端每次都会拿到一个不存在的目录 —— updatePreflight
  // 于是把「装在哪」判成开发态，更新按钮永远灰着。
  return join(dshHomeOf(), 'profiles', 'desktop')
}

/**
 * 平台摘要的读侧形状：环境闸门那一段换成契约块。
 *
 * 浏览器半侧只读契约里声明过的九个字段；`envAdaptStatus()` 的其它字段（工具明细、
 * Kali 探测细节）仍留在服务端，真要展示就先进 `STATE_BLOCKS` 加一条声明。
 */
function withEnvBlock(summary) {
  if (!summary || typeof summary !== 'object') return summary
  return Object.assign({}, summary, { adapt: contract.envBlock(summary.adapt) })
}

/**
 * 只读 op `platformEnvAdaptStatus` 的回包：字段与派生都来自契约 `env` 块。
 *
 * 单独成函数（而不是在分支里内联）有两个原因：一是这条 op 与 `/dsh-purge/status` 的
 * `env` 块必须给出同一组取值，`test/api-parity.test.mjs` 拿它逐字段对账；二是「收编到
 * 契约」这句话要有一个能被调用的落点，否则下一个改这条 op 的人又会就地摊一遍字段。
 *
 * @param {object} status `envAdaptStatus()`
 * @returns {{ok:boolean} & Record<string, unknown>} 契约 env 块的九个字段 + 信封 ok
 */
export function envAdaptPayload(status) {
  return Object.assign({ ok: true }, contract.envBlock(status))
}

/**
 * 环境适配 op：面板 EnvTab 读写 `$DSH_HOME/redteam/config.json`。
 * @returns JSON 结果，或 undefined 表示不是这个 op。
 */
function handlePlatformOp(store, request) {
  const op = request && request.op
  if (op !== 'platformConfigGet' && op !== 'platformConfigSave' && op !== 'platformAssignToolkit'
    && op !== 'platformEnvAdaptStatus' && op !== 'platformEnvAdaptSkip') {
    return undefined
  }
  const root = (store && store.root) || redteamRoot()
  // EnvAdaptSendGate 轮询就绪 / 「暂不配置」；缺分支时前端永远拿不到 ready。
  if (op === 'platformEnvAdaptStatus') return envAdaptPayload(envAdaptStatus(root))
  if (op === 'platformEnvAdaptSkip') {
    return Object.assign({ ok: true }, markEnvAdaptSkip(root, request.skip === undefined ? true : !!request.skip))
  }
  if (op === 'platformConfigGet') return withEnvBlock(platformSummary(root))
  if (op === 'platformConfigSave') {
    savePlatformConfig(request.config || {}, root)
    return withEnvBlock(platformSummary(root))
  }
  return assignToolkitFolder(request.dir, root)
}

/** 读 profile 的 package.json（依赖声明 + dsh.profile.bundles）。 */
function readProfilePackage(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch { return null }
}

/** 包管理器：profile 里有 pnpm-lock / pnpm-workspace 就用 pnpm，否则 npm。 */
function packageManagerOf(dir) {
  if (existsSync(join(dir, 'pnpm-lock.yaml')) || existsSync(join(dir, 'pnpm-workspace.yaml'))) return 'pnpm'
  return 'npm'
}

/**
 * 更新前置检查：装的是不是发布版（profile 里能不能解析到这个包名）、
 * 有没有智能体正在跑（更新要重启 dsh web，会把它们打断）。
 */
async function updatePreflight(ctx) {
  const dir = profileDirOf(ctx)
  const pkg = pluginIdentity(ctx)
  const profilePkg = readProfilePackage(dir)
  const deps = (profilePkg && profilePkg.dependencies) || {}
  const declared = typeof deps[pkg.name] === 'string' ? deps[pkg.name] : null
  const installedDir = join(dir, 'node_modules', pkg.name)
  const blockers = []
  const notes = []

  /* ① 开发态（源码软链）：profile 里没有这个包名 → 不能用包管理器更新 */
  const devLinked = declared === null && !existsSync(join(installedDir, 'package.json'))
  if (devLinked) {
    blockers.push('当前是**开发态安装**（profile 依赖里没有 ' + pkg.name + '，是源码软链/手动挂载的），包管理器更新不适用。')
    notes.push('开发态请在本仓库升级：`git pull && npm run build:client`，再重启 DeepSeek Harness。')
  }

  /* ② 有智能体在跑：重启会打断它们 */
  let running = []
  try {
    const subagents = ctx.get('subagents')
    const sessions = ctx.get('sessions')
    if (subagents !== undefined && subagents !== null && sessions !== undefined && sessions !== null && typeof sessions.list === 'function') {
      const roots = sessions.list().filter((s) => {
        const header = s && s.header
        return header && (header.parentSession === undefined || header.parentSession === null)
      })
      for (const root of roots) {
        try {
          const kids = await subagents.listChildren(root.id)
          for (const k of Array.isArray(kids) ? kids : []) {
            if (k && k.kind === 'child' && k.activity === 'running') running.push({ session: String(root.id), label: k.label || String(k.id) })
          }
        } catch { /* 单个会话读不到不影响其它 */ }
      }
    }
  } catch { /* 注册表不可用就不挡（只是少了一层保护） */ }
  if (running.length > 0) {
    blockers.push('有 ' + running.length + ' 个智能体正在跑（' + running.map((r) => r.label).join('、') + '）：更新要重启当前宿主，会打断它们。请等它们结束。')
  }
  return { dir, declared, packageManager: packageManagerOf(dir), devLinked, running, blockers, notes }
}

/**
 * 解析更新源仓库。UPDATE-1：**不再有任何隐式回退**。
 *
 * 旧版在没有 homepage 时返回 `wufeng0105/dsh-purge`（一个仍可匿名下载的公网仓），
 * 私有库的「检查更新」会把那个仓当成权威版本源。
 *
 * 现在的判定顺序（与 lib/update.js 的 resolveUpdateSource 同一套约定；
 * 不跨模块 import —— depcruise 的 redteam-no-core 规则禁止 redteam 回引 core）：
 *   1. 环境变量 DSH_PURGE_UPDATE_REPO=owner/name
 *   2. package.json 的 dsh.updateSource = { mode: "github", repo }
 *   3. 都没有 → 空串。**homepage 不再参与判定** —— 它指向私有仓，
 *      未认证的 API 请求只会 404，把「没配源」伪装成「网络故障」。
 */
const UPDATE_REPO_ENV = 'DSH_PURGE_UPDATE_REPO'
const REPO_SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/

function updateSourceRepo() {
  const fromEnv = String(process.env[UPDATE_REPO_ENV] || '').trim()
  if (fromEnv && REPO_SLUG_RE.test(fromEnv)) return fromEnv
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const cfg = pkg && pkg.dsh && pkg.dsh.updateSource
    const repo = String((cfg && cfg.repo) || '').trim()
    if (cfg && cfg.mode === 'github' && REPO_SLUG_RE.test(repo)) return repo
  } catch { /* 读不到 package.json 就当没配 */ }
  return ''
}

/** 简陋 JSON 抓取（10 秒超时，30xx 不自动跳转——api.github.com 不会跳）。 */
function fetchJsonFromGithub(url) {
  return new Promise((resolveP) => {
    try {
      const req = httpsRequest(url, {
        method: 'GET',
        headers: {
          'user-agent': 'dsh-purge-updater',
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
        },
      }, (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          resolveP({ ok: false, error: `HTTP ${res.statusCode}` })
          return
        }
        let body = ''
        const BODY_CAP = 1 << 20 // 1MB:github tags/releases JSON 一般几 KB~几十 KB,1MB 够用也足够防 OOM
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          if (body.length + chunk.length > BODY_CAP) {
            try { res.destroy(new Error('body too large')) } catch { /* 忽略 */ }
            resolveP({ ok: false, error: 'response body too large' })
            return
          }
          body += chunk
        })
        res.on('end', () => {
          try { resolveP({ ok: true, data: JSON.parse(body) }) }
          catch { resolveP({ ok: false, error: 'JSON parse error' }) }
        })
      })
      // req.setTimeout 要 socket 分配后才生效,DNS 查询阶段卡死不触发。外加 setTimeout 兜底。
      const extTimer = setTimeout(() => {
        try { req.destroy(new Error('timeout')) } catch { /* 忽略 */ }
        resolveP({ ok: false, error: 'timeout' })
      }, 12000)
      req.setTimeout(10000, () => { try { req.destroy(new Error('timeout')) } catch { /* 忽略 */ } })
      req.on('error', (e) => { clearTimeout(extTimer); resolveP({ ok: false, error: String(e && e.message || e) }) })
      req.on('close', () => clearTimeout(extTimer))
      req.end()
    } catch (e) {
      resolveP({ ok: false, error: String(e && e.message || e) })
    }
  })
}

/** 预发布版本名识别：`-beta`/`-rc`/`-pre` 之类不算 stable。 */
function isPrereleaseName(name) {
  return /[-._](?:alpha|beta|rc|pre|preview|dev|snapshot|test)(?:[-._\d]|$)/i.test(String(name || ''))
}

/** GitHub Tags 兜底：dsh-purge 不发到 npm，`npm view` 必定 404。只回落稳定 tag。 */
async function checkLatestFromGithub() {
  const repo = updateSourceRepo()
 // UPDATE-1：没有显式配置的远端源 → 不发任何请求，给出可读原因。
  if (!repo) {
    return {
      ok: false,
      error: '本地版：这是私有库，没有配置远端更新源，不检查更新。'
        + `要启用请设置环境变量 ${UPDATE_REPO_ENV}=owner/name。`,
    }
  }
  const r = await fetchJsonFromGithub(`https://api.github.com/repos/${repo}/tags?per_page=50`)
  if (!r.ok || !Array.isArray(r.data)) return { ok: false, error: r.error || 'GitHub tags 不可用' }
  let latest = null
  for (const row of r.data) {
    const name = String(row && row.name || '').trim()
    if (!/^v?\d+\.\d+\.\d+/.test(name)) continue
    const ver = name.replace(/^v/, '')
    /* 预发布 tag（1.2.0-beta.1、2.0.0-rc1）如果 core 号比 stable 大，直接取它会把
       没正式发出去的版本当「最新」—— 复用 update.js 的 latestStableVersion 口径，
       跳过。 */
    if (isPrereleaseName(ver)) continue
    if (!latest || versionLess(latest, ver)) latest = ver
  }
  if (!latest) return { ok: false, error: 'GitHub 上没有可识别的稳定版本 tag' }
  return { ok: true, latest, registry: 'github' }
}

/** 到 npm registry 查最新版本（走包管理器，避免自带网络栈）。dsh-purge 不在 npm → 直接走 GitHub。 */
async function checkLatest(ctx, dir, name) {
  const pkg = pluginIdentity(ctx)
 // UPDATE-1：没有配置远端源时，连 `npm view` 都不跑 —— 那是网络请求。
  // 私有库没有可用的权威版本源，静默打一次 registry 只会把「没配源」伪装成「查询失败」。
  if (!updateSourceRepo()) {
    return {
      ok: false,
      error: '本地版：这是私有库，没有配置远端更新源，不检查更新。'
        + `要启用请设置环境变量 ${UPDATE_REPO_ENV}=owner/name。`,
    }
  }
  const pm = packageManagerOf(dir)
  const args = ['view', name, 'version', '--json']
  const r = await run(pm, args, { cwd: dir, timeoutMs: 60000 })
  if (r.code === 0) {
    const raw = String(r.stdout || '').trim().replace(/^"|"$/g, '')
    const latest = raw.split('\n').map((x) => x.trim().replace(/^"|"$/g, '')).filter(Boolean).pop() || null
    if (latest) return { ok: true, latest, registry: pm }
  }
  /* npm 兜底失败（最常见是 404——dsh-purge 根本没发到 npmjs，上游 issue #93）或 Windows
     未配 PATH 的 ENOENT，都走 GitHub Tags：这是本仓库的权威版本源。 */
  const gh = await checkLatestFromGithub()
  if (gh.ok) return gh
  const stderr = String(r.stderr || r.stdout || '').trim().slice(0, 400)
  return { ok: false, error: `查询最新版本失败（${pm} view: ${stderr || 'code ' + r.code}; github: ${gh.error}）` }
}

/** `a < b`（只比较数字段，够用；预发布后缀按"更旧"处理）。 */
function versionLess(a, b) {
  const parse = (v) => String(v || '').split('-')[0].split('.').map((x) => Number(x) || 0)
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if ((x[i] || 0) < (y[i] || 0)) return true
    if ((x[i] || 0) > (y[i] || 0)) return false
  }
  return false
}

/**
 * 重启脚本：等旧进程退出 + 端口释放，再按同样的参数把 dsh web 拉起来。
 *
 * 生成的是一个**自包含的 node 脚本**（不是 shell 脚本），它做三件事：
 *   ① 等旧 pid 退出（最多 60 秒）；
 *   ② 等端口不再被监听（最多 30 秒，用 net 探测，不依赖 ss/lsof）；
 *   ③ spawn(command, ARGS_ARRAY) 以 argv 数组拉起新进程。
 *
 * 为什么不用 shell：原实现把命令与参数拼成 shell 串，需要一套手写引号转义
 * （单引号里套单引号、双引号再转义），任何一处漏掉就是命令注入 ——
 * 而这段脚本正是"由程序生成、以用户身份执行"的，最不该有注入面。
 * argv 数组交给 spawn 之后 shell 完全不参与，转义问题从根上消失。
 *
 * @param pid - 当前进程 pid（等它退出）。
 * @param port - dsh web 端口（等它释放）。
 * @param command - 可执行文件（通常是 process.argv[0]）。
 * @param args - 参数数组（process.argv.slice(1)）。
 * @param logPath - 日志文件路径（追加写）。
 * @param cwd - 新进程的工作目录。
 * @returns 脚本正文。
 */
function restartScript(pid, port, command, args, logPath, cwd) {
  const payload = {
    oldPid: Number(pid),
    port: Number(port) || 0,
    command: String(command),
    args: args.map((a) => String(a)),
    log: String(logPath),
    cwd: String(cwd),
  }
  return [
    '#!/usr/bin/env node',
    '/* 由演练台的「自动更新」生成：等旧 dsh web 退出后，按原 argv 把它重新拉起。',
    '   参数以数组形式传给 spawn —— shell 不参与，因此不存在引号转义与命令注入问题。 */',
    "'use strict'",
    'const { spawn } = require("node:child_process")',
    'const { appendFileSync, mkdirSync } = require("node:fs")',
    'const { connect } = require("node:net")',
    'const { dirname } = require("node:path")',
    'const CFG = ' + JSON.stringify(payload, null, 2),
    '',
    'const log = (msg) => {',
    '  const line = "[" + new Date().toISOString() + "] " + msg + "\\n"',
    '  try { mkdirSync(dirname(CFG.log), { recursive: true }); appendFileSync(CFG.log, line) } catch (e) { /* 日志写不进去不该影响重启 */ }',
    '}',
    '',
    'const sleep = (ms) => new Promise((r) => setTimeout(r, ms))',
    '',
    '/** 旧进程还在吗（kill -0 的等价物）。 */',
    'const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return false } }',
    '',
    '/** 端口还有人在听吗（不依赖 ss/lsof）。 */',
    'const portBusy = (port) => new Promise((resolve) => {',
    '  if (!port) { resolve(false); return }',
    '  const sock = connect({ host: "127.0.0.1", port: port })',
    '  let done = false',
    '  const finish = (busy) => { if (!done) { done = true; try { sock.destroy() } catch (e) {} resolve(busy) } }',
    '  sock.setTimeout(800)',
    '  sock.on("connect", () => finish(true))',
    '  sock.on("timeout", () => finish(false))',
    '  sock.on("error", () => finish(false))',
    '})',
    '',
    'async function main() {',
    '  log("等待旧进程 pid=" + CFG.oldPid + " 退出…")',
    '  for (let i = 0; i < 60; i += 1) {',
    '    if (!alive(CFG.oldPid)) break',
    '    await sleep(1000)',
    '  }',
    '  for (let i = 0; i < 30; i += 1) {',
    '    if (!(await portBusy(CFG.port))) break',
    '    await sleep(1000)',
    '  }',
    '  log("启动：" + CFG.command + " " + CFG.args.join(" "))',
    '  const child = spawn(CFG.command, CFG.args, {',
    '    cwd: CFG.cwd,',
    '    detached: true,',
    '    stdio: ["ignore", "ignore", "ignore"],',
    '    env: process.env,',
    '  })',
    '  child.unref()',
    '  log("已拉起新进程 pid=" + child.pid)',
    '}',
    '',
    'main().catch((error) => { log("重启失败：" + (error && error.message ? error.message : String(error))) })',
    '',
  ].join('\n')
}

/** 应用更新：装新版本 + 生成重启脚本 + 让当前进程退出。 */
async function applyUpdate(ctx, dir, name, targetVersion) {
 // UPDATE-1：私有库不发布到任何 registry。`npm install dsh-purge` 会去公网
  // registry 拉一个**同名但不同来源**的包覆盖本机私有 fork —— 这是最危险的一条。
  // 没有配置远端源时直接拒绝，连包管理器都不启动。
  if (!updateSourceRepo()) {
    return {
      ok: false,
      error: '本地版：这是私有库，不发布到 registry，也不配置远端更新源。'
        + '面板上的「更新」不可用；升级请用本地 tarball 重装'
        + `（或在设置 DSH_PURGE_UPDATE_REPO=owner/name 后重试）。`,
    }
  }
  const pm = packageManagerOf(dir)
  const spec = targetVersion ? name + '@' + targetVersion : name
  const args = pm === 'pnpm' ? ['add', spec] : ['install', spec, '--save']
  const r = await run(pm, args, { cwd: dir, timeoutMs: 300000 })
  if (r.code !== 0) {
    return { ok: false, error: '安装失败（' + pm + ' ' + args.join(' ') + '）：' + String(r.stderr || r.stdout || '').trim().slice(0, 1200) }
  }
  /* 重启：拿当前进程的启动命令原样再来一遍 */
  const argv = process.argv.slice()
  const command = argv[0]
  const rest = argv.slice(1)
  const port = (() => {
    try { return String(ctx.webServer.port) } catch { return '3080' }
  })()
  const root = (() => {
    try { return ctx.redteam.root } catch { return join(process.env.DSH_HOME || '.', 'redteam') }
  })()
  mkdirSync(root, { recursive: true })
  const logPath = join(root, 'update.log')
  const scriptPath = join(root, 'restart-dsh-web.sh')
  writeFileSync(scriptPath, restartScript(process.pid, port, command, rest, logPath, process.cwd()), { encoding: 'utf8', mode: 0o755 })
  const child = spawn(process.execPath, [scriptPath], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  /* 给浏览器留出收到响应的窗口，然后退出 —— 新进程由脚本按原命令行拉起 */
  setTimeout(() => { process.exit(0) }, 1200).unref()
  return {
    ok: true, installed: spec, packageManager: pm,
    restart: { script: scriptPath, log: logPath, port, command: [command].concat(rest).join(' '), pid: process.pid },
  }
}


/** 读取完整请求体；超过上限即中断。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg) } }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        // destroy 带 Error → socket 立即 RST,client 不会继续发,端对端收尾。
        const err = new Error('request body too large')
        done(reject, err)
        try { req.destroy(err) } catch { /* 忽略 */ }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => done(resolve, Buffer.concat(chunks).toString('utf8')))
    req.on('error', (err) => done(reject, err))
  })
}

/** 统一的 JSON 响应。 */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** 技能可用性缓存：`{ at, scope, byName: Map }`；30 秒内复用。 */
let skillAvailabilityCache = null
const SKILL_AVAILABILITY_TTL_MS = 30000

/**
 * 安全取 Cordis 服务：未 inject 时 ctx.get / 点属性都会抛，不能让它冒泡成 400。
 */
function softService(ctx, name) {
  if (!ctx) return undefined
  try {
    if (typeof ctx.get === 'function') return ctx.get(name)
  } catch { /* not injected */ }
  try {
    return ctx[name]
  } catch { /* proxy throw */ }
  return undefined
}

/**
 * 逐个技能的可用性（读正文 → 共享判定模块）。
 * @param skillsSvc - 已取得的 skills 服务（可为 null）。
 * @param list - `skills.list()` 的返回（SkillSummary[]）。
 * @param scope - 当前作用域。
 * @param force - true 时跳过快取缓存。
 */
async function skillAvailabilityOf(skillsSvc, list, scope, force) {
  const now = Date.now()
  // scope 签名加入 cache key:切预设时 scope 变,老 cache 可能对应错误的技能可用性快照。
  const scopeSig = scope == null ? '' : String(scope)
  if (!force && skillAvailabilityCache !== null
    && now - skillAvailabilityCache.at < SKILL_AVAILABILITY_TTL_MS
    && skillAvailabilityCache.size === list.length
    && skillAvailabilityCache.scope === scopeSig) {
    return { at: skillAvailabilityCache.at, cached: true, byName: skillAvailabilityCache.byName }
  }
  const rootsWith = new Map()
  for (const x of list) {
    const dir = x.resourceBase && x.resourceBase.kind === 'directory' ? x.resourceBase.path : null
    if (dir === null) continue
    if (!rootsWith.has(x.name)) rootsWith.set(x.name, [])
    if (!rootsWith.get(x.name).includes(dir)) rootsWith.get(x.name).push(dir)
  }
  const byName = new Map()
  for (const summary of list) {
    let def
    try {
      def = skillsSvc && typeof skillsSvc.get === 'function'
        ? await skillsSvc.get(summary.name, { scope })
        : undefined
    } catch { def = undefined }
    const path = def && typeof def.path === 'string'
      ? def.path
      : (summary.resourceBase && summary.resourceBase.kind === 'directory' ? summary.resourceBase.path : null)
    const root = summary.resourceBase && summary.resourceBase.kind === 'directory' ? summary.resourceBase.path : null
    const verdict = checkSkill({ name: summary.name, content: def && def.content, path, root },
      { env: mergeConfigEnv(process.env, loadPlatformConfig(redteamRoot())), sameNameIn: rootsWith.get(summary.name) || [] })
    byName.set(summary.name, verdict)
  }
  skillAvailabilityCache = { at: now, scope: scope == null ? '' : String(scope), size: list.length, byName }
  return { at: now, cached: false, byName }
}

/**
 * 技能目录：桌面端默认读本包 `skills/redteam/*.md`；
 * 仅当 skills + agentPresets 都可用时才走原生注册表。
 */
async function handleSkillOp(ctx, request) {
  if (request.op !== 'skillCatalog' && request.op !== 'skillRead') return undefined

  /* 桌面端绝不能让 "without inject" 冒泡：一律 softService + 文件兜底。 */
  const skillsSvc = softService(ctx, 'skills')
  const presetsSvc = softService(ctx, 'agentPresets')

  let scope = null
  let registryReady = false
  if (skillsSvc && typeof skillsSvc.list === 'function' && presetsSvc) {
    const standing = presetsSvc.standingKeyFor
    if (typeof standing === 'function') {
      try {
        scope = await standing.call(presetsSvc, 'redteam')
        registryReady = scope != null
      } catch {
        registryReady = false
      }
    }
  }

  if (!registryReady) {
    return withBothLibraries(handleSkillOpFromPluginDir(request))
  }

  if (request.op === 'skillCatalog') {
    let list = []
    try {
      list = await skillsSvc.list({ scope })
    } catch {
      list = []
    }
    if (!Array.isArray(list) || list.length === 0) {
      return withBothLibraries(handleSkillOpFromPluginDir(request))
    }
    const redteamList = list.filter((s) => skillLibraryOf(s) !== 'official')
    const availability = await skillAvailabilityOf(skillsSvc, redteamList, scope, request.refresh === true)
    const pluginDir = resolvePluginSkillsDir()
    const bySource = new Map()
    const byDir = new Map()
    const items = list.map((s) => {
      const dir = s.resourceBase && s.resourceBase.kind === 'directory' ? s.resourceBase.path : null
      const name = dir === null ? '(非文件系统来源)' : dir
      byDir.set(name, (byDir.get(name) || 0) + 1)
      bySource.set(s.source, (bySource.get(s.source) || 0) + 1)
      const library = skillLibraryOf(s) === 'official' ? 'official' : 'redteam'
      const avail = availability.byName.get(s.name)
      return {
        name: s.name,
        description: s.description,
        whenToUse: s.whenToUse || '',
        provider: s.provider,
        source: s.source,
        dir: dir,
        modelInvocable: s.invocation ? s.invocation.modelInvocable !== false : true,
        userInvocable: s.invocation ? s.invocation.userInvocable !== false : true,
        fromPlugin: sameDir(dir, pluginDir),
        library,
        availability: library === 'official' ? 'listed' : (avail ? avail.status : 'unknown'),
        problems: library === 'official' ? [] : (avail ? avail.problems : ['未检查']),
        needs_user: library === 'official' ? [] : (avail ? avail.needs_user : []),
      }
    })
    const availSummary = summarizeSkills(Array.from(availability.byName.values()))
    // 目录读数走契约：总条数与「本包技能数」只在这里算一次，另一条兜底路径同源。
    const skillsView = contract.skillsBlock({ dir: pluginDir || '', source: 'host', items })
    return withBothLibraries({
      ok: true,
      total: skillsView.total,
      fromPlugin: skillsView.fromPlugin,
      availability: {
        summary: availSummary,
        checked_at: availability.at,
        cached: availability.cached,
        broken: Array.from(availability.byName.values()).filter((x) => x.status === 'broken')
          .map((x) => ({ name: x.name, problems: x.problems, needs_user: x.needs_user })),
        note: '可用性 = 技能文件存在且正文能加载。缺工具、缺密钥、VPS 占位符记在缺口里，不把整条技能标成不可用。',
      },
      bySource: Array.from(bySource, ([k, n]) => ({ key: k, n })).sort((a, b) => b.n - a.n),
      byDir: Array.from(byDir, ([k, n]) => ({ key: k, n })).sort((a, b) => b.n - a.n),
      note: '红队技能和官方技能分开。红队技能才做工具路径检查；官方技能在 $DSH_HOME/skills，由宿主按任务调用。',
      items,
    })
  }
  if (request.library === 'official') return readOfficialSkill(request.name)
  if (typeof request.name !== 'string' || request.name.length === 0) {
    return { ok: false, error: 'name required' }
  }
  try {
    const skill = await skillsSvc.get(request.name, { scope })
    if (skill !== undefined) {
      return {
        ok: true,
        name: skill.name,
        description: skill.description,
        whenToUse: skill.whenToUse || '',
        provider: skill.provider,
        source: skill.source,
        path: skill.path || null,
        content: skill.content || '',
      }
    }
  } catch { /* fall through */ }
  return handleSkillOpFromPluginDir(request)
}

/**
 * 宿主 skills 服务不可用时的兜底：目录取自共享枚举，可用性按现场逐条自检。
 *
 * 枚举不再是「本包 skills/redteam 里有哪些 .md」——那是第三份目录清单（设置页一份、
 * preset 一份、这里一份），三份可以不一样而且没有任何症状。现在只从
 * `skillCatalogOfHome()` 拿条目，本函数补的只有「这份技能在这台机器上能不能用」。
 */
function handleSkillOpFromPluginDir(request) {
  const catalogView = skillCatalogOfHome()
  const dir = (catalogView.roots[1] && catalogView.roots[1].dir) || PLUGIN_SKILLS_DIR || ''
  if (catalogView.items.length === 0) {
    return { ok: false, error: '技能目录里一个技能都没有（$DSH_HOME/skills 与随包副本都读不到），且宿主 skills 服务不可用' }
  }
  /* 环境变量：进程 + 平台 config.json（空字段不覆盖） */
  const cfg = loadPlatformConfig(redteamRoot())
  const checkEnv = mergeConfigEnv(process.env, cfg)

  if (request.op === 'skillCatalog') {
    const byName = new Map()
    const items = catalogView.items.map((item) => {
      let content = ''
      try {
        content = readFileSync(item.path, 'utf8')
      } catch { /* ignore */ }
      const verdict = checkSkill(
        { name: item.name, content, path: item.path, root: item.dir },
        { env: checkEnv },
      )
      byName.set(item.name, verdict)
      return Object.assign({}, item, {
        availability: verdict.status,
        problems: verdict.problems,
        needs_user: verdict.needs_user,
      })
    })
    const availSummary = summarizeSkills(Array.from(byName.values()))
    const skillsView = contract.skillsBlock({ dir, source: 'plugin', items })
    return withBothLibraries({
      ok: true,
      total: skillsView.total,
      fromPlugin: skillsView.fromPlugin,
      availability: {
        summary: availSummary,
        checked_at: Date.now(),
        cached: false,
        broken: Array.from(byName.values()).filter((x) => x.status === 'broken')
          .map((x) => ({ name: x.name, problems: x.problems, needs_user: x.needs_user })),
        note: '按技能文件自检（含环境适配 config.json）。工具路径、密钥和 VPS 占位符只记在缺口里，不把整条技能标成不可用。',
      },
      bySource: Array.from(
        items.reduce((acc, item) => acc.set(item.source, (acc.get(item.source) || 0) + 1), new Map()),
        ([key, n]) => ({ key, n }),
      ),
      byDir: [{ key: dir, n: items.length }],
      note: '技能目录共 ' + items.length + ' 个（$DSH_HOME/skills 与随包副本同名取先出现者）；可用性已按正文与本机配置检查。',
      items,
    })
  }
  if (request.library === 'official') return readOfficialSkill(request.name)
  if (typeof request.name !== 'string' || request.name.length === 0) {
    return { ok: false, error: 'name required' }
  }
  const wanted = request.name.replace(/\.md$/i, '')
  const found = catalogView.items.find((item) => item.name === wanted)
  if (!found) return { ok: false, error: 'skill not found: ' + request.name }
  let content = ''
  try {
    content = readFileSync(found.path, 'utf8')
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) }
  }
  return {
    ok: true,
    name: found.name,
    description: found.description,
    whenToUse: found.whenToUse,
    provider: found.provider,
    source: found.source,
    path: found.path,
    content,
  }
}

/**
 * 智能体并发状态（「智能体」页签用）：直接读 subagents 注册表里"真正在跑"的子会话。
 * 与工具层的 `redteam_agent_slot` 同一套口径，但这里只读不占位。
 * @param ctx - 插件上下文。
 * @param request - `{ op: 'agentsStatus' }`。
 * @returns JSON 结果，或 undefined 表示不是这个 op。
 */
async function handleAgentsOp(ctx, request) {
  if (request.op !== 'agentsStatus' && request.op !== 'setAgentsMax') return undefined
  const root = (() => { try { return ctx.redteam.root } catch { return undefined } })()
  if (request.op === 'setAgentsMax') {
    const next = saveMaxAgents(root, request.max)
    return {
      ok: true, max: next, source: 'settings', limit: MAX_AGENTS_LIMIT,
      note: '已保存为 ' + next + ' 个并发执行智能体，**立即生效**（派活时按新值放行，不用重启 dsh web）。',
    }
  }
  const max = maxAgentsOf(root, process.env)
  const subagents = ctx.get('subagents')
  const sessions = ctx.get('sessions')
  if (subagents === undefined || subagents === null || sessions === undefined || sessions === null || typeof sessions.list !== 'function') {
    return { ok: false, error: 'subagents / sessions 注册表不可用：读不到并发占用。', max }
  }
  const children = []
  try {
    const roots = sessions.list().filter((s) => {
      const header = s && s.header
      return header && (header.parentSession === undefined || header.parentSession === null)
    })
    for (const root of roots) {
      try {
        const kids = await subagents.listChildren(root.id)
        for (const k of Array.isArray(kids) ? kids : []) {
          if (k && k.kind === 'child') children.push({ parent: String(root.id), label: k.label || String(k.id), activity: k.activity, mode: k.mode })
        }
      } catch { /* 单个会话读不到就跳过 */ }
    }
  } catch (error) {
    return { ok: false, error: '列子会话失败：' + (error && error.message ? error.message : String(error)), max }
  }
  const running = children.filter((c) => c.activity === 'running')
  return {
    ok: true, max, used: running.length, free: Math.max(max - running.length, 0),
    running: running.slice(0, 20), total_children: children.length,
    source: maxAgentsSourceOf(root, process.env),
    limit: MAX_AGENTS_LIMIT,
    default_max: DEFAULT_MAX_AGENTS,
    note: '同一会话（靶标）同时最多 ' + max + ' 个执行智能体；默认顺序派活。',
  }
}

/**
 * 版本与更新类 op（面板右上角的「版本 + 自动更新」用）。
 * 不碰资产库，直接操作 profile 与 npm/pnpm；全部在 host 侧执行。
 * @param ctx - 插件上下文。
 * @param request - `{ op: 'version' | 'updateCheck' | 'updateApply', target? }`。
 * @returns JSON 结果，或 undefined 表示不是更新类 op。
 */
async function handleUpdateOp(ctx, request) {
  if (!['version', 'updateCheck', 'updateApply'].includes(request.op)) return undefined
  const pkg = pluginIdentity(ctx)
  const pre = await updatePreflight(ctx)
  if (request.op === 'version') {
    const check = pre.devLinked ? null : await checkLatest(ctx, pre.dir, pkg.name)
    return {
      ok: true,
      plugin: pkg,
      install: {
        mode: pre.devLinked ? 'dev' : 'package',
        dir: pre.dir,
        declared: pre.declared,
        packageManager: pre.packageManager,
      },
      latest: check && check.ok ? check.latest : null,
      updateAvailable: check && check.ok && pkg.version ? versionLess(pkg.version, check.latest) : false,
      /* 本地版本比 registry 还新：本机跑的是尚未发布的开发版本。
         不区分这一种，"检查更新"会一直显示"已是最新"，把"这个版本根本没发出去"藏起来。 */
      localAhead: check && check.ok && pkg.version ? versionLess(check.latest, pkg.version) : false,
      check_error: check && check.ok === false ? check.error : undefined,
      blockers: pre.blockers,
      notes: pre.notes,
      running_agents: pre.running,
    }
  }
  if (request.op === 'updateCheck') {
    const check = await checkLatest(ctx, pre.dir, pkg.name)
    if (check.ok !== true) return { ok: false, error: check.error, current: pkg.version, install: { mode: pre.devLinked ? 'dev' : 'package' } }
    const localAhead = pkg.version ? versionLess(check.latest, pkg.version) : false
    return {
      ok: true, current: pkg.version, latest: check.latest,
      updateAvailable: pkg.version ? versionLess(pkg.version, check.latest) : true,
      localAhead,
      install: { mode: pre.devLinked ? 'dev' : 'package', dir: pre.dir, packageManager: pre.packageManager },
      blockers: pre.blockers,
      notes: pre.notes.concat(localAhead
        ? ['本机版本（' + pkg.version + '）比 npm 上的最新版（' + check.latest + '）还新：'
           + '当前跑的是尚未发布的开发版本，包管理器更新不适用（要回退版本请显式指定）。']
        : []),
      running_agents: pre.running,
    }
  }
  /* updateApply */
  if (pre.blockers.length > 0) {
    return { ok: false, error: '现在不能更新：' + pre.blockers.join(' '), blockers: pre.blockers, notes: pre.notes }
  }
  /* target 会被原样拼进 `npm install <target>`：不校验就等于把"装任意包并重启进程"
     暴露给浏览器侧输入。只接受纯 semver（可带 v 前缀），其余一律拒绝并说清原因。 */
  const rawTarget = typeof request.target === 'string' ? request.target.trim() : ''
  if (rawTarget !== '' && !/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(rawTarget)) {
    return {
      ok: false,
      current: pkg.version,
      error: 'updateApply 的 target 必须是纯版本号（如 0.11.0），收到 ' + JSON.stringify(rawTarget)
        + '。不接受包名、路径、URL 或 npm 参数 —— 它会原样传给包管理器，等于允许远程指定安装内容。',
    }
  }
  const result = await applyUpdate(ctx, pre.dir, pkg.name, rawTarget || null)
  if (result.ok !== true) return Object.assign({ current: pkg.version }, result)
  return Object.assign({ current: pkg.version, latest: request.target || null }, result, {
    note: '已安装，正在重启当前宿主（页面会在几秒内断开，重启完成后刷新即可看到新版本）。重启日志：' + result.restart.log,
  })
}

/**
 * @param ctx - 插件上下文（已保证 redteam / webServer / skills / agentPresets 可用）。
 */
export function apply(ctx) {
  const store = ctx.redteam

  /* 红队会话发送后的硬兜底：环境未就绪则 reject 首步，避免直接开干 */
  try {
    if (!ctx.__dshpEnvAdaptPreStep) {
      ctx.__dshpEnvAdaptPreStep = true
      const root = store && store.root ? store.root : redteamRoot()
      const hook = async (payload, next) => {
        try {
          const agent = payload && payload.agent
          const header = agent && agent.session && agent.session.header
          const preset = header && header.agentPreset
          if (preset === 'redteam') {
            const turn = Number(payload && payload.turn) || 0
            const step = Number(payload && payload.step) || 0
            if (turn <= 1 && step <= 1) {
              const status = envAdaptStatus(root)
              if (!status.ready) {
                return {
                  kind: 'reject',
                  reason: status.message
                    || '环境未适配：请打开 dsh-purge → 环境适配配置工具，或确认暂不配置后再发送。',
                  messages: [],
                }
              }
            }
          }
        } catch { /* 门禁异常不阻断 */ }
        return next()
      }
      // ctx.effect 包起来 → plugin dispose 时自动解绑 hook,avoids 事件处理器残留触发已卸载代码。
      // installed flag 防重复注册(cordis 允许同一 handler 重复注册,会多次触发)。
      ctx.effect(() => {
        let installed = false
        let disposer = null
        const install = () => {
          if (installed) return
          try {
            disposer = ctx.on('agent/pre-step', hook, { global: true, prepend: true })
            installed = true
          } catch { /* ignore */ }
        }
        install()
        queueMicrotask(install)
        const timer = setTimeout(install, 800)
        return () => {
          clearTimeout(timer)
          try { if (typeof disposer === 'function') disposer() } catch { /* ignore */ }
          delete ctx.__dshpEnvAdaptPreStep
        }
      })
    }
  } catch { /* ignore */ }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/redteam/api',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' })
        return
      }
      /* 来源校验：本机回环一律放行（官方桌面端 Origin 常是 app:// / file://，
         旧逻辑会把 Origin.host 判空后直接 403，导致技能库/知识库/SQL 全挂）。
         非回环才要求 Origin 与 Host 同源。 */
      const remote = req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : ''
      const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
      const host = typeof req.headers.host === 'string' ? req.headers.host : ''
      const hostLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)
      const origin = req.headers.origin
      const originOk = (() => {
        if (loopback) return true
        /* 官方桌面端：Origin 常为 app:// / null，Host 仍是 127.0.0.1:port */
        if (hostLocal) {
          if (origin === undefined || origin === '' || origin === 'null') return true
          if (typeof origin === 'string' && /^app:/i.test(origin)) return true
          try {
            const oh = new URL(origin).host
            if (oh === host || oh === '' ) return true
          } catch { /* fall through */ }
        }
        if (typeof origin !== 'string' || origin === '') return false
        let originHost = null
        try { originHost = new URL(origin).host } catch { originHost = null }
        return originHost !== null && originHost === host
      })()
      if (!originOk) {
        sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
        return
      }
      try {
        const raw = await readBody(req)
        const request = raw.trim() ? JSON.parse(raw) : {}
        /* 只读 op 的回包在出门之前过一遍契约判据：字段集与声明不符就换成结构化失败。
           没有这一道，「收编到契约」只是文档里的一句话 —— 加字段仍然只要改调用点。 */
        const guardReadonly = (op, payload) => {
          if (!payload || typeof payload !== 'object') return payload
          if (!contract.READONLY_OPS[String(op || '')]) return payload
          const report = contract.redteamOpReport(op, payload)
          if (report.undeclared.length === 0) return payload
          return {
            ok: false,
            error: `只读 op ${op} 的回包与契约不符：未登记 [${report.undeclared.join(',')}]`
              + '（先在 lib/state/contract.js 的 READONLY_OPS / STATE_BLOCKS 登记）',
          }
        }
        const platformResult = handlePlatformOp(store, request)
        if (platformResult !== undefined) {
          sendJson(res, 200, guardReadonly(request.op, platformResult))
          return
        }
        const agentsResult = await handleAgentsOp(ctx, request)
        if (agentsResult !== undefined) {
          sendJson(res, 200, agentsResult)
          return
        }
        const updateResult = await handleUpdateOp(ctx, request)
        if (updateResult !== undefined) {
          sendJson(res, 200, updateResult)
          return
        }
        let skillResult
        try {
          skillResult = await handleSkillOp(ctx, request)
        } catch (skillErr) {
          /* 桌面端 inject 缺失时绝不 400：直接文件兜底 */
          if (request && (request.op === 'skillCatalog' || request.op === 'skillRead')) {
            skillResult = handleSkillOpFromPluginDir(request)
            if (!skillResult || skillResult.ok === false) {
              skillResult = {
                ok: false,
                error: '技能读取失败：' + (skillErr && skillErr.message ? skillErr.message : String(skillErr)),
              }
            }
          } else {
            throw skillErr
          }
        }
        const dispatched = skillResult === undefined ? await dispatchAsync(store, request) : skillResult
        sendJson(res, 200, guardReadonly(request.op, dispatched))
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error && error.message ? error.message : String(error) })
      }
    },
  }))
}
