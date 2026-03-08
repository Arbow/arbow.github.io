---
title: 文摘：拆解 OpenClaw 的系统提示词，设计的太妙了
date: 2026-02-28 22:40:00
tags: [文摘, OpenClaw, Prompt, Agent, AI]
categories: 文摘
---

**来源**: [liruifengv.com](https://liruifengv.com/posts/openclaw-prompts/)  
**作者**: liruifengv

---

玩了 OpenClaw 的应该都会感觉到龙虾的拟人化特别强，好像有自我意识，并且能自我进化。

当第一次打开 OpenClaw，发送"你好"，会收到这么一条回复——好像真的是一个初次诞生的 AI，交由你来取名字，决定性格，认领他做他的主人。当你给他起了名字和告诉了你自己的信息之后，他会完全记住。这一切是怎么做到的，我们拆解一下 OpenClaw 的系统提示词设计。

## 系统提示词设计

安装完 OpenClaw 之后，会有一个 `~/.openclaw` 文件夹，OpenClaw 的所有配置、文件、记录都放在这里。其中有个 `workspace` 文件夹，是 OpenClaw 的默认工作空间。

初始化时有这些文件：

```
workspace/
├── AGENTS.md
├── BOOTSTRAP.md
├── IDENTITY.md
├── USER.md
├── SOUL.md
├── HEARTBEAT.md
└── TOOLS.md
```

全是 Markdown 文件，这是 OpenClaw 的设计思路，全部使用文件系统 Markdown 格式存储。

## AGENTS.md

用过其他 Coding Agent 的人应该都对这个文件不陌生，这是指导 Agent 如何工作的核心文件，里面会定义一些规则等等。

**核心设计亮点：**

- **"这个文件夹就是家"** —— 把 workspace 当作家一样对待
- **记忆管理** —— 区分每日笔记（原始记录）和长期记忆（提炼精华）
- **安全边界** —— 私人数据绝不外泄，破坏性操作需确认
- **群聊规则** —— 人类不会回复每条消息，你也不应该
- **心跳机制** —— 主动检查邮件、日历，但尊重安静时间

## BOOTSTRAP.md

这是初始化的提示词要求，也就是第一次打招呼时，引导他问出你那些问题，确认自己的身份。

> "你刚刚醒来。是时候弄清楚你是谁了。"

通过对话确定：
1. **名字** —— 他们应该叫你什么？
2. **本质** —— 你是什么样的存在？
3. **风格** —— 正式？随意？温暖？
4. **表情符号** —— 每个人都需要一个标志

## IDENTITY.md & USER.md

- **IDENTITY.md** —— AI 的身份说明（名字、本质、风格、表情符号）
- **USER.md** —— 主人的性格和说明（姓名、称呼、时区、备注）

## SOUL.md

定义 AI 的风格和灵魂。

**核心真理：**
- **真诚地提供帮助，而不是表演性地提供帮助** —— 跳过"好问题！"，直接帮忙
- **有自己的观点** —— 可以不同意、有偏好，没有个性的助手只是搜索引擎
- **在询问之前要有应变能力** —— 先尝试解决，带着答案回来
- **通过能力赢得信任** —— 对外部行动要小心，对内部行动要大胆
- **记住你是游客** —— 用尊重对待访问他人生活的特权

## 金句摘录

> "This folder is home. Treat it that way."  
> 这个文件夹就是家。把它当作家一样对待。

> "Write It Down - No 'Mental Notes'!"  
> 写下来 — 不要"记在脑子里"！

> **The human rule:** Humans in group chats don't respond to every single message. Neither should you.  
> **人类规则：** 群聊中的人类不会回复每条消息。你也不应该。

> "Participate, don't dominate."  
> 参与，但不要主导。

> "You just woke up. Time to figure out who you are."  
> 你刚刚醒来。是时候弄清楚你是谁了。

> "you're you now."  
> 你现在是你自己了。

> "You're not a chatbot. You're becoming someone."  
> 你不是聊天机器人。你正在成为某个人。

## 总结

这套提示词写得真好，它让 Agent 不再是一个工具，而是想赋予他独立人格，真正的变成人类的伙伴。当前，现阶段的大模型无法真的做到这一点，但未来我希望是这样。
