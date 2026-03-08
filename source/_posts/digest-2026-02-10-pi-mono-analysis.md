---
title: 调研：Pi-Mono Agent Loop 实现分析
date: 2026-02-10 13:35:00
tags: [调研, Pi-Mono, Agent, AI]
categories: 调研
---

> 基于本地源码（pi-mono v0.51.1）的详细技术分析

## 1. 架构概览

### 1.1 核心设计哲学
Pi 的 Agent Loop 采用**极简主义设计**，仅提供四个核心工具：
- `read`: 文件读取（支持文本和图片）
- `write`: 文件写入
- `edit`: 精确文本替换
- `bash`: 命令执行

其他所有能力都通过这四个工具的组合来实现（如 `grep`, `find` 等可通过 bash 调用）。

### 1.2 代码位置
```
packages/pi-agent-core/src/agent-loop.ts    # Agent 循环核心
packages/pi-coding-agent/src/core/tools/    # 工具实现
```

---

## 2. Agent Loop 核心实现

### 2.1 双层循环架构

```typescript
// 外层循环：处理 follow-up messages（用户追加的消息）
while (true) {
    let hasMoreToolCalls = true;
    
    // 内层循环：处理工具调用和 steering messages
    while (hasMoreToolCalls || pendingMessages.length > 0) {
        // 1. 发送 pending messages 到上下文
        // 2. 流式获取 LLM 响应
        // 3. 执行工具调用（串行）
        // 4. 检查 steering messages（用户中断）
    }
    
    // 检查是否有 follow-up messages，没有则退出
    const followUpMessages = await config.getFollowUpMessages?.();
    if (followUpMessages.length === 0) break;
    pendingMessages = followUpMessages;
}
```

**设计亮点**：
- **外层循环**：允许 Agent "暂停" 后接收新指令继续（如用户说"等等，先做这个"）
- **内层循环**：处理单次对话中的多工具调用（如 read → edit → bash 链式操作）

### 2.2 事件驱动架构

使用 `EventStream` 进行事件驱动编程：

```typescript
export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; ... }
  | { type: "tool_execution_end"; ... };
```

**优势**：
- UI 可以精确追踪每个阶段（工具开始、部分结果、完成）
- 支持流式输出，用户体验好
- 便于调试和日志记录

### 2.3 工具执行流程

```typescript
async function executeToolCalls(tools, assistantMessage, signal, stream, getSteeringMessages) {
    const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
    
    for (let index = 0; index < toolCalls.length; index++) {
        const toolCall = toolCalls[index];
        const tool = tools?.find((t) => t.name === toolCall.name);
        
        // 1. 发送 tool_execution_start 事件
        stream.push({ type: "tool_execution_start", ... });
        
        // 2. 执行工具（支持部分结果回调）
        result = await tool.execute(toolCall.id, validatedArgs, signal, (partialResult) => {
            stream.push({ type: "tool_execution_update", ... });
        });
        
        // 3. 发送 tool_execution_end 事件
        stream.push({ type: "tool_execution_end", ... });
        
        // 4. 检查 steering messages（用户中断）
        const steering = await getSteeringMessages?.();
        if (steering.length > 0) {
            // 跳过剩余工具调用
            skipRemainingToolCalls();
            break;
        }
    }
}
```

**关键设计**：
- **串行执行**：工具调用是顺序的，不是并行的（保证可预测性）
- **可中断**：支持用户在中途插入新指令（steering）
- **部分结果**：如 bash 命令可以实时流式输出

---

## 3. 四大核心工具实现

### 3.1 Read Tool（文件读取）

```typescript
const readSchema = Type.Object({
    path: Type.String({ description: "Path to the file to read" }),
    offset: Type.Optional(Type.Number({ description: "Line number to start (1-indexed)" })),
    limit: Type.Optional(Type.Number({ description: "Maximum lines to read" })),
});
```

**核心特性**：
1. **智能截断**：默认限制 2000 行或 30KB（`DEFAULT_MAX_LINES`, `DEFAULT_MAX_BYTES`）
2. **图片支持**：自动检测图片格式，支持 jpg/png/gif/webp
3. **图片压缩**：大图片自动缩放（`resizeImage`），避免超出 LLM 上下文
4. **分页读取**：通过 offset/limit 支持大文件分段读取

**Prompt Caching 优化**：
- 工具描述简洁，明确告知截断规则
- 图片转为 base64 后自动缩放，减少 token 消耗

### 3.2 Write Tool（文件写入）

```typescript
const writeSchema = Type.Object({
    path: Type.String({ description: "Path to the file to write" }),
    content: Type.String({ description: "Content to write" }),
});
```

**核心特性**：
1. **自动创建目录**：`mkdir(dir, { recursive: true })`
2. **简洁描述**：没有冗余的格式说明
3. **原子操作**：直接写入，没有复杂的 diff 逻辑

**与 Read 的配合**：
- 写之前通常先 read，但 LLM 可以自主决定
- 没有强制校验（如"必须先读取"），保持灵活性

### 3.3 Edit Tool（精确编辑）

```typescript
const editSchema = Type.Object({
    path: Type.String({ description: "Path to the file to edit" }),
    oldText: Type.String({ description: "Exact text to find and replace" }),
    newText: Type.String({ description: "New text to replace with" }),
});
```

**核心算法**：
1. **Fuzzy Matching**：先尝试精确匹配，失败后用模糊匹配（`fuzzyFindText`）
2. **唯一性校验**：如果找到多个匹配，拒绝执行（防止误替换）
3. **行尾处理**：自动处理 CRLF/LF 差异（`normalizeToLF`）
4. **BOM 处理**：自动剥离 UTF-8 BOM

**Prompt Caching 优势**：
- 只有四个参数，Schema 简洁
- 没有复杂的 "patch" 格式（如 unified diff），LLM 生成更可靠

### 3.4 Bash Tool（命令执行）

```typescript
const bashSchema = Type.Object({
    command: Type.String({ description: "Bash command to execute" }),
    timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
});
```

**核心特性**：
1. **流式输出**：实时捕获 stdout/stderr（`onData` 回调）
2. **输出截断**：超过 30KB 或 2000 行时保存到临时文件
3. **超时控制**：支持 timeout 参数，超时后 kill 整个进程树
4. **Shell 适配**：自动检测系统 Shell（bash/zsh/powershell）

**设计智慧**：
- **组合性**：通过 bash 可以调用 grep/find/ls 等，无需为每个命令单独定义工具
- **安全性**：timeout 和进程树 kill 防止挂起

---

## 4. Prompt Caching 优化策略

### 4.1 工具描述最小化

对比其他 Agent 框架（如 OpenClaw 的 20+ 工具），Pi 只有 4 个核心工具：

**优势**：
- 工具描述短，占用 token 少
- LLM 更容易记住每个工具的用途
- 减少 "选择困难"（LLM 不会困惑该用哪个工具）

### 4.2 输出截断机制

```typescript
export const DEFAULT_MAX_BYTES = 30 * 1024;  // 30KB
export const DEFAULT_MAX_LINES = 2000;        // 2000行
```

**截断策略**（`truncate.ts`）：
```typescript
export function truncateTail(content: string) {
    const lines = content.split("\n");
    
    // 如果行数超标，保留最后 2000 行
    if (lines.length > DEFAULT_MAX_LINES) {
        const truncatedLines = lines.slice(-DEFAULT_MAX_LINES);
        return {
            truncated: true,
            content: truncatedLines.join("\n"),
            totalLines: lines.length,
            outputLines: DEFAULT_MAX_LINES,
            truncatedBy: "lines",
        };
    }
    
    // 如果字节数超标，保留最后的 30KB
    const buffer = Buffer.from(content, "utf-8");
    if (buffer.length > DEFAULT_MAX_BYTES) {
        const truncated = buffer.slice(-DEFAULT_MAX_BYTES);
        return {
            truncated: true,
            content: truncated.toString("utf-8"),
            truncatedBy: "bytes",
        };
    }
    
    return { truncated: false, content };
}
```

**Prompt Caching 收益**：
- 大文件不会撑爆上下文
- 保留最近的输出（通常是错误信息或结果）
- 告知 LLM "输出被截断"，引导其使用 offset/limit 继续读取

### 4.3 类型安全与 Schema

使用 `@sinclair/typebox` 定义工具参数：

```typescript
const readSchema = Type.Object({
    path: Type.String({ description: "..." }),
    offset: Type.Optional(Type.Number({ description: "..." })),
    limit: Type.Optional(Type.Number({ description: "..." })),
});
```

**优势**：
- 类型安全，减少运行时错误
- 自动生成 JSON Schema，便于 LLM 理解
- 代码压缩后体积小

---

## 5. 扩展机制：Skills 系统

虽然核心只有 4 个工具，但 Pi 支持通过 **README.md 模式** 扩展能力：

### 5.1 渐进式披露（Progressive Disclosure）

```
skill-directory/
├── README.md          # 工具描述（LLM 按需读取）
├── main.ts            # 实现代码
└── package.json
```

**工作流程**：
1. LLM 初始只有 4 个基础工具
2. 当任务需要时（如测试），LLM 使用 `read` 读取 skill 的 README
3. README 包含该 skill 的详细说明和调用方式
4. LLM 通过 `bash` 调用 skill（如 `npm test`）

**优势**：
- 只有在需要时才支付 token 成本（读取 README）
- 不污染核心工具列表
- 易于社区贡献（只需写 README 和脚本）

---

## 6. 与 OpenClaw 的对比

| 特性 | Pi-Mono | OpenClaw |
|------|---------|----------|
| 核心工具数 | 4 (read/write/edit/bash) | 20+ (含 calendar/web_search/browser 等) |
| 工具设计 | 最小化，组合式 | 全面化，内置式 |
| Prompt Caching | 友好（描述短，输出截断） | 较差（工具多，描述长） |
| 扩展方式 | README + bash | Skill 系统（YAML + 代码） |
| 架构复杂度 | 简单 | 复杂 |

**Pi 的优势**：
- 上下文占用小，长对话性能更好
- LLM 工具选择更明确
- 通过 bash 组合实现灵活性，不牺牲简洁性

---

## 7. 关键代码摘录

### 7.1 Agent Loop 入口

```typescript
// packages/pi-agent-core/src/agent-loop.ts
export function agentLoop(
    prompts: AgentMessage[],
    context: AgentContext,
    config: AgentLoopConfig,
    signal?: AbortSignal,
    streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
    const stream = createAgentStream();

    (async () => {
        const newMessages: AgentMessage[] = [...prompts];
        const currentContext: AgentContext = {
            ...context,
            messages: [...context.messages, ...prompts],
        };

        stream.push({ type: "agent_start" });
        stream.push({ type: "turn_start" });
        
        for (const prompt of prompts) {
            stream.push({ type: "message_start", message: prompt });
            stream.push({ type: "message_end", message: prompt });
        }

        await runLoop(currentContext, newMessages, config, signal, stream, streamFn);
    })();

    return stream;
}
```

### 7.2 工具定义示例（Read）

```typescript
// packages/pi-coding-agent/src/core/tools/read.ts
export function createReadTool(cwd, options) {
    return {
        name: "read",
        label: "read",
        description: `Read the contents of a file...truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB...`,
        parameters: readSchema,
        execute: async (_toolCallId, { path, offset, limit }, signal) => {
            const absolutePath = resolveReadPath(path, cwd);
            // 检查 abort signal
            if (signal?.aborted) {
                throw new Error("Operation aborted");
            }
            // 读取文件逻辑...
        },
    };
}
```

### 7.3 工具组合（Coding Tools）

```typescript
// packages/pi-coding-agent/src/core/tools/index.ts
export const codingTools = [readTool, bashTool, editTool, writeTool];
export const readOnlyTools = [readTool, grepTool, findTool, lsTool];

export function createCodingTools(cwd, options) {
    return [
        createReadTool(cwd, options?.read),
        createBashTool(cwd, options?.bash),
        createEditTool(cwd),
        createWriteTool(cwd),
    ];
}
```

---

## 8. 总结

Pi-Mono 的 Agent Loop 通过以下设计实现了**高效、简洁、可缓存**的目标：

1. **四大核心工具**：最小化工具集，其他能力通过 bash 组合
2. **双层循环架构**：支持会话延续和实时中断（steering）
3. **事件驱动**：流式处理，用户体验好
4. **输出截断**：30KB/2000行限制，保护上下文空间
5. **渐进式披露**：Skill 能力按需加载，不常驻上下文
6. **类型安全**：TypeBox 定义 Schema，减少错误

这些设计使得 Pi 在长对话场景中表现出色，同时保持了代码的简洁性和可维护性。

---

**报告完成时间**: 2026-02-10  
**分析源码版本**: pi-mono v0.51.1  
**源码位置**: `/usr/local/lib/node_modules/openclaw/node_modules/@mariozechner/`
