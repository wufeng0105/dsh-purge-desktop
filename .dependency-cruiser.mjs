/**
 * dsh-purge 依赖规则（模块边界约束的可执行载体）
 *
 * 首日状态已在本机实测（dependency-cruiser 18.7.0 / Node v24.20.0）：
 *   72 modules / 221 dependencies / 0 error。
 *
 * 设计原则：**首日全绿**。任何会立刻红的规则先设 warn 并登记豁免，
 * 由阶段门禁决定何时升 error。理由（WORKFLOW-1）：没有全绿基线就没有
 * 「行为没变」的判据；规则首日就红，下一步一定是被 `|| true` 绕过，等于没写。
 */

export default {
  forbidden: [
 // ── CONTRACT-5：client.js 是生成物，lib/ 不许 import 它 ────────────────────────
    {
      name: "client-is-generated",
      comment:
        "client.js 由 scripts/build-client.mjs 从 lib/client-src/ 单向装配，是浏览器 bundle。" +
        "lib/ 直接 import 它会拿到 window.__ModuleLoader__ 未定义的运行时错误。",
      severity: "error",
      from: { path: "^lib/" },
      to: { path: "^client\\.js$" },
    },

 // ── ARCH-2：lib/redteam 不许回引 lib/core.js（传递级）──────────────────
    {
      name: "redteam-no-core",
      comment:
        "redteam 的 17 个文件当前 0 处**直接** import lib/core.js。" +
        "core.js 已 3,190 行，redteam 回引会让它的扇入继续涨；" +
        "而 redteam 必须能单独加载（cordis.patch.yml 按 name 加载）。" +
        "注意：只拦直连是不够的 —— 传递链绕过见下一条 redteam-no-core-transitive。",
      severity: "error",
      from: { path: "^lib/redteam/" },
      to: { path: "^lib/core\\.js$" },
    },

 // ── ARCH-2 收紧成传递依赖检查 ──────────────────────────────────
    {
      name: "redteam-no-core-transitive",
      comment:
        "上一条只拦直连，实际被两条传递链绕过，规则形同虚设：" +
        "  redteam/role-section.js → ../identity.js → ./core.js" +
        "  redteam/index.js → ../preset-default.js → ./core.js" +
        "把 identity.js / preset-default.js 的 findDshHome 改成从 host/paths.js 取，" +
        "两条链已断，所以这条规则现在能开成 error。",
      severity: "error",
      from: { path: "^lib/redteam/" },
      to: { path: "^lib/core\\.js$", reachable: true },
    },

 // ── ARCH-2 补充：redteam 不许经由 host/ 绕回 core.js ─────────────────────────
    {
      name: "host-layer-must-not-import-core",
      comment:
        "为什么需要这条：redteam → host/paths 是**允许**的（依赖方向规则：redteam/ → host/ hostfs/），" +
        "所以上一条的 to 里不能再写 host/paths —— 方案 §5.4 的原始规则文本写了 " +
        "`^lib/(core|host/paths)\\.js$`，但 §5.4 自己给的解法就是「改成从 host/paths.js import」。" +
        "两条并存则规则恒红、必然被 `|| true` 绕过（WORKFLOW-1 的老问题）。" +
        "真正要守的是「redteam 不许摸到 core」—— 那就锁 core。" +
        "至于「有人让 host/paths 回引 core 来绕路」：core.js 本来就 import host/paths.js，" +
        "反向一条边立刻构成环，no-circular 会先红。这条规则把那个意图写明白，不是重复。" +
        "今后 redteam 需要新的宿主能力，加在 host/ 或 hostfs/，别去 core.js 拿。",
      severity: "error",
      from: { path: "^lib/host/" },
      to: { path: "^lib/core\\.js$" },
    },

    // ── 日志模块只记事实，不认识插件内部结构 ──────────────────────────────
    //
    // 为什么锁这一条：审计日志若 import core 或 desktop，它就会随宿主状态的每一次
    // 重构一起漂移 —— 而日志的价值恰恰在于「事后照着它还能复现当时凭什么下的结论」。
    // 它需要的一切（dshHome、每行的 file / marker / status）都由调用方以参数交给它。
    {
      name: "audit-must-not-import-core",
      comment:
        "日志模块只落事实，不读宿主状态：dshHome 由调用方传入，落点与 marker 由调用方折好。" +
        "回引 core 会把「记录」变成「再算一遍」，两份判定早晚对不上，而日志是判据不是副本。",
      severity: "error",
      from: { path: "^lib/audit/" },
      to: { path: "^lib/(core|desktop)\\.js$" },
    },

 // ── ARCH-1：环依赖（已破环，现为 error）──────────────────────────────
    {
      name: "no-circular",
      comment:
 "已破环：原子写抽到 lib/atomic-fs.js，desktop.js 不再回引 core.js。" +
        "此前两条环（core→desktop→core、core→hide-console→desktop→core）已消失。" +
        "现在任何新环都是回归，直接 error。",
      severity: "error",
      from: {},
      to: { circular: true },
    },

  // ── ARCH-6 / 片段不许变成模块 ─────────────────────────────────────────────
    {
      name: "client-src-has-no-imports",
      comment:
        "lib/client-src/** 是被 build-client 按整行占位符拼进 client.js 的**文本**，不是 ESM 模块。" +
        "一旦出现 import，说明有人把它当模块用了 —— 而装配后的产物里没有任何 loader 能解析它，" +
        "失败方式是运行时 ReferenceError（CONTRACT-5 的执行层判据要等到产物才看得见）。" +
        "片段需要的东西由装配期注入（shell.js 的闭包里已有 h / useState 等）。",
      severity: "error",
      from: { path: "^lib/client-src/" },
      to: { path: ".+", dependencyTypes: ["import", "export", "dynamic-import"] },
    },

  // ── 脚本与运行期分离 ──────────────────────────────────────────────────
    {
      name: "scripts-must-not-import-lib",
      comment:
        "脚本是仓库侧的一次性动作（生成、门禁、探针），运行期代码是随包交付的那部分。" +
        "脚本一旦 import lib，两边的生命周期就绑在一起：想改脚本就得先保证 lib 能加载（要宿主、要 dshHome）。" +
        "要数据就读文件，要行为就起子进程。" +
        "**过渡豁免的七个**是存量：它们要的是 lib 的函数而不是数据（measure 还要 Map 与 displayTitleOf），" +
        "改成子进程等于把一个函数调用拆成序列化往返，且 measure 的量法本轮冻结。" +
        "豁免只对存量文件生效：新增脚本一律不许进这张名单。",
      severity: "error",
      from: {
        path: "^scripts/",
        pathNot: [
          "^scripts/measure\\.mjs$",
          "^scripts/probe-host-patches\\.mjs$",
          "^scripts/check-clean-host-sim\\.mjs$",
          "^scripts/check-ui-tree\\.mjs$",
          "^scripts/audit-smoke\\.mjs$",
          "^scripts/export-engagement-report\\.mjs$",
          "^scripts/embed-default-prompt\\.mjs$",
        ],
      },
      to: { path: "^lib/" },
    },

    {
      name: "lib-must-not-import-scripts-or-test",
      comment:
        "依赖单向：lib/ 是交付物，scripts/ 与 test/ 是围绕它的工具。" +
        "反过来引用的后果是运行期需要仓库结构（脚本不在包里、测试更不在），" +
        "而且 npm 包装出来之后这条边会直接断掉 —— 只在开发机上能跑。",
      severity: "error",
      from: { path: "^lib/" },
      to: { path: "^(scripts|test)/" },
    },

    {
      name: "nested-layers-must-not-import-entry",
      comment:
        "lib/index.js 是 CORDIS 插件入口（registerPromptSections / apply / default export）。" +
        "audit / host / patch 三层回引它就会把「入口装配」变成它们加载的前提：" +
        "审计要能在没有插件实例的情况下落账，路径层要能被 CLI 单独调用。" +
        "需要什么从具体的兄弟模块取，别从入口取 —— 入口会随宿主生命周期变。",
      severity: "error",
      from: { path: "^lib/(audit|host|patch)/" },
      to: { path: "^lib/index\\.js$" },
    },

    {
      name: "no-catch-all-filenames",
      comment:
        "这类文件名不说明职责，谁都能往里塞，于是「一个文件一件事」在第一次赶工时就被推翻。" +
        "依赖图能看见的是「谁 import 了它」；文件是否存在的判据在 scripts/check-layout.mjs 的禁用名表里。" +
        "两条一起守：这张网拦引用，那张网拦存在。",
      severity: "error",
      from: {},
      to: { path: "^lib/(utils|helpers|common|shared|misc)\\.js$" },
    },

    // ── A 轴：web 适配器已删除，回引即回退（A2 完成，现为 error）──────────
    {
      name: "no-web-surface-after-purge",
      comment:
 "已删除 lib/web.js / lib/restart-web.js / lib/uninstall-restart.js。" +
        "任何回引都是回退。这三个文件不存在了，所以这条规则现在恒绿 —— " +
        "它的作用是拦住『有人为了修某个 bug 又把 web 适配器加回来』。" +
 "注意：删的是 dsh web CLI 宿主面，不是 Web UI 层（client.js / webServer 仍在用，见 SURFACE-4）。",
      severity: "error",
      from: {},
      to: { path: "^lib/(web|restart-web|uninstall-restart)\\.js$" },
    },

 // ── ARCH-2：孤儿模块检测不在此处（2026-10-24 拍板退役 no-orphans 规则）────────
 // 孤儿（无 import 者且非入口的文件）由 knip 的 files 规则独家承担（npm run dead）：
 // knip 的 entry/ignore 清单覆盖了原 no-orphans 的全部豁免对象（redteam 按 name
 // 加载的四入口、子进程按路径执行的三个文件、client-src 文本装配片段），
 // 两套工具重复维护同一张豁免表只会漂移。
  ],

  options: {
    doNotFollow: { path: "(^|/)node_modules/" },
    // client.js 是浏览器 bundle，不是 Node 模块，cruise 它只会得到噪声。
    exclude: {
      path: "(^|/)(node_modules|\\.codegraph|\\.git)/|^client\\.js$",
    },
    combinedDependencies: false,
    tsPreCompilationDeps: false,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
  },
};
