# DSH 原生插件与界面模型入门

> 一句话：DSH 宿主的插件生命周期、槽位模型、客户端加载链与样式规则的入门。

文中 `路径:行号` 均相对宿主仓库根目录，行号按核对时的那份宿主快照记；宿主演进后行号会漂移，复算时以该文件的内容为准。全篇只讲宿主一侧的机制：这些扩展面都挂在同一条可逆的生命周期轴上。

## 1 插件生命周期

DSH 的插件框架叫 Cordis，是整体 vendor 进仓库的框架层，不走 npm 依赖（vendor/README.md:3）。产品的一切部分都是插件——模型适配器、工具注册表、会话日志、agent 循环本身都是，所以没有"特权内核"可改：扩展 DSH 的方式就是往树里挂一个插件（docs/architecture.md:9-11）。

**四个核心概念**：

- **plugin（插件）**：能挂进插件树的对象。注册表按形态分三种：函数 `(ctx, config)`、类（`new (ctx, config)`，`Service` 子类落在这一类）、带 `apply(ctx, config)` 方法的对象；三种都可带 `Config`、`inject`、`provide` 等静态字段（docs/cordis-api/registry.md:60-105；docs/cordis-primer.md:9）。
- **Context（上下文）**：服务的仓库。一个服务从 context 认领一个稳定的 `ctx.<key>`（如 `ctx.tools`、`ctx.llm`、`ctx.sessions`），别的插件按 key 找服务，而不是 import 某个具体实现（docs/cordis-primer.md:10）。
- **Service（服务）**：暴露在 `ctx` 上的具名 API 的基类。子类作为插件加载时自动注册为 `ctx.<name>`，随宿主 fiber 自动移除（docs/cordis-api/service.md:6,10）。
- **Fiber**：一次加载出来的插件实例，含生命周期状态、已校验配置、注册的 effects（docs/cordis-api/fiber.md:6,52）。`ctx.fiber` 指当前 fiber，`ctx.effect()` 委托给它（docs/cordis-api/fiber.md:39-46）。

**插件怎么进入宿主**：

1. 运行中的 `dsh` 是启动时由有序层组合出来的插件树。profile（剖面）是存在 Harness home 里的具名组合，列出它堆叠的 bundle 与自装的外部插件；bundle 是"Cordis 配置行 + 这些行挂载的代码"的发行格式。两者都在各自 `package.json` 的 `dsh` 字段声明：`dsh.profile` 列 bundle，`dsh.bundle` 指向 bundle 的 patch 文件（docs/architecture.md:15-21）。
2. 层按顺序应用于空入口表：profile 的有序 bundle → profile 的 `cordis.patch.yml` → home patch → `--patch` 覆盖（docs/architecture.md:25）。
3. 外部插件经 Plugin Manager 安装：Web 侧栏的 Plugins 页、`dsh plugin` CLI、`plugin_manager` 工具共享同一套操作，`installBundle` 在 profile 目录里跑 pnpm；启用/禁用单个插件只改 profile `cordis.patch.yml` 里最后一个匹配覆盖的 `disabled`，启用/禁用 bundle 改 `package.json` 的 `dsh.profile.bundles` 有序列表。服务侧与 `dsh plugin` 共用同一份包操作实现，`plugin_manager` 工具声明自己暴露同一批操作（packages/boot/plugin-manager/README.md:31,40,98）。
4. 版本兼容在 pnpm 之前检查：`engines.dsh` 与 `peerDependencies` 不满足直接拒绝操作（packages/boot/plugin-manager/README.md:69）。桌面端由 Electron RunAsNode 进程从 resources 起私有 Desktop Host，并从 `$DSH_HOME/profiles/desktop` 加载启用的插件（.agents/notes/implemented/architecture/2026-09-08-desktop-bundled-runtime-and-external-plugins.md:19）。

**从读取到工作**：vendored 的 `@cordisjs/plugin-loader`（vendor 内名 `@deepseek-ai/cordis-plugin-loader`，vendor/README.md:20）读取配置树，逐行 import 入口，`ctx.plugin()` 创建 fiber；配置先经插件 `Config` 标准 schema 校验，校验或启动错误会让 fiber 失败（docs/cordis-api/registry.md:42-54）。声明了 `inject` 的插件在其全部所需服务可用之前不加载——加载顺序由服务需求表达，不做手工启动排序（docs/cordis-primer.md:11；docs/cordis-api/registry.md:78）。Loader 拥有一切 entry 形态的事务：entry 创建、经服务等待激活 fiber（所需服务出现前停在 PENDING）、update/refresh、teardown（.agents/notes/implemented/architecture/2026-07-23-client-plugin-loading-model.md:39）。

**卸载靠什么自动清理**：注册必须是可逆 effect。提示词段、工具 schema、适配器、监听器都经 `ctx.effect()` 或 `ctx.on()` 安装，reload 与 teardown 会按可预测的方式回退（docs/cordis-primer.md:13）。`ctx.effect()` 立即执行 effect 体，收集它产出的 disposer，在 disposer 被调用或 fiber 卸载时**逆序**执行（docs/cordis-api/fiber.md:28-35）；fiber.dispose 即"卸载插件，清理完成后 settle"（docs/cordis-api/fiber.md:102-110）。所以插件卸载时的自动清理不靠约定：每个注册天然挂在 fiber 这一根生命周期轴上，disposer 逆序回收。规则是每个注册都应有 disposer——要么从 `ctx.effect()` 返回一个，要么用自带这行为的 Cordis 帮助函数（docs/cordis-primer.md:45）。

**热重载**：YAML 开了 HMR 时配置改动即时生效（含插件启停与安装），没开则保持运行期组合到重启（packages/boot/plugin-manager/README.md:14；docs/architecture.md:27）。浏览器侧客户端插件的替换流程见"客户端加载链"一节的热替换。

## 2 槽位模型

Web 客户端的页面由独立加载的插件在运行期拼装，槽位（slot）就是拼装机制。一句话总纲：**ui-renderer 只渲染 `'root'`；一个插件用单次 `register` 调用同时占一个槽位、声明并授权自己的子槽、声明自己的 store、注入自己的业务面；组件是纯函数，props 分五份份额、各自从唯一事实来源派生**（.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md:17）。

**谁声明槽**：`'root'` 是唯一先验槽，`SlotCore` 构造时以 single/root、`owner: {}` 种下（.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md:21；packages/client/ui-slots/src/index.ts:1014-1015）。ui-renderer 的全部装配就是 `ctx.slots.renderSlot('root', {})` 这一次 ctx 级渲染调用，其余任何 key、缺渲染器、root 未注册都大声失败、无兜底（同笔记 :21）。类型侧的注册表是 `SlotMap`：包通过 `declare module` 声明合并写进 key、基数、scope、owner props（docs/subsystems/slots.md:15）。`root` 的类型与"勿在此注册"的告示在 packages/client/ui-renderer/src/client/registry.ts:28-46——root 被 ui-layout 的 AppFrame 占据，第二个注册不是并排而是遮蔽整帧。

**谁占位**：没有独立的槽定义 API。`register` 的 `children` 对象一举三得——把子槽声明为存在、授权本组件渲染它们、记录运行时派发规格（kind/scope）；槽是渲染树上的洞，其生命周期就是声明它的 entry 的生命周期（entry 销毁 → 槽消失、贡献清空）（.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md:37）。声明即占权：**声明入口独占渲染其子槽的权利**，全部在 register 时裁定，配错在加载期大声失败——向未声明的槽注册、重复声明已归别人所有的子槽、chain 注册缺 `select` 等都抛错（同笔记 :39；docs/subsystems/slots.md:17）。

**子槽怎么授权（贡献别人的槽）**：激活顺序与声明者无关的贡献者用 `ctx.slots.inject(key, callback)`——声明已在则同步执行回调，否则等声明提交后执行；塌缩时销毁其 effect，声明者再次挂载会再跑一遍；控制器属于调用者的 fiber，插件卸载会取消等待并移除活跃贡献（docs/subsystems/slots.md:21；packages/client/ui-renderer/src/client/registry.ts:194-209）。

**四种基数与三种作用域**（packages/client/ui-slots/src/index.ts:101,104；docs/subsystems/slots.md:54-60）：

| kind     | 语义                                                                                                                                                                   |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `single` | 一个格子，活跃的最低 priority 赢家渲染；是替换点不是追加列表（docs/subsystems/slots.md:54）                                                                            |
| `list`   | 格子按必填 `id` 寻址，按 `order` 再按注册序排序；普通追加应选新 `id`（docs/subsystems/slots.md:55）                                                                    |
| `keyed`  | 属主渲染时派发一个 `entryKey`，匹配的格子带着 key 专属 props 渲染（docs/subsystems/slots.md:56）                                                                       |
| `chain`  | 入口用纯函数 `select(owner)` 自荐，按 `priority` 升序第一个非 null 者当选并以返回值作为组件的 `matched` prop；全 null 落到属主 fallback（docs/subsystems/slots.md:57） |

scope：`root`（每根一个实例）、`session-maybe`（可无会话绑定地渲染）、`session`（必须有会话绑定、拿到确定的会话值）（docs/subsystems/slots.md:58-60）。

**list 与 keyed 的区别**就是控制权在哪：list 由贡献者各自带 `id`/`order` 排队，属主只管叠放（如 `settings.section`、`sidebar.panellist`）；keyed 由属主在渲染点挑选当前 `entryKey`（如布局的 `main` 槽用面板 id 派发）。

**组件 props 的五个份额**（packages/client/ui-slots/README.md:36-38；docs/subsystems/slots.md:68-75）：

| 份额         | 类型                  | 唯一事实来源                                                |
| ------------ | --------------------- | ----------------------------------------------------------- |
| runtime      | `PropsRuntime<K>`     | SlotMap 里 K 那行（owner props + 标准作用域 kit）           |
| 子渲染       | `PropsRenderSlots<S>` | register 的 `children` 键（`renderSlot`/`renderSlotChain`） |
| Factory 渲染 | `renderFactorySlot`   | 组件工厂定义（packages/client/ui-slots/README.md:32）       |
| store        | `PropsStore<H>`       | store 工厂返回类型（`useStore` + `actions`）                |
| 业务         | `InjectFace<I>`       | inject 工厂返回类型（数据 + 回调 + 保留的 `hooks` 观测源）  |

份额之外还有两样由装配派生、不算份额：声明的 locale 命名空间给出 `t`（`PropsLocale`），chain 的选举结果给出 `matched`（docs/subsystems/slots.md:74-75,98）。

标准 hooks 由装配好的适配器按 scope 供给，与谁注册的组件无关：`useSessions`/`useSessionStatus`/`useSessionRetainInfo`/`useSessionAccess`、`useWorkspaces`/`useWorkspaceAccess`、`useRemoteAccess`、`usePanelInfo` 每个 scope 都有；`sessionId`/`useSession`/`useProjection`/`useAccess`/`useConversation`/`useInput`/`inputActions` 在 session 与 session-maybe 都供给，后者拿到的值可为空；`useChat`、`useTrajectory` 只在 session（docs/subsystems/slots.md:85-98）。**组件永远拿不到 `ctx`**：父级已知的值走 renderSlot 的 owner 参数，跨 entry 共享的可变视图状态走声明的 store，服务与模型对象留在 apply 闭包里、经回调或观测源投影进来（docs/subsystems/slots.md:79）。store 引擎（zustand + immer + 可选 localStorage 持久化）是框架唯一的订阅机器，store 必须写成工厂形式防止模块级单例穿越插件重载；读走 `props.useStore`，写只走 `props.actions.*`，原始实例永远到不了组件（.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md:64-83）。inject 工厂在自己的 apply 闭包 ctx 里读服务，能力边界就是插件声明的 `inject` 拓扑（同笔记 :87）。

**卸载级联**：渲染归属记在服务里一张 `Map<key, entry>` 上，账本行、槽、贡献、渲染绑定、store 实例全死在同一根 entry 轴上；已销毁 entry 捕获的 `renderSlot` 再被调用会抛过期授权错误（.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md:97；packages/client/ui-slots/src/index.ts 的 `releaseEntry`/`releaseChildren` 级联，:1590-1620）。

**两个现成的落点**：

- 侧栏图标 → 整页面板：插件往根域 `sidebar.panellist` **list** 槽注册一个图标组件（带 `id`、可选 `order`、`label`），用**同一个 id** 在布局的根域 `main` **keyed** 槽注册面板；`ctx.layout.selectPanel(id)` 选中已注册面板，`conversation` 是保留键；选不存在的 key 会抛错且不改当前选中（packages/client/ui-sidebar/README.md:38；packages/client/ui-layout/README.md:32,57）。
- 设置页开一节（官方范本）：ui-settings 是"设置域基座"，集中声明全部 settings 槽位类型、自己不渲染界面（packages/client/ui-settings/README.md:12；packages/client/ui-settings/src/client/contract/slots.ts:14-93）。外壳 ui-settings-general 用 `ctx.slots.inject('sidebar.settings', ...)` 占住侧栏底座并在一次 register 里声明 `settings.launcher`/`settings.trigger`/`settings.header`/`settings.action`/`settings.close`/`settings.section`/`settings.onboarding` 子槽（packages/client/ui-settings-general/src/client/index.ts:179-213）；功能插件再往 `settings.section`（整页，list）、`settings.general.item`（General 区一行，list）或 `settings.plugins.tab`（插件页签）里贡献（packages/client/ui-settings/src/client/contract/slots.ts:57,66,92；packages/client/ui-settings-general/src/client/index.ts:80-90）。外壳把 ledger（`ctx.slots.entries('settings.section')` + `getVersion`/`subscribe`）投影成导航行观测源驱动渲染（packages/client/ui-settings-general/src/client/index.ts:135-152）；配置读写经 `ctx.configForms` 走 Host 设置文档（packages/client/ui-settings/README.md:34）。

## 3 客户端加载链

浏览器客户端跑的是**同一套** Cordis 插件机制，但浏览器没有 Node 模块系统，所以客户端分两层：上层是经同一个 vendored Loader 的插件治理，下层是模块粒度的依赖管理 `dsh-client-modules`（.agents/notes/implemented/architecture/2026-07-23-client-plugin-loading-model.md:11-15）。分工一句话：模块系统拥有模块身份与字节（代码怎么到达、注册、变成 exports），Loader 拥有插件生命周期（何时挂载、等什么、怎么拆）（同笔记 :35）。

**为什么产物是单文件**：插件 bundle 在 Vite 模块图之外独立构建（.agents/notes/implemented/architecture/2026-07-23-client-plugin-loading-model.md:19）；模块系统是惰性 CJS 表——执行一个 bundle 只**注册**它的工厂（entry 调 `window.__ModuleLoader__.load({ id, factory })`），首次 `require` 才物化并记忆化（同笔记 :37）。支持的产物形态是自包含的：entry 或 chunk 不能同步 require 另一个相对的 `client*.js` 输出，"纯度门"在构建期挡住，运行期那张表的兜底 throw 是它的镜像（同笔记 :37,105）。所以每个插件包产出普通 `lib/client.js` 工厂 bundle 加可选的编译器生成 chunk，声明带 Cordis `inject` 边、同步模块表 `external` 请求、可选 `immediately` 预取标记（同笔记 :29）。

**一个包怎么声明自己是客户端插件**：`package.json` 写 `dsh.client`（`platform: 'web'`、可选 `inject` 边、可选 `immediately`），并在 `exports["./client"]` 导出构建产物（docs/subsystems/client-modules.md:94）。名册不是扫出来的：哪些插件组合进一个部署是组合决定（profile 的 yml 行），node 侧只扫描树里真正挂载的行（.agents/notes/implemented/architecture/2026-07-23-client-plugin-loading-model.md:61）。

**宿主怎么把东西交给浏览器——`__DSH_BOOT__`**：`dsh-client-modules` 的 node 半边对每个活跃 Loader 行解析其 `dsh.client` 声明，组合出 `window.__DSH_BOOT__`：`{ rev, entries: [{ id, url, rev, inject?, immediately?, external? }], batches: [{ phase, url, rev, entries }] }`；entry 名即包名，url 是带修订号的组合脚本引用（.agents/notes/implemented/architecture/2026-07-23-client-plugin-loading-model.md:58；docs/subsystems/client-modules.md:70-86）。组合脚本路由形如 `/plugins/??<包a>/client.js,<包b>/client.js&rev=<rev>`，宿主按图序分组、贪心填到 URL 上限（.agents/notes/implemented/architecture/2026-07-23-client-plugin-loading-model.md:43；docs/subsystems/client-modules.md:102）。

**端到端三阶段**（.agents/notes/implemented/architecture/2026-07-23-client-plugin-loading-model.md:53-71）：

1. **宿主组图**：组合应用（apps/cli）把名册作为普通行写进 `cordis.yml` 配置树，node 半边扫描组图（同笔记 :57-59）。
2. **模块面（第一阶段）**：注入的 HTML 以队列模式装 `window.__ModuleLoader__`，预载全部 application 组合 URL，parser 阻塞地执行 bootstrap 组合 URL，赋值 `window.__DSH_BOOT__`，然后启动 Vite 主模块；内核调 facade 的 `create()` 构造模块系统，并行预取所有 `immediately` 行（同笔记 :63；docs/subsystems/web-client.md:24）。
3. **插件面（第二阶段）**：内核先挂 vendored Loader 并把模块系统作为 `internal` 注入，再统一创建每个图行；Cordis 服务注入决定激活，模块图顺序只决定同步 import 能否物化；`settled` = 全部 entry 创建 + `loader.await()` 静止 + 全 ACTIVE 扫描（扫描会列出每个 import 失败、FAILED 或 PENDING 的 fiber 及其缺失服务）；随后 `ctx.uiRenderer.mount(container)` 把无框架加载页换成真实 UI（同笔记 :65-71；docs/subsystems/web-client.md:26）。

**为什么片段里不能写 import 互相取值**：第一代客户端加载器给"跨插件 import"留过模块表后门，那套后门复制了 Cordis 的服务机制、还把加载顺序变成正确性约束，已被整体废除（.agents/notes/implemented/architecture/2026-07-23-client-plugin-loading-model.md:23）。现行规则：特性插件包之间只许 `import type` 共享声明，不许运行时 import 或再导出别的特性插件的值；跨包行为走注入的 Cordis 服务，跨包 UI 走 Slots（docs/subsystems/web-client.md:91；docs/subsystems/slots.md:195）。

**桌面端（本插件的兼容目标）**：Electron 起 Desktop Host，窗口立刻加载打包好的 Web 资产、等 boot 注入就绪后在同一文档里激活客户端插件；Web 侧拥有 RPC 与流，Node IPC 载运 boot 注入、就绪、致命错误与关停（docs/architecture.md:53）。

**热替换**（浏览器侧，同一队列串行）：`invalidate` 丢旧工厂 → `prefetch` 装新脚本注册新工厂 → `registry.delete` → 排干旧 fiber 的 disposer → 移除自己拥有的 `<style data-plugin>` 标签 → 物化新 exports 并 `entry.refresh()` → `fiber.await()` 重抛错误（.agents/notes/implemented/architecture/2026-07-23-client-plugin-loading-model.md:85-93）。重载不保留被替换插件内的 React 状态（同笔记 :97）。

## 4 服务与配置

**插件之间怎么协作**：按 key 找服务，不 import 实现（docs/cordis-primer.md:10）。行为归属有讲究：工具管线事件归 `ctx.tools`、模型流式归 `ctx.llm`、活体协调归 `ctx.agents`；拦截与策略优先用事件，直接能力调用优先用服务方法（docs/cordis-primer.md:43）。事件有五种派发模式且模式是事件公共契约的一部分：`emit`（观察无返回）、`waterfall`（环绕中间件，`next()` 委托、不调即短路）、`parallel`（并行观察）、`serial`（顺序有返回）、`bail`（首个 bail 即停）（docs/cordis-primer.md:19-25,29-35）。

**宿主把什么定义成"能力"**：一个 seam（接缝）是可替换的能力，含三个角色——声明接口的 Service Definition、实现它的 Service Provider、使用它的 Consumer（常是模型可见的工具）；加能力意味着三个角色都设计（docs/architecture.md:132）。全量能力目录（每个 `ctx.*` 的角色、属主、实现、直接消费者）见 docs/capability-seams.md:612-713 的表格。接缝的威力：文件系统与子进程 provider 共享一个执行世界，把它们指到远程沙箱，Bash、PTY、LSP 就一起搬走（docs/architecture.md:134）。

**声明服务依赖的两种写法**：

1. 插件静态字段 `inject`（`Plugin.Base.inject`）：数组形式不带 intercept 配置，对象形式把服务名映射到可选 intercept 配置；"插件所需的服务，全部可用时才加载"（docs/cordis-api/registry.md:77-78；docs/cordis-api/registry.md:123-137）。
2. 运行期 `ctx.inject(deps, callback)`：`ctx.plugin({ inject, apply: callback })` 的简写，回调在所需服务可用时运行一次；**所需服务变化时回调被卸载并重跑**（docs/cordis-api/registry.md:8-26）。

**依赖不可用时插件处于什么状态**：不加载——fiber 停在 PENDING 等服务出现（docs/cordis-api/registry.md:78；.agents/notes/implemented/architecture/2026-07-23-client-plugin-loading-model.md:39,68 "rows that require that service remain PENDING until then"）。启动审计会把带缺失服务的 PENDING fiber 连同缺失服务名列出来（同笔记 :70）。

**提供一个服务用哪个字段**：`provide?: string | string[]`（由 `Service` 和 loader 读取）（docs/cordis-api/registry.md:79-80）；`Service` 子类作为插件加载则自动注册为 `ctx.<name>`（docs/cordis-api/service.md:10）。

**配置怎么校验**：插件在 `Plugin.Base.Config` 上声明标准 schema（宿主用 vendored Schemastery 表达，vendor/README.md:18），`ctx.plugin()` 的 args 在启动前对它校验（docs/cordis-api/registry.md:42,75-76）；校验失败抛 `ValidationError`，按 schema issues 聚合消息（docs/cordis-api/fiber.md:357-375）。改配置走 `fiber.update(config)`：先校验、再过 `internal/update` waterfall（update 钩子与 HMR 可否决或改写重启）、然后重启插件（docs/cordis-api/fiber.md:248-267）。Loader 层另有两处表达式插值：entry 的 `config` 在声明注入激活后按该插件 ctx 插值，`disabled` 在每次挂载决策时按 loader ctx 插值（docs/cordis-primer.md:39）。浏览器侧的设置编辑：浏览器用序列化的 Config schema 校验草稿，Host 校验完整配置（含无法序列化的检查）（packages/client/ui-settings/README.md:48）；设置读写经 ui-settings 的共享镜像与 `ctx.configForms`（每 entry 一份读队列、原子多字段 `mutate`、带 revision 的冲突保护）（packages/client/ui-settings/README.md:34）。

## 5 主题与样式

**所有权**：`ui-theme` 包拥有 `--dsw-*` 静态色阶、语义别名、字体排印、动效、渐变、阴影、滚动条样式与明暗偏好；`ui-layout` 把解析出的主题快照应用到文档；特性包消费语义别名，**不得另造一套全局主题**（docs/web-styling.md:9）。当前 token 值都在 `packages/client/ui-theme/src/styles/`，文档不重复抄（docs/web-styling.md:5）。

**能用什么**：

- 颜色：用 `--dsw-alias-*` 语义 token；不许复制静态色板值、不许写字面色（docs/web-styling.md:18）。明暗覆盖归主题属主，特性组件 CSS 里不出现主题选择器（docs/web-styling.md:19）。
- 排印与字号：字号配行高，已有角色匹配时用主题字体变量（docs/web-styling.md:20）；正文/代码/终端字号由 `--dsh-content-font-size` 等变量驱动，主题呈现器把它们以行内变量写到 body（packages/client/ui-layout/README.md:47）。
- 圆角：遵循统一圆角标准（docs/ui-radius.md），全圆角须与 `corner-shape: round` 配对（docs/web-styling.md:24,35）。
- 间距与浮层：浮起表面（菜单、弹层、模态、面板）`border: 0` 加 `--dsw-elevation-*` 阴影，禁止中性边框与 elevation 阴影混用（docs/web-styling.md:25）；菜单必须用 `Menu`/`MenuSurface`，不得覆盖其材质 token（docs/web-styling.md:26）。
- 手段：CSS Modules + `clsx`，不引入组件库或 Tailwind（docs/web-styling.md:17）；优先复用 ui-primitives 的控件，刻意的视觉差异走该控件的 prop 而不是再抄一份（docs/web-styling.md:16）。

**为什么不能自造一套**：token 表是唯一色彩权威，设计系统里没有的值是**故意不追加**的——取最近语义 token；确需新增的，须经设计属主批准，以"静态色阶一步 + 语义别名"同变更落地（packages/client/ui-theme/README.md:132）。改共享 token 的正确路径是改 ui-theme 的样式表、再让特性包消费其语义别名（docs/web-styling.md:39）。留给插件的两条合规出口：组件可以定义**局部**自定义属性，前提是该值属于自己组件的布局/呈现契约，共享的颜色、字体、浮层、动效仍归主题包（docs/web-styling.md:11）；组合层可用 `ctx.theme` 注册第三方主题 id、以别名 token 覆盖折进当前快照，但只是进程内扩展、不过内置设置 schema，也没有覆盖集完整性校验（packages/client/ui-theme/README.md:42,131）。

## 6 上手自检

写给读者的快速对照，答案全部出自上文引过的出处：

1. **侧栏加一个图标的最小步骤**：包在 `package.json` 声明 `dsh.client` 并导出 `exports["./client"]`（docs/subsystems/client-modules.md:94）→ 插件 `inject = ['slots']` → `ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id, order, label }, Icon))`（packages/client/ui-sidebar/README.md:38，槽在 ui-sidebar 包）→ 用同一 `id` 向 ui-layout 的 `main` keyed 槽注册面板（packages/client/ui-layout/README.md:32）。
2. **图标点开的整页注册在哪、靠什么关联**：整页在 ui-layout 的根域 `main` keyed 槽（AppFrame 声明）；与图标靠**同一个 id** 关联，`ctx.layout.selectPanel(id)` 切换，`conversation` 为保留键；图标行自读 `usePanelInfo` 显示选中态（packages/client/ui-layout/README.md:32；packages/client/ui-sidebar/README.md:38）。
3. **为什么客户端片段不能写 import**：bundle 是 Vite 图之外独立构建的自包含产物，模块表只认平台 externals 与声明的动态依赖；跨插件运行时取值会复制 Cordis 服务机制（第一代后门已废）。正确做法：跨包行为用注入的 Cordis 服务、跨包 UI 用 Slots、类型共享只许 `import type`（.agents/notes/implemented/architecture/2026-07-23-client-plugin-loading-model.md:23,37；docs/subsystems/web-client.md:91）。
4. **props 里哪份是自己的、哪份是宿主给的**：自己的是 store 份额（`useStore`/`actions`，事实来源是 store 工厂返回类型）和业务份额（inject 工厂返回的数据与回调，闭包读插件自己的 ctx）；宿主给的是 runtime 份额（owner props + `useSessions`/`useWorkspaces`/`usePanelInfo`/session scope 的 `useSession`/`sessionId` 等标准 kit）、子渲染份额（父级授权的 `renderSlot`）与 Factory 渲染份额（`renderFactorySlot`）（docs/subsystems/slots.md:68-98；packages/client/ui-slots/README.md:36-38）。组件拿不到 `ctx`（docs/subsystems/slots.md:79）。
5. **配色用什么、宿主没有的颜色怎么办**：只用 `--dsw-alias-*` 语义 token（字体字号用 `--dsh-*` 系列变量）；宿主没有的颜色取最近语义 token，确需新增由设计属主批准后在 ui-theme 以"静态步 + 语义别名"落地；插件可用的出口是组件局部自定义属性（仅限本组件呈现契约的值）与 `ctx.theme` 第三方主题覆盖（docs/web-styling.md:11,18；packages/client/ui-theme/README.md:42,132）。
