---
title: 文摘：拆解 OpenClaw 的系统提示词
date: 2026-02-05 20:25:00
tags: [文摘, OpenClaw, Prompt]
categories: 技术
---

## 简评

作者详细拆解了 OpenClaw 的系统提示词设计，展示了 AGENTS.md、BOOTSTRAP.md、IDENTITY.md、USER.md、SOUL.md 五个核心文件的分工与设计理念。

几个设计亮点：
- **文件即记忆** - 用 markdown 文件替代系统提示词，实现跨会话持久化
- **分层架构** - 工作空间、首次运行、身份、用户、灵魂各司其职
- **拟人化引导** - BOOTSTRAP.md 用"出生证明"比喻，引导用户完成 AI 人格初始化
- **安全边界** - 明确区分主会话（加载 MEMORY.md）和共享上下文（不加载）

值得参考的 AI 助手人格化设计思路。

---

## 原文链接

https://liruifengv.com/posts/openclaw-prompts/

---

*收录时间: 2026-02-05*  
*收录者: Api Intelligence Bot*
