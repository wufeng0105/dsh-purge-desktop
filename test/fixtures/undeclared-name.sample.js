/**
 * 负向样例：产物未声明名静态门禁（CONTRACT-7）的靶子。**这个文件故意是坏的**，
 * 由 `test/artifact-names.test.mjs` 通过 `--file` 指向。
 *
 * 它复刻的是 v1.0.1-codegen → v1.1.0-semantics 三个 tag 里那份 `client.js` 的病：
 * 占位符替换把 `let drillGrantGen = 0;` 那五行圈掉了，产物语法合法
 * （`node --check` 绿）、字符串断言也过，可一进闭包顶层读它就
 * `ReferenceError: drillGrantGen is not defined` —— 整个面板打不开。
 *
 * ## 硬约束一：这里只能留「解析得过、加载得了」的坏法
 *
 * `node --test`（无参数）会**递归执行 `test/` 下的每一个 .js/.cjs/.mjs 文件**，
 * 包括 `test/fixtures/**` —— 没有 fixtures 豁免（实测：Node 24.20，放一个
 * 故意抛错的文件进 `test/fixtures/`，它会被当成一个失败的测试文件报出来）。
 *
 * 所以本文件的坏必须坏在**类型层**，不能坏在**加载期**：
 *   - ✅ 未声明名只出现在**永不被调用**的函数体里 → tsc 报 TS2304/TS2552，
 *        而 V8 加载这个模块时不执行那些函数，不会 ReferenceError。
 *   - ❌ 不能写 `let x = 1; let x = 2;`（TS2451 的形态）—— 那是 V8 的 early
 *        SyntaxError，`node --test` 一加载就整轮崩。TS2451 只由
 *        `test/artifact-names.test.mjs` 的纯解析用例覆盖，不进本文件。
 *   - ❌ 不能 `import ... from "react"` 造 TS2307 噪声 —— 解析不到包，加载即失败。
 *
 * 换句话说：**改这个文件时必须让它仍然能被 `node --test` 加载**，
 * 否则「门禁有负向用例」会变成「整个测试轮次挂掉」。
 *
 * ## 硬约束二：噪声行用来锁过滤规则
 *
 * 产物是浏览器 bundle，没装 react 类型，tsc 会喷大量预期噪声
 * （真实 `client.js`：TS2339 x103 / TS2554 x30 / TS2307 x8 / TS2322 x6 = 147 条）。
 * 脚本只拒 TS2304 / TS2552 / TS2451，其余放行。第 1 个函数给的 TS2554
 * 就是那条**确定性的噪声**：它必须出现在 `--all` 输出里、且必须不出现在默认输出里。
 */

/**
 * 噪声（必须被放行）：调用一个不收参数的函数却给了 2 个 → TS2554。
 * 包在函数里，永不调用，所以不影响加载。
 */
function artifactArityNoiseProbe() {
  function artifactTakesNothing() {
    return 0;
  }
  return artifactTakesNothing(1, 2);
}

/** 近形名候选：给 TS2552 的「Did you mean ...」用。 */
const declaredArtifactName = "ok";

/** 信号 1：完全未声明的自由变量被调用 → TS2304（与历史 defect 同形）。 */
function artifactUndeclaredCallProbe() {
  return readUndeclaredArtifactFlag();
}

/** 信号 2：拼写近似的未声明名 → TS2552，建议 declaredArtifactName。 */
function artifactNearMissProbe() {
  return declaredArtifactNam;
}

/** 信号 3：另一个未声明名被读取 → TS2552。 */
function artifactUndeclaredReadProbe() {
  return undeclaredArtifactName;
}

/** 导出一下，免得被当成「整个文件没有下游」的死文件。 */
export const artifactFixtureProbes = [
  artifactArityNoiseProbe,
  declaredArtifactName,
  artifactUndeclaredCallProbe,
  artifactNearMissProbe,
  artifactUndeclaredReadProbe,
];
