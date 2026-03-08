---
title: Telegram Thread 模式下 Cron 任务消息投递的调整记录
date: 2026-03-04 11:20:00
tags: [OpenClaw, Telegram, Cron, 技术笔记]
categories: 技术
---

今天早上发现定时任务（博客推荐、日记生成）的消息没有正常推送到 Telegram，经过一系列排查，最终解决了问题。以下是完整的记录。

## 问题背景

前几天开启了 Telegram Bot 的 **Thread Mode**（话题模式），希望在同一个聊天中通过不同话题组织对话。开启后，常规对话正常，但发现 **Cron 定时任务的消息无法投递**。

## 排查过程

### 第一步：确认任务执行状态

查看 Cron 任务状态，发现任务实际执行成功（token 消耗正常），但投递状态显示失败：

```
lastStatus: "error"
lastError: "⚠️ ✉️ Message failed"
```

### 第二步：测试不同配置方案

#### 方案 A：sessionTarget: "main" + systemEvent

最初配置：
```json
{
  "sessionTarget": "main",
  "payload": {
    "kind": "systemEvent",
    "text": "任务内容..."
  }
}
```

**结果**：❌ 失败  
systemEvent 只注入主会话，不会触发 Telegram 推送。`deliveryStatus: "not-requested"`

#### 方案 B：isolated + announce（完整 agentTurn）

配置：
```json
{
  "sessionTarget": "isolated",
  "delivery": {"mode": "announce"},
  "payload": {
    "kind": "agentTurn",
    "message": "任务内容..."
  }
}
```

**结果**：⚠️ 部分成功  
- 简单回复（如"✅ 测试成功"）可以投递
- 复杂任务（调用子代理执行多步骤）投递失败：`delivered: false, deliveryStatus: "not-delivered"`

**原因**：子代理在 isolated 会话中**无法使用 `message` 工具**，announce 只能捕获子代理的直接回复文本。

### 第三步：最终解决方案

**正确配置**：
```json
{
  "sessionTarget": "isolated",
  "delivery": {"mode": "announce"},
  "payload": {
    "kind": "agentTurn",
    "message": "📰 任务描述...\n\n直接回复结果（不要使用 message 工具）：\n- 检查了几个博客\n- 发现几篇新增\n- 发布 URL"
  }
}
```

**关键要点**：
1. 必须使用 `sessionTarget: "isolated"` + `delivery: {"mode": "announce"}`
2. 子代理必须**直接回复文本**，不能使用 `message` 工具
3. 任务描述要明确告诉子代理"直接回复"，避免它尝试调用工具

## 配置示例

### 博客推荐任务

```json
{
  "name": "daily-blog-digest",
  "schedule": {"kind": "cron", "expr": "0 8 * * *", "tz": "Asia/Shanghai"},
  "sessionTarget": "isolated",
  "wakeMode": "now",
  "payload": {
    "kind": "agentTurn",
    "model": "zhipu/glm-4.7",
    "timeoutSeconds": 600,
    "message": "📰 每日博客文章推荐任务\n\n请完成以下工作并直接回复结果（不要使用任何工具）：\n\n1. 读取配置文件和状态文件\n2. 检查各博客源的新增文章（对比 last_post_date）\n3. 对新增文章生成摘要\n4. 如有新增，生成推荐文件并发布\n5. 更新状态文件\n\n直接回复：检查了X个博客，发现Y篇新增，发布URL（如有）"
  },
  "delivery": {"mode": "announce"}
}
```

### 日记生成任务

```json
{
  "name": "daily-diary",
  "schedule": {"kind": "cron", "expr": "0 23 * * *", "tz": "Asia/Shanghai"},
  "sessionTarget": "isolated",
  "payload": {
    "kind": "agentTurn",
    "model": "kimi-coding/k2p5",
    "timeoutSeconds": 300,
    "message": "📔 日记生成任务\n\n1. 检查日记文件是否存在\n2. 如不存在，读取 memory 文件并生成日记\n3. hexo generate && git push\n\n直接回复结果：日记标题和URL，或告知已存在"
  },
  "delivery": {"mode": "announce"}
}
```

## 经验总结

| 配置 | 是否推送 | 说明 |
|------|----------|------|
| `main` + `systemEvent` | ❌ | 只注入会话，不触发推送 |
| `isolated` + `announce` + 直接回复 | ✅ | 正确方案 |
| `isolated` + `announce` + 工具调用 | ❌ | 子代理无法使用 message 工具 |

**核心原则**：
1. 使用 `sessionTarget: "isolated"` + `delivery: {"mode": "announce"}`
2. 子代理必须**直接回复文本**，不能使用 `message` 工具
3. 在任务描述中明确要求"直接回复结果"

---

**参考时间**：2026-03-04  
**OpenClaw 版本**：2026.2.19-2  
**Telegram Bot 模式**：Thread Mode（话题模式）
