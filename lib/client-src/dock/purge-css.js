/**
lib/client-src/dock/purge-css.js — PURGE_CSS 的拼接口：令牌、原语、布局三段在这里接成一份样式。

## 为什么还留这一层

样式正文已经按职责拆到 design/ 下的三份片段，但消费方要的还是**一个字符串**：
apply() 把它塞进 document.head 的一次性样式节点，页面组件一律不再各自带 style。
留一个只有一行的拼接入口，是为了让「样式注入点只有一个」这条判据仍然读得出来 ——
没有它，三份片段就没有共同的出口，注入点会重新分散到各个组件里。

## 为什么不在这里写规则

本文件连注释带代码只做加法：三段顺序固定为令牌 → 原语 → 布局，顺序本身就是级联
关系，谁的覆盖关系靠顺序成立，谁就排在后面。任何一条 CSS 规则都不写在这里。

⚠️ 这不是 ES 模块：正文逐字节内联进 client.js。
 */

		const PURGE_CSS = PURGE_CSS_TOKENS + PURGE_CSS_COMPONENTS + PURGE_CSS_LAYOUT;
