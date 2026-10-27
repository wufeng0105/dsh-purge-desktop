/**
 * CONTRACT-5：产物求值的共享桩。
 *
 * ## 为什么要有这个文件
 *
 * `client.js` 是**求值型**产物：`node --check` 只能证明它语法合法，
 * 证明不了它能加载。v1.0.1 → v1.1.0 三个 tag 的产物语法全绿，可一进闭包
 * 顶层就 `ReferenceError: drillGrantGen is not defined`（占位符替换把声明整段卷走了），
 * 整个插件面板打不开。要抓这类病，唯一办法是真的在最小 VM 里把
 * `__ModuleLoader__.load({factory})` 传进来的那个 factory **执行一次**。
 *
 * 这段逻辑原先只长在 `test/client-evaluates.test.mjs` 里。回滚点验证
 * （`scripts/verify-rollback-point.mjs <rev>`：解包某个 tag → 三项矩阵）
 * 必须在**任意路径**的 `client.js`（解包出来的临时副本）上跑同一套桩 ——
 * 所以抽到这里共享，两条路径不许各写一份（各写一份就会漂移，漂移就会让
 * 「回滚点健康」这个结论失去可比性）。
 *
 * ## 被 `node --test` 加载是正常的
 *
 * `node --test`（无参数）会递归执行 `test/` 下的每个 .js/.mjs 文件，本文件
 * 也在内。因此本文件**模块顶层不许有副作用**（不读 client.js、不建临时目录），
 * 一切都得在函数里。加载成功 = 一次空跑，没有测试用例。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 仓库根（`test/helpers/` 往上两级）。 */
export const REPO_ROOT = resolve(HERE, "..", "..");

/** 工作区里那份产物。回滚点验证会传解包出来的临时副本覆盖它。 */
export const DEFAULT_CLIENT = join(REPO_ROOT, "client.js");

/** 最小 react 桩：只要 factory 能求值，不需要真的渲染。 */
export const REACT_STUB = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: "Fragment",
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: () => ({ current: null }),
  Component: function Component() {},
};

/** factory 求值时的模块解析器：react 给桩，其余模块给空对象。 */
export function resolveModuleStub(name) {
  return name === "react" ? REACT_STUB : {};
}

/**
 * 最小浏览器环境。刻意**不提供** `fetch`：drill grant 的同步请求会在 `.catch()`
 * 里被吃掉，正好顺路验证「接口挂掉时插件仍能加载」（授权窗靠内联的
 * `AUTH_LEGAL_HTML`，不靠请求）。回滚点验证里这条同样重要 —— 老 tag 的产物
 * 不该因为「没有后端」而被判成坏。
 */
export function makeSandbox() {
  const documentStub = {
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ setAttribute() {}, remove() {}, className: "" }),
    head: { append() {} },
    body: {},
    addEventListener() {},
    removeEventListener() {},
  };
  const windowStub = {
    location: { origin: "http://127.0.0.1", href: "http://127.0.0.1/", port: "", hostname: "127.0.0.1" },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    alert: () => {},
    open: () => {},
    document: documentStub,
    navigator: { userAgent: "node" },
  };
  windowStub.window = windowStub;
  const sandbox = {
    window: windowStub,
    document: documentStub,
    navigator: { userAgent: "node" },
    fetch: () => Promise.reject(new Error("test sandbox: no fetch")),
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    console,
  };
  sandbox.globalThis = sandbox;
  return sandbox;
}

/**
 * 在 VM 里跑 `clientPath`，把 `window.__ModuleLoader__.load()` 收到的 factory 交回来
 * （**不**调用它 —— 调用是 `evaluateFactory` 的事，这样测试能分开验两步）。
 *
 * 拿不到 factory 直接抛错：那说明产物连模块装配那一步都没走到。
 */
export function loadFactory(clientPath = DEFAULT_CLIENT) {
  const source = readFileSync(clientPath, "utf8");
  const sandbox = makeSandbox();
  let factory = null;
  sandbox.window.__ModuleLoader__ = {
    load: ({ factory: received }) => {
      factory = received;
    },
  };
  vm.runInContext(source, vm.createContext(sandbox), { filename: clientPath });
  if (typeof factory !== "function") {
    throw new Error(`${clientPath}: window.__ModuleLoader__.load 没拿到 factory（产物装配断了）`);
  }
  return factory;
}

/**
 * 走完整条链：加载 → 真的调用一次 factory → 返回它的 exports。
 *
 * factory 闭包的顶层求值（含 `syncDrillGrant();`）有任何未声明的自由变量都会在这里
 * 抛 `ReferenceError` —— 这正是 v1.0.1 → v1.1.0 三个 tag 的病，也是回滚点矩阵里
 * 「factory」那一行的判据。
 */
export function evaluateFactory(clientPath = DEFAULT_CLIENT) {
  return loadFactory(clientPath)(resolveModuleStub);
}
