/**
lib/client-src/design/tokens.js — 令牌层：全部 --dshp-* 声明集中在这一份片段里

## 为什么单独一份

样式拆成令牌 / 原语 / 布局三份之前，令牌、三代叠起来的组件规则、页面骨架挤在同
一份四百多行样式串里：想确认「这个颜色从哪来」要从头翻到尾，想改一处取值又怕
碰到旁边另一代规则。令牌单独成篇之后，颜色、字号行高、间距、圆角、边框、阴影、
层级、动效、控件尺寸这些数字与颜色的唯一出处只在本文出现一次。

## 边界

语义色一律取宿主主题的 --dsw-alias-* 语义别名，字面色只作为 var() 里的兜底：
明暗归主题包，本文不写主题选择器。页面根与浮层根的局部自定义属性写在这里，
是因为它们就是下游规则消费的那一层；组件与布局片段只读这些名字，不重新定义。

作用域按「谁要读」定：语义色、层级、字号与间距四族挂在 :root —— 设置页不在演练台的
两棵根里，刻度关在那两棵根上就等于设置页用不了；只有真正只对某一棵根成立的局部属性
（例如浮窗宽度）才挂在那个根上。挂 :root 的代价是可见范围变大，取值不受影响。

本文件不是 ES 模块：正文逐字节内联进 client.js，由 dock/purge-css.js 拼成 PURGE_CSS。
 */

		const PURGE_CSS_TOKENS = `/* 全文档作用域的一只桶：字号与间距刻度 + 语义色。
   刻度（四档字号、六档间距）收编前挂在 .dshp-root--main,.rt-full 那个桶里，只有演练台
   的主区与全面浏览两棵根看得到；设置页的面板不在这两棵根里，取不到刻度就只能写裸值
   （面板容器的 gap 与 padding 就是这么来的），裸值基线因此降不下去。提到 :root 之后
   全文档可见，取值一个未改 —— 可见范围是这一批唯一变化的东西。
   两类声明同在这一条 :root 里而不是各开一条：这条就是「全文档作用域」那只桶，进了它
   就全文档可见。层级令牌另起一块，只因为它们带着一段解释取值来源的长注释。 */
:root{--dshp-fs-page:20px;--dshp-fs-section:16px;--dshp-fs-body:13.5px;--dshp-fs-meta:12px;--dshp-sp-1:4px;--dshp-sp-2:8px;--dshp-sp-3:12px;--dshp-sp-4:16px;--dshp-sp-5:20px;--dshp-sp-6:32px;--dshp-c-text:var(--dsw-alias-label-primary, #1a1916);--dshp-c-text-muted:var(--dsw-alias-label-secondary, #64748b);--dshp-c-bg-page:var(--dsw-alias-bg-layer-1, #1a1a1a);--dshp-c-bg-card:var(--dsw-alias-bg-layer-2, #f4f1ea);--dshp-c-scrim:color-mix(in srgb,var(--dsw-alias-label-primary,#1a1916) 62%,transparent);--dshp-c-border:var(--dsw-alias-border-l1, #c9c3b6);--dshp-c-warn:var(--dsw-alias-state-warn-primary, #f59e0b);--dshp-c-danger:var(--dsw-alias-state-error-primary, #ef4444);--dshp-c-info:var(--dsw-alias-label-brand, #0ea5e9);--dshp-c-brand:var(--dsw-alias-brand-primary, #3f6b52);--dshp-c-accent:var(--dsw-alias-label-brand, #8b5cf6)}
.dshp-root{--dshp-sans:"Microsoft YaHei UI","PingFang SC","Noto Sans SC","Source Han Sans SC",system-ui,sans-serif;--dshp-display:var(--dshp-sans);--dshp-mono:"Cascadia Mono","JetBrains Mono",Consolas,"Courier New",monospace;--dshp-ease:cubic-bezier(.16,1,.3,1);--dshp-ok:var(--dshp-c-text-muted);--dshp-warn:var(--dshp-c-text-muted);--dshp-bad:var(--dshp-c-text-muted)}
.dshp-root{--dshp-bg:transparent;--dshp-paper:color-mix(in srgb,var(--dsw-alias-bg-layer-1,var(--dshp-c-text-muted)) 74%,transparent);--dshp-ink:var(--dsw-alias-label-primary,var(--dshp-c-text));--dshp-mute:color-mix(in srgb,var(--dsw-alias-label-primary,var(--dshp-c-text)) 74%,var(--dsw-alias-label-secondary,var(--dshp-c-text)));--dshp-line:color-mix(in srgb,var(--dsw-alias-border-l1,var(--dshp-c-text-muted)) 78%,transparent);--dshp-fill:color-mix(in srgb,var(--dsw-alias-brand-primary,var(--dshp-c-text)) 14%,transparent);--dshp-accent:var(--dsw-alias-brand-primary,var(--dshp-c-text));--dshp-accent-soft:color-mix(in srgb,var(--dsw-alias-brand-primary,var(--dshp-c-text)) 18%,transparent);--dshp-ok:var(--dshp-c-text);--dshp-warn:var(--dshp-c-text);--dshp-bad:var(--dshp-c-text)}
@keyframes dshp-pulse{0%{background-position:200% 0}100%{background-position:-200% 0}}

/* 层级令牌：数字只表达插件内部的先后，不跨层比较。
   页面根（.dshp-root / .dshp-page）与浮层根（.dshp-modal-bg / .dshp-restart-mask /
   .dshp-auth-mask / .dshp-rewind-menu）各自 isolation:isolate 建隔离的层叠
   上下文，层内 z-index 只与同一层里的其他值互比，大小不再有全局含义。
   跨到宿主那一侧的只有一个数：--dshp-z-boundary 只挂在 rewind 菜单上 —— 它是唯一直接
   portal 到 document.body 的插件节点，兄弟就是宿主 DOM。取值 2147483000 是收编前那处
   z-index 的实测值：换写法不改取值，外观才逐像素不变；它比 CSS 层级上限 2147483647 低
   647，宿主要再压一层仍有整数余量。其余八个令牌同样保留收编前的数值，理由一样。
   声明挂在 :root 而不是 .dshp-root 上：rewind 菜单在 .dshp-root 之外，拿不到那份继承。 */
:root{--dshp-z-boundary:2147483000;--dshp-z-restart:12000;--dshp-z-gate:10200;--dshp-z-auth:10100;--dshp-z-launch:10040;--dshp-z-modal:80;--dshp-z-resize:60;--dshp-z-head:3;--dshp-z-tabs:2}
`;
