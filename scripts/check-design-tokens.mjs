#!/usr/bin/env node
/**
 * scripts/check-design-tokens.mjs — 设计层三条子判据的判定器（裸值 / 零引用类名 / 层级上限）。
 *
 * 为什么存在：样式收成令牌、原语、布局三份片段之后，还有三条约定只能靠评审守 ——
 * 「取值只从令牌来」「类名都有人用」「浮层层级不许低于宿主弹层」。存量债务今天不是零：
 * 零引用类名与裸值各有一批，所以这里不能写成一律清零，而要写成带基线的双向棘轮：
 * 命中数高于基线时红灯（新债不许进），低于基线时也红灯一次并要求把基线调到实测值
 * （基线过时，等于下一次涨回去也不红）。三个子判据：
 *
 *   一、裸值：设计片段里那批排版属性（外边距、内边距、间隙、字号、字重、行高、圆角、
 *       阴影、层级、过渡与动画时长、前景色与背景色）的取值，剥掉 var()、calc()、
 *       color-mix() 这类函数调用之后只许剩下 0 / auto / 100% / none / inherit /
 *       transparent / currentColor 这些字面量与少量 CSS 关键字；其余裸数值、裸百分数、
 *       裸色一律命中。calc() 与 minmax() 的括号内也只许出现令牌与这些字面量，
 *       「calc 里塞个裸数」不能当白名单用。1px 不在白名单里：它只能由 --dshp-border-w 表达。
 *
 *   二、零引用类名：类名全集取设计片段与拼接入口（只读 CSS 正文，注释里的类名不算定义），
 *       引用面取其余客户端片段与演练台界面片段，按子串比对。两侧都先抹掉注释再比 —— 注释里
 *       写出来的类名既不算定义、也不算被引用；只有一侧抹，一句「旧样式用 X」就能让 X 永远
 *       留在「被引用」里，死类清不掉（这就是「引用面注释里的类名被当成引用」那条盲区）。
 *       字符串前缀拼接无法静态看见后缀（运行时才拼出来），凡是某个 `--` 或 `__` 前缀在
 *       引用面里以拼接形式出现，该前缀下的所有变体都放行 —— 代价是这批变体永远查不出死类，
 *       收益是不会误删运行时样式。
 *       判「引用」的标准不是「名字有没有作为文本出现」，而是「删掉这个类定义会不会改变行为」。
 *       所以引用面上还要再抹一遍：查询类 API（closest / querySelector / querySelectorAll /
 *       matches / getElementsByClassName）实参里的字符串不算引用 —— 元素上没有这个类时，
 *       这些调用永远命中不到，删掉类定义前后都命中不到，行为不变。写入类写法（classList 的
 *       增删、className 赋值、setAttribute 写 class）会让元素真的长出这个类，继续算引用。
 *       抹的只有查询调用实参里的字符串字面量，别的一字不动；选择器先存进变量再传给查询的
 *       写法看不见（盲区在「多算引用」那一侧，只让死类清不掉，不会误删活类）。
 *
 *   三、层级：`z-index` 只许写 `var(--dshp-z-*)` 令牌，另加 `auto` 与 CSS 全局关键字；
 *       写成数字即命中，零容忍、不设基线。为什么不再比大小：页面根与每个浮层根各自
 *       `isolation:isolate` 建隔离的层叠上下文，层内 z-index 只与插件内部的值互比，大小
 *       不再有全局含义；与宿主之间只在边界那一处留一个数（`--dshp-z-boundary`）。原先
 *       「令牌取值必须大于 rewind 菜单那个魔数」防的是跨层比大小 —— 层已经不跨了，那条
 *       判据连被测物都不成立，于是换成这条：它不依赖任何魔数，新加一层写成数字就直接红。
 *       扫描面比裸值宽一档：除了设计片段，还扫 rewind 菜单所在片段（它不在 design/ 下，
 *       却是唯一直接挂到 document.body 的插件节点）。
 *
 * 当轮基线（2026-10-28 由本批执行者用 `node scripts/check-design-tokens.mjs` 实测，三处读数
 * 取自同一次输出）：零引用类名 15 个、裸值 251 处、--dshp-z-* 令牌 9 个。三个数字都由
 * 本脚本自己数出来，改基线之前先跑一遍这个命令，别按文档里的旧数字抄。
 *
 * 这些数字随 `BASELINE` 同步：改常量同时改注释，两处各说一套就没人知道哪个是真的。
 * 每一档都要说清降的是哪批事，别混成一句「删了一批」。76 / 445 那一代的两个 8 各来自一摊：
 *   · 68 与 76：四条「选择器与属性黏连」的坏规则修成合法写法后，黏出来的八个假类名
 *     （`dshp-editiongrid-template-columns`、`dshp-ruleitemflex-wrap` 这类）不再进类名全集，
 *     全集从 254 降到 246。一个类都没删。
 *   · 437 与 445：八组重复定义合并成一条时，被后写整条覆盖的前写声明删掉了，其中 8 条本身
 *     带裸值（`font-size:13px`、`padding:0 14px`、`gap:8px` 这类）。取值没改，只是不再有第二份。
 *
 * 437 → 414 是同一种降法、更大的量：把 `.dshp-area`、`.dshp-modal`、`.dshp-restart-*` 这批同病
 * 重复定义各收成一条时，删掉的 23 条前写声明全是被同名属性整条覆盖、且本身带裸值的那一批；
 * 取值一处未改，只是不再有第二份。旧侧这 23 处的逐条列举由 `.scratch/wp10-delta.mjs` 现算。
 *
 * 414 → 393 与 68 → 59 是同一批事的两头，都来自删掉那一撮「三代样式时代」的残片规则
 * （`.dshp-edition*`、`.dshp-metric*`、`.dshp-ruleitem*`、`.dshp-bar`、`.dshp-ver`）：
 * 引用面零命中、名字里没有 `--` / `__`（不是拼接前缀族）、删完每条都只剩空选择器列表，
 * 于是整条删。两个读数降的不是同样的东西：类名那头少 9 个 —— 8 个族，外加 `.is-edit`
 * 只在那条死规则里出现过，规则一删它连「零引用」都不再算（它不在类名全集里了）；
 * 裸值那头少 21 处，全是这些规则自带的裸声明（`padding:12px`、`gap:4px`、`font-weight:500`
 * 这些），取值一处未改，只是不再有那条规则。逐条来源由 `.scratch/wp12-barediff.mjs` 现算。
 *
 * 393 → 386 与 59 → 53 是同一套判定的第二批，对象是「规则列表」那一族
 * （`.dshp-rulebody`、`.dshp-rulelist`、`.dshp-rule-main`、`.dshp-rule-name`、`.dshp-rule-meta`、
 * `.dshp-rule-ops`），三条判定与第一批同口径：引用面零命中、名字里没有 `--` / `__`（不是拼接
 * 前缀族）、删完选择器列表为空。这 6 个名字的定义面出现次数全部落在被摘掉的选择器里，于是
 * 它们和前面那个 `.is-edit` 一样**整体离开类名全集**：全集 237 → 231，零引用读数掉 6 正好等于
 * 删掉的类数（第一批掉 9 而只删 8 个，差的就是这一类）。裸值少 7 处，全是被删规则自带的裸
 * 声明（`gap:8px`、`border-radius:8px`、`font-size:14px`、`line-height:1.35`、`margin-top:3px`、
 * `font-size:11px`、`gap:6px`），取值一处未改、新增 0 处；逐条来源由 `.scratch/wp13-barediff.mjs` 现算。
 *
 * 386 → 304 与 53 → 34 是第三批：`dshp-dock-*` / `dshp-cwd-*` 两族（15 个名字）加 `.dshp-title` /
 * `.dshp-sub` / `.dshp-group-h` 三族，删掉 65 条整条规则（`layout.js` 60 行、`components.js` 5 行），
 * 一处「摘列表项」都没有。这一批的判定与前两批不同：被删的 34 条规则是「死祖先 + 活后代」
 * （`.dshp-dock-body .rt-head` 这类），祖先 `.dshp-dock-body` 引用面零命中 → 整条从未生效 →
 * 整条删；活后代的**本体**定义不在这些规则里，删掉的是覆盖层而不是它们自己。三个读数降得
 * 都不一样，逐项来源由 `.scratch/wp14-delta.mjs` 现算：
 *   · 全集 231 → 189（−42）：17 个名字随规则离开全集（`.dshp-dock-body` 的定义还在 `tokens.js`
 *     里，那个文件不在本批改动范围，所以它没走、仍算一条零引用），外加 25 个只在覆盖层里
 *     出现过的名字（`.dshp-mute` 与 24 个 `rt-*` 覆写选择器 —— 后者的本体样式在演练台自己的
 *     样式串里，不在这三份设计片段）。
 *   · 零引用 53 → 34（−19）：那 17 个，加 `.dshp-mute` 与 `.rt-note` —— 后两个是**定义消失**
 *     （它们原本只活在被删的那几条规则里），不是「删了一个类」，与第一批的 `.is-edit` 同类。
 *   · 裸值 386 → 304（−82）：全是被删规则自带的裸声明（`padding:10px 12px`、`font-weight:650`、
 *     那一串 `!important` 的 `color`/`background` 也在其中），取值一处未改、新增 0 处。
 *
 * 304 → 283 与 34 → 23 是第四批：`.dshp-launch` 与设置页旧版分节的四族残片（`dshp-block*` /
 * `dshp-cr-*` / `dshp-create*` / `dshp-editor*`，10 个名字），外加 `tokens.js` 里那条挂在死作用域上的
 * 令牌覆盖 `.dshp-dock-body .dshp-root` —— 上一批因那个文件不在改动范围而留下的最后一条 `dshp-dock-body`
 * 定义。判据与第三批同一套（每一项选择器都含本批名字 → 整条从未命中）；四族残片里没有第三批那种
 * 整片覆盖层，16 条里只有三条带后代（`.dshp-block-head h4`、`.dshp-create .dshp-field`、
 * `.dshp-editor .dshp-area`），后代是活类却坐在死祖先位，规则整条从未命中。16 条规则整条删（`tokens.js` 1 行、`layout.js` 13 行、
 * `components.js` 2 行），一处摘项都没有。三个读数这一批降得整齐，逐项来源由 `.scratch/wp15-delta.mjs` 现算：
 *   · 全集 189 → 178（−11）：11 个名字的定义全部落在被删的规则里，删完整体离开全集，没有连带。
 *   · 零引用 34 → 23（−11）：就是这 11 个，没有「定义消失」的旁支 —— `dshp-dock-body` 这回一并走掉。
 *   · 裸值 304 → 283（−21）：全是被删规则自带的裸声明（`padding:10px 12px`、`gap:6px`、`font-weight:500`
 *     那一批），取值一处未改、新增 0 处。
 *
 * 283 → 261 与 23 → 17 是第五批，两件事撞在一批里，读数不是单纯「删了几个类」：
 *   · 先修上面那条盲区：引用面文件原来不抹注释，注释里提到的类名算「被引用」。补上之后
 *     浮出两个名字 —— `.dshp-cr-row`（`settings/policy-hooks.js` 的一句历史说明）与
 *     `.dshp-split`（`settings/skills.js` 的一句布局说明），零引用读数先涨到 25（这一步红过：
 *     实测 25 > 基线 23）。抹注释按字符扫、认三种字符串与转义，`"https://…"` 里的 `//`
 *     不算注释开头 —— 正则一趟抹会把后半行抹成空白，那是「活引用被判成零引用」的方向。
 *   · 再删 8 个名字 / 11 条规则：`.dshp-cr-row`（2 条，含 `.dshp-cr-row label`）、`.dshp-now` 四族
 *     （4 条）、`.dshp-live-dot`（1 条）、`.dshp-hero-chip` 一族（4 条：本体、`:hover`、`.on`），
 *     全在 `components.js`，一项选择器都含本批名字 → 每条都从未命中，整条删、没有摘项。
 *   · 全集 178 → 170（−8）：8 个名字的定义全部落在被删规则里，删完整体离开全集。
 *   · 零引用 23 → 25 → 17：−6 是「−8 个名字」加上「+2 个被注释挡住的」，两边都要说，别只看净差。
 *     留下的 17 个里 `.dshp-split` 是这一批浮出来的：改它的说明文字等于再动一处引用面，留下一批。
 *   · 裸值 283 → 261（−22）：全是被删规则自带的裸声明（`border-radius:999px`、`gap:10px`、
 *     `font-size:11px` 那一批），取值一处未改、新增 0 处，逐条由 `.scratch/wp16-delta.mjs` 现算。
 *
 * 261 → 258 与 17 → 15 是第六批：页签面板自己的容器类 + 两条随页内导航一起转死的规则。
 *   · 新增 `.dshp-panel-body`（面板内边距 + 760 内容上限，不写 isolation）：全集 169 ——
 *     两个名字离开、一个名字进来，净 −1；新容器被 `settings/page.js` 引用，不进零引用读数。
 *   · 删 `.dshp-nav__title` / `.dshp-nav__link` 两条规则：页内锚点导航删掉之后引用面零命中，
 *     名字里没有 `--` / `__`（不是拼接前缀族），两条规则的选择器列表删完为空 → 整条删；
 *     这两个名字的定义全部落在被删规则里，于是整体离开类名全集。零引用 17 → 15 正是这两个。
 *   · 裸值 261 → 258：−5 是那两条规则自带的裸声明（`font-size:12px` 两处、`font-weight:500`、
 *     `padding:1px 4px`、`border-radius:4px`），+2 是新容器的 `gap:28px` 与 `padding:16px 0`
 *     （面板的纵向节奏与内边距，与页面壳原有取值一致）；宽度上限 760px 落在面板局部的
 *     自定义属性 `--dshp-content-max` 上，不参与裸值口径。逐条来源由 `.scratch/wp19-delta.mjs` 现算。
 *
 * 258 → 256 是第七批，降的和前六批不是同一类事：这一批**没有删任何规则、没有任何类名进出**，
 * 只是把两族刻度的声明从 `.dshp-root--main,.rt-full` 那个桶提到 `:root`（十处声明逐条取值未改，
 * 只换声明位置），于是设置页的面板也看得见刻度了，`.dshp-panel-body` 的 `gap:28px` 与
 * `padding:16px 0` 换成 `var(--dshp-sp-6)` 与 `var(--dshp-sp-4) 0`。−2 正好是这两处，新增 0 处。
 * 分节间距因此由 28px 归位到 32px：28px 是刻度取不到时的临时值，而设置内容区的口径本就是
 * 760 列 + 分组间距 sp-6，这一处属于按刻度归位而不是另改一个取值。类名全集 169 与零引用 15
 * 一处未动，逐项来源由 `.scratch/wp20-equivalence.mjs` 现算。
 *
 * 256 → 251 与 169 → 168 是第八批，这一批**先改判据、后删类**，改的是「什么算引用」：
 *   · 判定标准从「名字有没有作为文本出现」换成「删掉这个类定义会不会改变行为」。查询类 API
 *     实参里的选择器只决定命中与否，元素上没有这个类时永远命中不到，删掉定义前后都一样 ——
 *     不算引用；写入类写法会让元素真的长出这个类 —— 算。落地方式就是在引用面上再抹一遍，
 *     抹的只是查询调用实参里的字符串字面量（实现见 blankQuerySelectorStrings）。
 *   · 新口径下第一个翻出来的是 `.dshp-dock`：它零渲染点（活着的浮窗是演练台自己的 `.rt-dock`），
 *     只靠 `env-gate.js` 两句 `closest` 的选择器串撑着「被引用」，于是永远清不掉。判零引用之后
 *     连同样式整块删 —— `layout.js` 三条规则，`tokens.js` 里那条只给它用的局部属性桶
 *     （`--dshp-dock-w` / `--dshp-dock-h` / 两条覆盖），以及删完规则就没消费者的 `--dshp-z-dock`。
 *   · 全集 169 → 168（−1）、零引用 15 一动不动：`dshp-dock` 的定义随规则一起消失，是**整体
 *     离开全集**，不是「多出一个死类」—— 与前几批里 `.is-edit`、`.dshp-dock-body` 那种走法同类。
 *   · 裸值 256 → 251（−5）：全是被删的三条规则自带的裸声明（`border-radius:12px`、
 *     `box-shadow:0 18px 48px`、`font-size:14px`、`line-height:1.6`、`font-weight:500`），
 *     取值一处未改、新增 0 处；`tokens.js` 那条桶里只有自定义属性，不进裸值口径。
 *   · 层级令牌 10 → 9：走掉的是 `--dshp-z-dock`，它唯一的消费点就是被删的那条规则。
 *
 * 用法：node scripts/check-design-tokens.mjs
 * 退出码：0 全过 / 1 有命中或基线不符 / 2 环境错误（扫描目标缺失）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DESIGN_DIR = "lib/client-src/design";
const CONCAT_ENTRY = "lib/client-src/dock/purge-css.js";
const REFERENCE_ROOT = "lib/client-src";
const EXTRA_REFERENCE = "lib/redteam/client.js";
/** 层级判据的附加扫描面：不在 DESIGN_DIR 下，却带着浮层根的 z-index。 */
const Z_SCAN_EXTRA = ["lib/client-src/rewind/rewind-ui.js"];
const SOURCE_EXT = /\.(js|mjs|css)$/;

const EXIT_OK = 0;
const EXIT_HIT = 1;
const EXIT_TOOLING = 2;

/**
 * 已登记存量（2026-10-27 实测）。高于它就是新债，低于它就是基线过时 —— 两头都红。
 * 修掉一批就把它降到新的实测值；两个读数必须与脚本输出逐字一致。
 */
export const BASELINE = {
  deadClasses: 15,
  bareValues: 251,
};

/** 层级判据：z-index 的取值只许是令牌（外加 auto 与 CSS 全局关键字），另有最少令牌数。 */
const Z_TOKEN_MIN = 3;
const Z_TOKEN_VALUE = /^var\(--dshp-z-[a-zA-Z0-9_-]+\)$/;
const Z_ALLOWED_VALUES = new Set(["auto", "inherit", "initial", "unset", "revert"]);
const Z_DECL_RE = /(?:^|[;{}\s])z-index\s*:\s*([^;}]+)/g;
const Z_DECL_TOKEN_RE = /--dshp-z-[a-zA-Z0-9_-]+\s*:/g;

/** 类名口径与脚本同源：点号后字母开头、至少 3 个字符，避免把 .5s、.16 这类小数当类名。 */
const CLASS_RE = /\.(-?[a-zA-Z][a-zA-Z0-9_-]{2,})/g;

/**
 * 查询类 API：只拿选择器问「命中没命中」，不往元素上写类。实参里的字符串不构成「类名被引用」，
 * 理由与边界见 blankQuerySelectorStrings 上方的注释。长名排在短名前：querySelector 是
 * querySelectorAll 的前缀，正则回溯能兜住，但先试长的少走一趟。
 */
const QUERY_SELECTOR_APIS = ["closest", "querySelectorAll", "querySelector", "matches", "getElementsByClassName"];
const QUERY_CALL_SOURCE = `\\b(?:${QUERY_SELECTOR_APIS.join("|")})\\s*\\(`;

/** 参与裸值判定的属性（进度计划列的那一批；transition / animation 是时长所在的那条简写）。 */
const VALUE_PROPS = [
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "gap", "row-gap", "column-gap",
  "font-size", "font-weight", "line-height",
  "border-radius", "box-shadow", "z-index",
  "transition", "transition-duration", "animation", "animation-duration",
  "color", "background", "background-color",
];
const DECL_RE = new RegExp(
  `(?:^|[;{}\\s])(${VALUE_PROPS.join("|")})\\s*:\\s*([^;}]+)`,
  "g",
);

/** 剥掉即可视为「取值来自令牌」的函数调用。颜色函数与十六进制刻意不在其中。 */
const TOKEN_CALLS = [
  "var", "calc", "min", "max", "minmax", "clamp", "color-mix", "env", "attr",
  "linear-gradient", "radial-gradient",
  "cubic-bezier", "translate", "translateX", "translateY", "translate3d", "rotate", "scale",
];
const CALL_RE = new RegExp(`\\b(?:${TOKEN_CALLS.join("|")})\\s*\\([^()]*\\)`, "g");
const LIMIT_CALLS = ["calc", "minmax"];

/** 剥净函数调用后，取值里允许剩下的字面量与关键字。 */
const ALLOWED_TOKENS = new Set([
  "0", "0.5px", "auto", "100%", "none", "inherit", "initial", "unset", "revert",
  "transparent", "currentcolor", "normal", "bold", "bolder", "lighter", "italic",
  "solid", "dashed", "dotted", "pointer", "default",
]);

const log = (msg) => process.stdout.write(`${msg}\n`);

/** 递归收集目录下的源码文件；目标不存在时返回空数组。 */
function listFiles(absDir, out = []) {
  if (!existsSync(absDir)) return out;
  if (statSync(absDir).isFile()) {
    if (SOURCE_EXT.test(absDir)) out.push(absDir);
    return out;
  }
  for (const name of readdirSync(absDir)) {
    const child = join(absDir, name);
    if (statSync(child).isDirectory()) listFiles(child, out);
    else if (SOURCE_EXT.test(child)) out.push(child);
  }
  return out;
}

const relPath = (abs) => relative(ROOT, abs).split(sep).join("/");

/**
 * 注释替换成等长空白：注释里的类名与取值不算定义，但字符偏移与行号保持不变，
 * 命中位置才能报出真实行号。
 */
function blankComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));
}

/**
 * JS 侧注释替换成等长空白：引用面文件里写在注释中的类名不是引用。
 * 为什么不用正则一趟抹：`"https://…"` 这类字符串里的 `//` 会被当成行注释开头，
 * 抹掉的正好是后半行 —— 那是「真引用被判成零引用」的方向，一路错到删掉还在渲染的类。
 * 所以按字符扫，认 ' " ` 三种字符串与反斜杠转义，字符串内的 `//` 原样留着。
 */
export function blankJsComments(text) {
  const chars = text.split("");
  let quote = null;
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (quote !== null) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "/" && chars[i + 1] === "*") {
      let end = i + 2;
      while (end < chars.length && !(chars[end] === "*" && chars[end + 1] === "/")) end += 1;
      const stop = Math.min(end + 2, chars.length);
      for (let k = i; k < stop; k += 1) if (chars[k] !== "\n") chars[k] = " ";
      i = stop - 1;
      continue;
    }
    if (ch === "/" && chars[i + 1] === "/") {
      while (i < chars.length && chars[i] !== "\n") {
        chars[i] = " ";
        i += 1;
      }
    }
  }
  return chars.join("");
}

/**
 * 查询类调用实参里的字符串抹成等长空白：把「名字作为文本出现」改成「写了这个类会不会改变行为」。
 *
 * 为什么这么判：`btn.closest(".dshp-dock")` 只在「祖先里有没有这个类」上分支。元素上根本没有
 * 这个类时，选择器永远命中不到 —— 删掉类定义前后都命中不到，行为不变，所以这类字符串撑不住
 * 一个零渲染点的类。反过来 `el.classList.add("dshp-dock")` 会让元素真的长出这个类，删掉定义
 * 外观就变了，那是引用。两边都不是「文本出现即引用」能分清的。
 *
 * 抹除面只有查询类 API（closest / querySelector / querySelectorAll / matches /
 * getElementsByClassName）实参里的字符串字面量，其余一律原样留着：
 *   · 写入类写法（classList 的增删、className 赋值、setAttribute 写 class）不在抹除面里；
 *   · 选择器被塞进变量再传给查询的写法（先 `const S = ".x"`、再 `closest(S)`）也不在抹除面里 ——
 *     那是这一层的盲区，方向是「多算引用」，代价是这类死类清不掉，不是误删活类。
 * 只抹字符串内容、不抹整个实参：`querySelector("." + a + b)` 里那段变量拼接仍留在文本里，
 * 免得把「别处用拼接引用了这个类」也一起抹掉。实参里的括号按深度配对，字符串里的括号不计数。
 * 注释已由 blankJsComments 先抹成空白，这里只认三种引号与反斜杠转义。
 */
export function blankQuerySelectorStrings(text) {
  const chars = text.split("");
  const callRe = new RegExp(QUERY_CALL_SOURCE, "g");
  for (const match of text.matchAll(callRe)) {
    let depth = 1;
    let i = match.index + match[0].length;
    while (i < chars.length && depth > 0) {
      const ch = chars[i];
      if (ch === '"' || ch === "'" || ch === "`") {
        let end = i + 1;
        while (end < chars.length && chars[end] !== ch) {
          if (chars[end] === "\\") end += 1;
          end += 1;
        }
        for (let k = i + 1; k < Math.min(end, chars.length); k += 1) {
          if (chars[k] !== "\n") chars[k] = " ";
        }
        i = end + 1;
        continue;
      }
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      i += 1;
    }
  }
  return chars.join("");
}

/** 字符偏移 → 行号（从 1 起）。 */
function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === "\n") line += 1;
  return line;
}

/** 剥净可视为令牌来源的函数调用，反复剥到不动点（嵌套 var 一次剥不干净）。 */
function stripTokenCalls(value) {
  let current = value;
  let previous = null;
  while (previous !== current) {
    previous = current;
    current = current.replace(CALL_RE, " ");
  }
  return current;
}

/** 取出指定函数调用的括号正文（按括号深度配对），用于检查 calc / minmax 内部）。 */
function callBodies(value, names) {
  const bodies = [];
  for (const name of names) {
    const needle = `${name}(`;
    let from = 0;
    for (;;) {
      const at = value.indexOf(needle, from);
      if (at === -1) break;
      let depth = 0;
      let end = -1;
      for (let i = at + needle.length - 1; i < value.length; i += 1) {
        if (value[i] === "(") depth += 1;
        else if (value[i] === ")") {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end === -1) break;
      bodies.push(value.slice(at + needle.length, end));
      from = end + 1;
    }
  }
  return bodies;
}

/** 一段取值剥净令牌调用与字面量之后还剩什么（空数组 = 干净）。 */
function offendingTokens(text) {
  return text
    .split(/[\s,()+\-*/]+/)
    .filter(Boolean)
    .filter((token) => !ALLOWED_TOKENS.has(token.toLowerCase()));
}

/** 单个声明的命中理由；空数组表示合规。 */
export function valueReasons(value) {
  const reasons = [];
  for (const body of callBodies(value, LIMIT_CALLS)) {
    const offenders = offendingTokens(stripTokenCalls(body));
    if (offenders.length > 0) reasons.push(`括号内出现非令牌取值 ${offenders.join(" ")}`);
  }
  const rest = offendingTokens(stripTokenCalls(value));
  if (rest.length > 0) reasons.push(`裸取值 ${rest.join(" ")}`);
  return reasons;
}

/** 一个文件里的裸值命中。注释先抹成等长空白，注释里的声明不算取值。 */
export function bareValueHits(rel, source) {
  const css = blankComments(source);
  const hits = [];
  for (const match of css.matchAll(DECL_RE)) {
    const prop = match[1];
    const value = match[2].trim();
    const reasons = valueReasons(value);
    if (reasons.length === 0) continue;
    hits.push(`${rel}:${lineAt(css, match.index)}  ${prop}: ${value}（${reasons[0]}）`);
  }
  return hits;
}

/** 类名全集（只取 CSS 正文，注释已抹）。 */
function classNames(css) {
  const names = new Set();
  for (const match of css.matchAll(CLASS_RE)) names.add(match[1]);
  return names;
}

/** 名字在 `--` / `__` 处的全部前缀（含分隔符本身），短于 6 个字符的不算拼接前缀。 */
function concatPrefixes(name) {
  const prefixes = [];
  for (let i = 0; i < name.length - 1; i += 1) {
    const pair = name.slice(i, i + 2);
    if (pair !== "--" && pair !== "__") continue;
    const prefix = name.slice(0, i + 2);
    if (prefix.length >= 6) prefixes.push(prefix);
  }
  return prefixes;
}

/** 引用面里是否出现这个名字：整名子串，或某个前缀以拼接形式出现。 */
export function isReferenced(name, body) {
  if (body.includes(name)) return true;
  for (const prefix of concatPrefixes(name)) {
    if (
      body.includes(`${prefix}\${`)
      || body.includes(`${prefix}" +`)
      || body.includes(`${prefix}' +`)
      || body.includes(`${prefix}\` +`)
      || body.includes(`${prefix}"+`)
      || body.includes(`${prefix}'+`)
    ) {
      return true;
    }
  }
  return false;
}

/** --dshp-z-* 令牌声明数：判据要有被测物，空集合上「零命中」恒真。注释里的同名声明不算。 */
export function zTokenCount(source) {
  return [...blankComments(source).matchAll(Z_DECL_TOKEN_RE)].length;
}

/** 层级判据：z-index 写成数字即命中，零容忍。注释里的声明不算。 */
export function zIndexHits(rel, source) {
  const css = blankComments(source);
  const hits = [];
  for (const match of css.matchAll(Z_DECL_RE)) {
    const value = match[1].trim();
    if (Z_ALLOWED_VALUES.has(value.toLowerCase())) continue;
    if (Z_TOKEN_VALUE.test(value)) continue;
    hits.push(
      `${rel}:${lineAt(css, match.index)}  z-index: ${value}（层内层级只许写 var(--dshp-z-*)，写成数字即命中）`,
    );
  }
  return hits;
}

/** 双向棘轮：高于基线与低于基线都算红，各自的提示不同。 */
export function ratchet(label, key, actual, baseline) {
  if (actual === baseline) return { ok: true, message: "" };
  if (actual > baseline) {
    return {
      ok: false,
      message: `${label}实测 ${actual} 处 > 基线 ${baseline}：新命中了，先修再提交（修完把 BASELINE.${key} 降到新的实测值）`,
    };
  }
  return {
    ok: false,
    message: `${label}实测 ${actual} 处 < 基线 ${baseline}：基线过时，请把 BASELINE.${key} 降到 ${actual}，`
      + "否则棘轮失效（下次涨回去也不会红）",
  };
}

/** 跑三条子判据，返回读数与命中清单。 */
export function analyze() {
  const designFiles = listFiles(join(ROOT, DESIGN_DIR));
  const entryFile = join(ROOT, CONCAT_ENTRY);
  const missing = [];
  if (designFiles.length === 0) missing.push(DESIGN_DIR);
  if (!existsSync(entryFile)) missing.push(CONCAT_ENTRY);
  if (!existsSync(join(ROOT, EXTRA_REFERENCE))) missing.push(EXTRA_REFERENCE);
  if (missing.length > 0) return { missing };

  const bareHits = [];
  const zHits = [];
  let zTokens = 0;
  const universe = new Set();
  for (const abs of designFiles) {
    const rel = relPath(abs);
    const text = blankComments(readFileSync(abs, "utf8"));
    bareHits.push(...bareValueHits(rel, text));
    zHits.push(...zIndexHits(rel, text));
    zTokens += zTokenCount(text);
    for (const name of classNames(text)) universe.add(name);
  }
  for (const name of classNames(blankComments(readFileSync(entryFile, "utf8")))) universe.add(name);

  for (const rel of Z_SCAN_EXTRA) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) {
      missing.push(rel);
      continue;
    }
    zHits.push(...zIndexHits(rel, readFileSync(abs, "utf8")));
  }

  const designAbs = new Set(designFiles.map((abs) => resolve(abs)));
  designAbs.add(resolve(entryFile));
  const referenceFiles = listFiles(join(ROOT, REFERENCE_ROOT)).filter((abs) => !designAbs.has(resolve(abs)));
  const body = [...referenceFiles, join(ROOT, EXTRA_REFERENCE)]
    .map((abs) => blankQuerySelectorStrings(blankJsComments(readFileSync(abs, "utf8"))))
    .join("\n");

  const deadHits = [...universe].filter((name) => !isReferenced(name, body)).sort();

  return {
    missing: [],
    designCount: designFiles.length,
    referenceCount: referenceFiles.length + 1,
    zScanCount: Z_SCAN_EXTRA.length,
    universeCount: universe.size,
    bareHits,
    deadHits,
    zHits,
    zTokens,
  };
}

function main() {
  const report = analyze();
  if (report.missing.length > 0) {
    log(`[check-design-tokens] 扫描目标缺失：${report.missing.join("、")}（工作目录不对或片段被挪）`);
    process.exit(EXIT_TOOLING);
  }

  const dead = ratchet("零引用类名", "deadClasses", report.deadHits.length, BASELINE.deadClasses);
  const bare = ratchet("裸值", "bareValues", report.bareHits.length, BASELINE.bareValues);

  log(`[check-design-tokens] 扫描 ${report.designCount} 个设计片段、${report.referenceCount} 个引用面文件、${report.zScanCount} 个层级附加片段`);
  log(`[check-design-tokens] 类名全集 ${report.universeCount} 个；--dshp-z-* 令牌 ${report.zTokens} 个；裸 z-index 命中 ${report.zHits.length}`);
  log(`[check-design-tokens] 基线读数：零引用类名 ${report.deadHits.length}（基线 ${BASELINE.deadClasses}）｜裸值 ${report.bareHits.length}（基线 ${BASELINE.bareValues}）`);

  const problems = [];
  if (!dead.ok) problems.push(dead.message);
  if (!bare.ok) problems.push(bare.message);
  if (report.zTokens < Z_TOKEN_MIN) {
    problems.push(
      `--dshp-z-* 令牌只有 ${report.zTokens} 个（至少 ${Z_TOKEN_MIN} 个）：层级判据没有被测物，`
      + "零命中会变成恒绿",
    );
  }
  for (const hit of report.zHits) problems.push(hit);

  if (problems.length === 0) {
    log("[check-design-tokens] OK：三项子判据与基线一致");
    process.exit(EXIT_OK);
  }

  if (report.deadHits.length > BASELINE.deadClasses) {
    log(`  ── 零引用类名 ${report.deadHits.length} 个（前 20）：`);
    for (const name of report.deadHits.slice(0, 20)) log(`    .${name}`);
  }
  if (report.bareHits.length > BASELINE.bareValues) {
    log(`  ── 裸值 ${report.bareHits.length} 处（前 40）：`);
    for (const hit of report.bareHits.slice(0, 40)) log(`    ${hit}`);
  }
  for (const problem of problems) log(`[check-design-tokens] ${problem}`);
  log("[check-design-tokens] 取值与类名的唯一出处是 lib/client-src/design/tokens.js，本门禁只判不修");
  process.exit(EXIT_HIT);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
