/**
lib/client-src/design/layout.js — 布局层：页面壳、行栅格、页签、工具栏、危险区、断点

## 为什么单独一份

页面骨架与组件原语原先交错在同一份样式串里，读的时候分不清「这块是壳的宽度」
还是「这块是按钮的高度」。布局单独成篇之后，改列宽、改断点、改主区的座位覆盖都在
一份文件里完成，视觉不会因为一次无关的按钮改动而跟着漂。

## 收录口径

页面与浮层的容器、行与网格、页签与工具栏、分节与折叠、危险区、容器断点，
以及只对某个座位生效的位置覆盖。控件自身的呈现归原语层；字号、间距这类刻度
从令牌层读，不在本文写第二份。

本文件是三层里最后装配的一段：同选择器的覆盖关系靠这里的先后顺序成立。
 */

		const PURGE_CSS_LAYOUT = `/* 页面根自成层叠上下文：页内层级（吸顶页头 / 页签、页内模态、缩放手柄）只在本页内
   互比，不与宿主页面同台；根自己不带数字，它跟着所在座位走。 */
.dshp-root{max-width:920px;display:flex;flex-direction:column;gap:18px;padding:16px;border-radius:12px;background:var(--dshp-bg);color:var(--dshp-ink);font-family:var(--dshp-sans);color-scheme:light;isolation:isolate}
.dshp-toolbar{display:flex;align-items:center;justify-content:flex-end;gap:8px}
.dshp-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;flex-wrap:wrap}
.dshp-row+.dshp-row{margin-top:10px}
.dshp-ask{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px;padding:10px 12px;border:1px solid var(--dshp-line);border-radius:8px;background:var(--dshp-bg);font-size:13px}
.dshp-active{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 12px;margin-bottom:12px;border:1px solid var(--dshp-line);background:var(--dshp-bg);border-radius:8px}
.dshp-active b{font-family:var(--dshp-display);font-weight:500}
.dshp-split{display:flex;flex-direction:column;gap:12px}
.dshp-policy-row{display:flex;align-items:center;gap:10px}
.dshp-policy-row>label{font-size:12px;color:var(--dshp-mute);flex:0 0 auto}
.dshp-cwd-sub{margin-top:3px;font-family:var(--dshp-mono);font-size:11px;color:var(--dshp-mute);word-break:break-all}
@media (prefers-reduced-motion:reduce){.dshp-btn{transition:none}.dshp-skel{animation:none}}

/* ── 设置页设计系统 ──────────────────────────────────────────────────────
   依据宿主自己的设置面板：内容区宽约 560px，宿主用「发丝线分隔的行」而不是卡片，
   行标签 13px/500、说明 12px 三级色、动作在标题行右侧、空态左对齐内联。
   这一组 class 是整页唯一的排版语言；任何分节都不许自带容器、圆角或阴影。 */
.dshp-page{display:flex;flex-direction:column;gap:28px;width:100%;min-width:0;color:var(--dsw-alias-label-primary,var(--dshp-c-text));font-size:13px;line-height:1.5;isolation:isolate}

/* 页签面板的容器：页签内容不是页面根，所以它借不到 .dshp-page 那套「整页自成层叠上下文」
   的语义（那一条会凭空给每块面板建一层隔离，面板里又没有需要层内比先后的东西）。
   它只回答两件事 —— 面板自己的一圈纵向内边距，以及内容列的上限；字号与颜色从页面壳继承，
   不再写第二份。上限 760px 是设置内容区的口径，宽屏时居中、窄屏时铺满。
   宽度落在本层的自定义属性上：这个量只对面板成立，不进全局令牌层。
   纵向节奏与内边距改走刻度：分组间距取 sp-6（设置内容区的口径就是 760 列 + sp-6），
   内边距取 sp-4。面板容器写在这里时用的是 28px 与 16px —— 28px 是那两族刻度还关在
   演练台两棵根里、设置页取不到时的临时值，提到 :root 之后按刻度归位，分节间距因此
   从 28px 变成 32px。页面壳自己的 gap 仍是 28px，两者相差 4px 属于同一处待归位的取值。 */
.dshp-panel-body{--dshp-content-max:760px;display:flex;flex-direction:column;gap:var(--dshp-sp-6);width:100%;max-width:var(--dshp-content-max);min-width:0;margin:0 auto;padding:var(--dshp-sp-4) 0;box-sizing:border-box}

/* 页头：产品名 + 版本 + 状态 + 右侧动作，一行读完。 */
.dshp-page__head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0}
.dshp-page__id{display:flex;align-items:baseline;gap:8px;min-width:0}
.dshp-product{margin:0;font-size:18px;font-weight:600;line-height:1.4;letter-spacing:-.01em;color:var(--dsw-alias-label-primary,var(--dshp-c-text))}
.dshp-page__status{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,var(--dshp-c-text-muted))}

/* 摘要：一行一项。四项并排的卡片在 560px 里必然折行，且与下方补丁表重复。 */
.dshp-summary{display:flex;flex-direction:column}
.dshp-summary>.dshp-row:first-child{padding-top:0}

/* 行：左标签、右取值，行间发丝线。整页唯一的「键值」形态。 */
.dshp-row{display:flex;flex-wrap:wrap;align-items:baseline;gap:16px;min-width:0;padding:8px 0;border-bottom:.5px solid var(--dsw-alias-border-l2,var(--dshp-c-border))}
.dshp-row:last-child{border-bottom:0}
.dshp-row__label{flex:0 0 auto;min-width:76px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,var(--dshp-c-text-muted))}
.dshp-row__value{flex:1 1 auto;min-width:0;font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-primary,var(--dshp-c-text));word-break:break-word;font-variant-numeric:tabular-nums}

/* 分节：标题行（标题 + 计数 + 右侧动作）、可选说明、内容。全页唯一的分节形态。 */
.dshp-section{display:flex;flex-direction:column;min-width:0}
.dshp-section__head{display:flex;align-items:center;gap:8px;min-height:32px}
.dshp-section__title{margin:0;font-size:13px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-primary,var(--dshp-c-text))}
.dshp-section__count{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary,var(--dshp-c-text-muted));font-variant-numeric:tabular-nums}
.dshp-section__gap{flex:1 1 auto}
.dshp-section__hint{margin:2px 0 8px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary,var(--dshp-c-text-muted))}


/* 展开行：补丁分节的「一层一行」。 */
.dshp-disc__head{display:flex;align-items:center;gap:8px;width:100%;min-height:40px;padding:8px 0;border:0;border-bottom:.5px solid var(--dsw-alias-border-l2,var(--dshp-c-border));background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dshp-disc__head:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dshp-accent));outline-offset:-2px;border-radius:var(--dsw-radius-sm,6px)}
.dshp-disc__title{flex:0 0 auto;font-size:13px;font-weight:500;line-height:1.5}
.dshp-disc__meta{flex:0 0 auto;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary,var(--dshp-c-text-muted));font-variant-numeric:tabular-nums}
.dshp-disc__gap{flex:1 1 auto}
.dshp-disc__chev{flex:0 0 auto;color:var(--dsw-alias-label-tertiary,var(--dshp-c-text-muted));transition:transform .15s ease}
.dshp-disc__chev.is-open{transform:rotate(180deg)}
.dshp-disc__body{display:flex;flex-direction:column;padding:2px 0 10px 16px;border-bottom:.5px solid var(--dsw-alias-border-l2,var(--dshp-c-border))}
.dshp-disc__item{display:flex;align-items:baseline;gap:8px;padding:5px 0;font-size:12.5px;line-height:1.5;min-width:0;flex-wrap:wrap}
.dshp-disc__item-name{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-primary,var(--dshp-c-text))}
.dshp-disc__item-note{flex:1 1 100%;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary,var(--dshp-c-text-muted))}

/* 列表：并列条目（技能目录）。条目是一行，点开就地展开编辑器。 */
.dshp-list{display:flex;flex-direction:column}
.dshp-list__item{border-bottom:.5px solid var(--dsw-alias-border-l2,var(--dshp-c-border))}
.dshp-list__item:last-child{border-bottom:0}
.dshp-list__head{display:flex;align-items:baseline;gap:12px;width:100%;min-height:40px;padding:8px 0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer;flex-wrap:wrap}
.dshp-list__head:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dshp-accent));outline-offset:-2px;border-radius:var(--dsw-radius-sm,6px)}
.dshp-list__name{flex:0 0 auto;font-size:13px;font-weight:500}
.dshp-list__meta{flex:1 1 auto;min-width:0;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary,var(--dshp-c-text-muted));word-break:break-word}
.dshp-list__ops{flex:0 0 auto;display:flex;align-items:center;gap:12px}
.dshp-list__editor{display:flex;flex-direction:column;gap:8px;padding:2px 0 12px}


/* 动作条：右对齐，与分节标题的动作同侧。 */
.dshp-actions{text-align:right;white-space:nowrap;display:flex;align-items:center;gap:8px;flex-wrap:wrap}

/* 页脚：两个可点项 + 目录路径。 */
.dshp-page__foot{display:flex;flex-direction:column;gap:6px;padding-top:14px;border-top:.5px solid var(--dsw-alias-border-l2,var(--dshp-c-border))}
.dshp-foot__links{display:flex;align-items:center;gap:16px;flex-wrap:wrap}

/* 危险区：与上方内容隔开，但不另造容器。 */
.dshp-section--danger{padding-top:8px;border-top:.5px solid var(--dsw-alias-border-l2,var(--dshp-c-border))}

@media (prefers-reduced-motion:reduce){.dshp-disc__chev{transition:none}.dshp-skel{animation:none}}

/* ── 演练台主区（侧栏图标 → 宿主 main 座位）──────────────────────────────
   方案 B：整页自然滚动，**整页只有一个滚动条**。
   主区没有浮窗祖先：那批内嵌布局覆盖选择器全挂在 .dshp-dock-body 下面（那个祖先零引用，
   覆盖层从未生效，已随零引用类名清理整块删掉）—— 主区更够不到它们，于是
   rt-dock.rt-embedded 的 height:100% 对 auto 高的父级等于 auto、rt-main 的 overflow:hidden
   把超出部分剪掉、rt-pane 的 overflow:auto 永远轮不到滚动 —— 真机症状就是「没有布局、
   也不能下滑、底部编辑器被切断」。
   这一组只对主区生效（dshp-root--main），不借用浮窗语义：浮窗是浮起来的卡片，主区是
   占满座位的一页，高度来源与滚动容器都不是一件事。内层一律不出滚动条，否则会出现
   「页面一个滚、内容一个滚」。标签栏跟着滚走是方案的已知代价，不做 sticky。 */
.dshp-root--main{height:100%;overflow:auto;box-sizing:border-box;padding:16px 20px;display:block;max-width:none;border-radius:0;background:transparent}
/* 比 rt-dock.rt-embedded（0,2,0）高一档：那份规则在演练台自己的 style 里、排在后面，
   打平会按顺序输给它，height:100% 又回到 auto。 */
/* 主区不是浮窗：基础规则里的 position:fixed + top/right + z-index 必须在主区被显式重置，
   否则它就是一个贴视口右上、按内容撑宽的固定层 —— 不参与页面流（没布局）、溢出（不能滚）、盖住宿主 UI。 */
.dshp-root.dshp-root--main>.rt-dock{position:relative;inset:auto;z-index:auto;height:auto;min-height:0;flex:none;width:100%;display:flex;flex-direction:column}
.dshp-root--main .rt-body{min-height:0;flex:none;display:flex;flex-direction:column;overflow:visible;max-width:1100px;width:100%;margin:0 auto}
.dshp-root--main .rt-main{min-height:0;overflow:visible}
.dshp-root--main .rt-pane{min-height:0;overflow:visible;padding:14px 16px}
.dshp-root--main .rt-table,.dshp-root--main .rt-chain{flex:none;max-height:none;overflow:visible}

/* ── 演练台设计语言（主区与「全面浏览」共用）──────────────────────────
   四档字号 + 六档间距 + 一个强调色。数字一律等宽（tabular-nums），密集列走等宽栈；
   颜色只取宿主语义 token，本层不新增任何字面色（check-style-tokens 扫的就是这一点）。
   强调色（brand primary）只给三处：主操作、当前页签、焦点环；其余全是中性层次。 */
/* 页头：标题 + 靶标选择 + 右侧动作。三段（页头 / 标签 / 内容）共用同一条左边缘 ——
   内边距只在最外层给一次，内层一律 0，否则「标签栏比内容右缩 12px」这种错位没人说得清。 */
/* 页头 / 标签栏 / 内容三段共用一条 1100 列：谁都不单独贴边，错位就没有来源。 */
.dshp-root--main .rt-head,.rt-full .rt-head{padding:0 0 var(--dshp-sp-3);gap:var(--dshp-sp-3);border-bottom:0;flex-wrap:wrap;max-width:1100px;width:100%;margin:0 auto}
.dshp-root--main .rt-title,.rt-full .rt-title{font-size:var(--dshp-fs-page);font-weight:600;letter-spacing:-.01em;line-height:1.3}
.dshp-root--main .rt-tabs,.rt-full .rt-tabs{padding:0;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l2);flex-wrap:wrap;max-width:1100px;width:100%;margin:0 auto}
.dshp-root--main .rt-tab,.rt-full .rt-tab{font-size:var(--dshp-fs-body);padding:var(--dshp-sp-2) 10px 9px;border-radius:0;background:transparent;border-bottom:2px solid transparent;color:var(--dsw-alias-label-secondary)}
/* 焦点环用强调色 2px：浏览器默认那圈方框在深色标签栏上像故障 */
.dshp-root--main .rt-tab:focus-visible,.rt-full .rt-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,var(--dshp-accent));outline-offset:-2px;border-radius:4px}
.dshp-root--main .rt-tab.on,.rt-full .rt-tab.on{color:var(--dsw-alias-label-primary);font-weight:600;border-bottom-color:var(--dsw-alias-brand-primary,var(--dshp-accent))}
.dshp-root--main .rt-body,.rt-full .rt-body{padding-top:var(--dshp-sp-4)}
/* 统计行：分组、数字大标签小、等宽数字。原来是一长串「C 段 0 资产 0（存活 0）端口 0」挤成一行。 */
.rt-stats{display:flex;flex-wrap:wrap;gap:var(--dshp-sp-6);padding:var(--dshp-sp-4) 0 0;border-top:1px solid var(--dsw-alias-border-l2)}
.rt-stat-group{display:flex;flex-wrap:wrap;gap:var(--dshp-sp-5)}
.rt-stat{display:flex;flex-direction:column;gap:2px;min-width:64px}
.rt-stat__num{font-size:20px;font-weight:600;line-height:1.15;font-variant-numeric:tabular-nums;font-family:var(--dshp-mono)}
.rt-stat__label{font-size:var(--dshp-fs-meta);color:var(--dsw-alias-label-tertiary);white-space:nowrap}
/* 页头与标签栏吸在视口顶：方案 B 整页滚动下唯一的吸面。
   表格头**不吸** —— 再叠一层就会三层互压；要固定表头得把表格自身限高内滚（改回方案 A），留到确有需要的批再评估。 */
.dshp-root--main{--rt-head-h:56px}
.dshp-root--main .rt-head{position:sticky;top:0;z-index:var(--dshp-z-head);background:var(--dsw-alias-bg-layer-1)}
.dshp-root--main .rt-tabs{position:sticky;top:var(--rt-head-h);z-index:var(--dshp-z-tabs);background:var(--dsw-alias-bg-layer-1)}
/* 说明与内容页（WP19）：section 层级、规则列表、角色网格、字段与状态行、三档徽章。
   区块之间 20px，标题 15 / 说明 12 / 正文 13.5 —— 与 WP17 的四档字号同一套刻度。 */
.rt-section--stack{display:flex;flex-direction:column;gap:var(--dshp-sp-3);padding:var(--dshp-sp-6) 0;border-top:1px solid var(--dsw-alias-border-l2)}
.rt-section--stack:first-child{border-top:0;padding-top:0}
.rt-section__title{margin:0;font-size:16px;font-weight:600;line-height:1.4;letter-spacing:-.005em}
.rt-section__hint{margin:0;font-size:var(--dshp-fs-meta);line-height:1.7;color:var(--dsw-alias-label-tertiary);max-width:70ch}
/* 硬约束用列表：一行一条，行首一个小标记 */
.rt-rule{display:flex;flex-direction:column;gap:var(--dshp-sp-2);margin:0;padding:0;list-style:none}
.rt-rule__item{position:relative;padding-left:16px;font-size:var(--dshp-fs-body);line-height:1.7;color:var(--dsw-alias-label-secondary)}
.rt-rule__item::before{content:"";position:absolute;left:4px;top:.65em;width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-brand-primary)}
/* 六个角色：两列网格，窄屏一列 */
.rt-roles{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:var(--dshp-sp-2) var(--dshp-sp-5);max-width:960px}
.rt-roles__item{font-size:var(--dshp-fs-body);line-height:1.7;color:var(--dsw-alias-label-secondary);min-width:0}
/* 设置页的页签横条与摘要行：原先是 page.js 里的内联 token 样式（为了不越界写在片段里）。
   收编到这里 —— 设置页与演练台共用同一份 PURGE_CSS，同一视觉规则只留一处定义。
   横条只剩「横条」与「条内一组」两条：页内锚点导航删掉之后，它承载的是页签按钮，
   按钮自身的形状在 components.js，这里不再有标题与链接的样式。 */
.dshp-nav{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 10px;padding:8px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dshp-nav__items{display:flex;flex-wrap:wrap;gap:4px 8px}
.dshp-summary__counts{display:flex;flex-wrap:wrap;gap:4px 16px;padding:8px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dshp-count__label{font-size:12px;color:var(--dsw-alias-text-secondary)}
.dshp-count__value{font-size:15px;font-weight:600;margin-left:6px;font-variant-numeric:tabular-nums}
/* 统计行跟正文同一条左边缘：页脚与 .rt-body 是兄弟节点，不跟着它的 1100 约束就会贴视口最左。 */
.rt-foot{max-width:1100px;width:100%;margin:0 auto}
/* ── 流程页（WP28）──────────────────────────────────────────────────
   时间线：左侧一条 1px 竖线 + 每个节点一个小圆点，节点间距 12px。
   定义列表：term / description 两列，窄屏一行；长文限宽 68ch。
   报告阅读面：68ch、行高 1.65、代码块等宽浅底。 */
.rt-timeline{position:relative;padding-left:18px;display:flex;flex-direction:column;gap:var(--dshp-sp-3)}
.rt-timeline::before{content:"";position:absolute;left:5px;top:4px;bottom:4px;width:1px;background:var(--dsw-alias-border-l2)}
.rt-timeline>*{position:relative}
.rt-timeline>*::before{content:"";position:absolute;left:-17px;top:6px;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-border-l1)}
.rt-timeline>*:first-child::before{background:var(--dsw-alias-brand-primary)}
.rt-def{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:var(--dshp-sp-1) var(--dshp-sp-3)}
.rt-def>div{display:contents}
.rt-def b,.rt-def dt{color:var(--dsw-alias-label-secondary);font-weight:600;font-size:var(--dshp-fs-meta);white-space:nowrap}
.rt-def dd,.rt-def span{min-width:0;max-width:68ch;word-break:break-word}
@media (max-width:900px){.rt-def{grid-template-columns:1fr}.rt-def b,.rt-def dt{white-space:normal}}
/* 智能体页两栏：主栏 minmax(0,2fr)（规则 / 角色）+ 辅栏 minmax(240px,1fr)（并发占用 / 数量 / 注意块）。
   整宽单列时每节等权，读起来像一张清单；分栏之后「主体 / 辅体」一眼可分。 */
.rt-cols{display:grid;grid-template-columns:minmax(0,2fr) minmax(240px,1fr);gap:var(--dshp-sp-6);align-items:start}
.rt-cols__main,.rt-cols__aside{display:flex;flex-direction:column;min-width:0}
.rt-cols__aside{position:sticky;top:var(--rt-head-h);align-self:start}
@media (max-width:900px){.rt-cols{grid-template-columns:1fr}.rt-cols__aside{position:static}}
@media (max-width:900px){.rt-roles{grid-template-columns:1fr}}
`;
