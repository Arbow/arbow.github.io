---
title: 文摘：OpenClaw Memory 模块设计文档
date: 2026-02-05 00:05:00
tags: [文摘, OpenClaw, Memory]
categories: 文摘
---

> 原文来自：Arbow 的笔记库  
> 收录时间：2026-02-05

---

# OpenClaw Memory 模块设计文档

## 概述

OpenClaw 的 Memory 模块是一个 sophisticated 的 semantic search 系统，使 AI Agent 能够从基于 markdown 的记忆文件中 recall 先前的工作、决策和上下文。它结合了 vector embeddings、full-text search 和 hybrid ranking，以提供快速、准确的相关信息检索。

## 架构

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Memory 模块架构                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                   │
│  │   CLI 层     │    │  Agent 工具  │    │    配置层     │                   │
│  │  memory-cli  │    │memory_search │    │ memory-search│                   │
│  │              │    │  memory_get  │    │   config.ts  │                   │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘                   │
│         │                   │                    │                          │
│         └───────────────────┼────────────────────┘                          │
│                             ▼                                               │
│              ┌──────────────────────────────┐                               │
│              │   MemorySearchManager        │                               │
│              │   (search-manager.ts)        │                               │
│              └──────────────┬───────────────┘                               │
│                             │                                               │
│                             ▼                                               │
│              ┌──────────────────────────────┐                               │
│              │    MemoryIndexManager        │                               │
│              │      (manager.ts)            │                               │
│              └──────────────┬───────────────┘                               │
│                             │                                               │
│         ┌───────────────────┼───────────────────┐                          │
│         ▼                   ▼                   ▼                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                      │
│  │   Embedding  │  │    Search    │  │    Sync      │                      │
│  │   Providers  │  │   Engine     │  │   Engine     │                      │
│  │              │  │              │  │              │                      │
│  │ • OpenAI     │  │ • Vector     │  │ • File Watch │                      │
│  │ • Gemini     │  │ • FTS (BM25) │  │ • Session    │                      │
│  │ • Local      │  │ • Hybrid     │  │ • Interval   │                      │
│  │   (llama.cpp)│  │   Merge      │  │ • Delta      │                      │
│  └──────────────┘  └──────────────┘  └──────────────┘                      │
│                             │                                               │
│                             ▼                                               │
│              ┌──────────────────────────────┐                               │
│              │      SQLite + sqlite-vec     │                               │
│              │   (Vector + FTS5 Storage)    │                               │
│              └──────────────────────────────┘                               │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 核心组件

### 1. MemoryIndexManager (`src/memory/manager.ts`)

中央 orchestrator，管理 indexing、search 和 synchronization。

**核心职责：**
- **Singleton Pattern**: 通过 `MemoryIndexManager.get()` 实现 per-agent cached instances
- **Embedding Provider Management**: 支持 auto-selection 和 fallback
- **File Watching**: 通过 `chokidar` 实现 real-time sync
- **Session Sync**: 基于 Delta 的 conversation transcripts indexing
- **Safe Reindexing**: 支持 rollback 的 atomic index rebuilds

**状态管理：**
```typescript
// 核心状态追踪
private dirty = false;                    // Memory 文件已变更
private sessionsDirty = false;            // Session 文件已变更
private sessionDeltas = new Map();        // Per-file delta tracking
private syncing: Promise<void> | null;    // Active sync lock
```

### 2. Embedding Providers (`src/memory/embeddings.ts`)

支持 automatic fallback 的多提供商 embedding 系统。

**支持的 Providers：**

| Provider | Model | 适用场景 |
|----------|-------|----------|
| OpenAI | text-embedding-3-small | Cloud-based, high quality |
| Gemini | embedding-001 | Google AI, alternative cloud |
| Local | embeddinggemma-300M | Privacy-first, offline |

**Auto-Selection 逻辑：**
1. 如果 `provider: "auto"`，首先检查 local model file
2. 尝试 OpenAI（如果有 API key）
3. 尝试 Gemini（如果有 API key）
4. Fallback chain: primary → fallback provider on errors

### 3. Hybrid Search (`src/memory/hybrid.ts`, `src/memory/manager-search.ts`)

结合 vector similarity 和 BM25 full-text search。

**Search Flow：**
```
Query → [Embed Query] → Vector Search (cosine similarity)
     → [Tokenize]    → FTS Search (BM25 ranking)
     → [Merge Results] → Weighted Score = vectorWeight * vectorScore + textWeight * textScore
```

**配置：**
```typescript
hybrid: {
  enabled: boolean;        // 启用 FTS hybrid search
  vectorWeight: 0.7;       // Vector score 权重
  textWeight: 0.3;         // BM25 score 权重
  candidateMultiplier: 4;  // Candidates = maxResults * 4
}
```

### 4. Storage Layer (`src/memory/memory-schema.ts`)

基于 SQLite 的 storage，采用两种 indexing strategies：

**数据表：**
- `meta`: Index metadata（model, provider, chunk settings）
- `files`: 带 content hashes 的文件清单
- `chunks`: 带 embeddings 的 text chunks（JSON 存储）
- `chunks_vec`: 用于 vector search 的 virtual table（sqlite-vec）
- `chunks_fts`: 用于 text search 的 FTS5 virtual table
- `embedding_cache`: Embeddings 的 deduplication cache

**Schema 设计：**
```sql
-- 带 JSON embeddings 的核心 chunk storage
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'memory',  -- 'memory' | 'sessions'
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  hash TEXT NOT NULL,                      -- Content hash for dedup
  model TEXT NOT NULL,                     -- 使用的 Embedding model
  text TEXT NOT NULL,
  embedding TEXT NOT NULL,                 -- JSON array
  updated_at INTEGER NOT NULL
);

-- 通过 sqlite-vec extension 进行 vector search
CREATE VIRTUAL TABLE chunks_vec USING vec0(
  id TEXT PRIMARY KEY,
  embedding FLOAT[768]  -- Dynamic dimensions
);
```

### 5. Synchronization Engine

**多源 Sync：**

| Source | Trigger | Strategy |
|--------|---------|----------|
| Memory Files | File watcher | Hash-based incremental |
| Sessions | Event + Delta | Byte/message threshold |
| Interval | Timer | Full scan every N minutes |
| Search | On-demand | Lazy sync if dirty |

**Session Delta Tracking：**
```typescript
// 高效的 incremental indexing
sessionDeltas = Map<filepath, {
  lastSize: number,      // 上次 indexed file size
  pendingBytes: number,  // 上次 sync 后的 Bytes
  pendingMessages: number // 上次 sync 后的 Newlines（messages）
}>

// Sync 触发条件：
// pendingBytes >= deltaBytes OR pendingMessages >= deltaMessages
```

**File Watching：**
- 使用 `chokidar` 实现 cross-platform file watching
- Debounced sync（默认 1000ms）
- 监控：`MEMORY.md`, `memory.md`, `memory/`, 以及 `extraPaths`

## 数据流

### Indexing Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Markdown   │────▶│   Chunking  │────▶│  Embedding  │────▶│   SQLite    │
│   Files     │     │  (tokens)   │     │   (batch)   │     │   Storage   │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
       │                   │                   │                   │
       ▼                   ▼                   ▼                   ▼
  listMemoryFiles()   chunkMarkdown()   embedBatch()      INSERT/UPDATE
  (file discovery)    (line-based)      (provider API)    (with cache)
```

**Chunking Strategy：**
- 基于 Line 的 chunking，支持 configurable token limits
- Chunks 之间的 Overlap，保持 context continuity
- 对超长行的 Smart line splitting

```typescript
chunkMarkdown(content, { tokens: 300, overlap: 50 })
// maxChars = tokens * 4（近似值）
// overlapChars = overlap * 4
```

### Search Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ User Query  │────▶│   Embed     │────▶│ Vector Search│
│  "auth bug" │     │   Query     │     │ (sqlite-vec) │
└─────────────┘     └─────────────┘     └──────┬──────┘
                                               │
┌─────────────┐     ┌─────────────┐           │
│   Results   │◀────│ Hybrid Merge│◀──────────┘
│  (ranked)   │     │ (weighted)  │
└─────────────┘     └──────┬──────┘
                           │
                    ┌──────┴──────┐
                    ▼             ▼
            ┌─────────────┐ ┌─────────────┐
            │ BM25 Search │ │   Vector    │
            │   (FTS5)    │ │  (cosine)   │
            └─────────────┘ └─────────────┘
```

## 配置

### Memory Search Config (`src/agents/memory-search.ts`)

```typescript
interface MemorySearchConfig {
  enabled: boolean;
  sources: ("memory" | "sessions")[];  // 数据源
  extraPaths: string[];                 // 额外的 files/dirs
  
  provider: "openai" | "gemini" | "local" | "auto";
  fallback: "openai" | "gemini" | "local" | "none";
  model: string;                        // Embedding model
  
  remote?: {
    baseUrl?: string;
    apiKey?: string;
    headers?: Record<string, string>;
    batch?: {
      enabled: boolean;
      concurrency: number;
      wait: boolean;
      timeoutMinutes: number;
    };
  };
  
  local?: {
    modelPath?: string;
    modelCacheDir?: string;
  };
  
  store: {
    path: string;           // SQLite db path
    vector: {
      enabled: boolean;
      extensionPath?: string;
    };
  };
  
  chunking: {
    tokens: number;         // Chunk size
    overlap: number;        // Chunks 之间的 overlap
  };
  
  query: {
    maxResults: number;
    minScore: number;       // 0-1 threshold
    hybrid: {
      enabled: boolean;
      vectorWeight: number;
      textWeight: number;
      candidateMultiplier: number;
    };
  };
  
  cache: {
    enabled: boolean;
    maxEntries?: number;
  };
  
  sync: {
    onSessionStart: boolean;
    onSearch: boolean;      // Lazy sync
    watch: boolean;         // File watcher
    watchDebounceMs: number;
    intervalMinutes?: number;
    sessions?: {
      deltaBytes: number;   // N bytes 后 sync
      deltaMessages: number; // N messages 后 sync
    };
  };
}
```

### YAML 配置示例

```yaml
agents:
  defaults:
    memorySearch:
      enabled: true
      sources: ["memory", "sessions"]
      provider: "auto"  # auto | openai | gemini | local
      fallback: "gemini"
      model: "text-embedding-3-small"
      
      remote:
        apiKey: "${OPENAI_API_KEY}"
        batch:
          enabled: true
          concurrency: 4
          wait: true
      
      store:
        path: "~/.openclaw/memory/{agentId}.sqlite"
        vector:
          enabled: true
      
      chunking:
        tokens: 300
        overlap: 50
      
      query:
        maxResults: 10
        minScore: 0.6
        hybrid:
          enabled: true
          vectorWeight: 0.7
          textWeight: 0.3
      
      sync:
        onSessionStart: true
        onSearch: true
        watch: true
        intervalMinutes: 30
        sessions:
          deltaBytes: 10240  // 10KB
          deltaMessages: 10
```

## Agent 工具

### memory_search

Agent 回答关于先前工作的问题之前的 mandatory recall step。

```typescript
{
  name: "memory_search",
  description: "Semantically search MEMORY.md + memory/*.md before answering...",
  parameters: {
    query: string;        // Search query
    maxResults?: number;  // Default from config
    minScore?: number;    // Default from config
  },
  returns: {
    results: Array<{
      path: string;       // File path
      startLine: number;
      endLine: number;
      score: number;      // Combined score
      snippet: string;    // Text preview
      source: "memory" | "sessions";
    }>;
    provider: string;
    model: string;
    fallback?: { from: string; reason: string };
  };
}
```

### memory_get

Search 后用于 retrieving specific line ranges 的 safe file reader。

```typescript
{
  name: "memory_get",
  description: "Safe snippet read from MEMORY.md...",
  parameters: {
    path: string;     // Relative path
    from?: number;    // Start line (1-indexed)
    lines?: number;   // Number of lines
  },
  returns: {
    text: string;
    path: string;
  };
}
```

## 性能优化

### 1. Embedding Cache
- 基于 SHA256 的 deduplication
- Persistent across sessions
- 超过 maxEntries 时进行 LRU pruning

### 2. Incremental Sync
- Content hash comparison（SHA256）
- 仅 re-index changed files
- Session files 的 Delta tracking

### 3. Batch Processing
- OpenAI: 用于 large indexing jobs 的 Batch API
- Gemini: Parallel batch requests
- Configurable concurrency

### 4. Safe Reindexing
- Atomic file swaps（temp → backup → new）
- Failure 时 rollback
- Zero-downtime index rebuilds

### 5. Vector Extension
- 用于 native vector operations 的 sqlite-vec
- 如果不可用，回退到 JS cosine similarity

## 错误处理与弹性

### Provider Fallback
```typescript
// Embedding error 时自动切换到 fallback provider
if (shouldFallbackOnError(error)) {
  await activateFallbackProvider(error);
  await runSafeReindex({ force: true });
}
```

### Graceful Degradation
- FTS unavailable → Vector-only search
- sqlite-vec unavailable → JS cosine similarity
- Provider unavailable → Fallback 或 error

### Batch Failure Recovery
- 追踪 consecutive failures
- Lock mechanism 防止 cascade
- 带 exponential backoff 的 automatic retry

## 安全考量

### Path Security
- 所有 paths 相对于 workspace 解析
- 忽略 Symlinks
- `extraPaths` 针对 allowed directories 进行验证

### File Access
```typescript
// readFile() 中的安全检查
const allowedWorkspace = inWorkspace && isMemoryPath(relPath);
const allowedAdditional = extraPaths.some(p => absPath.startsWith(p));
if (!allowedWorkspace && !allowedAdditional) {
  throw new Error("path required");
}
```

## CLI 接口

```bash
# 检查 memory status
openclaw memory status [--deep] [--index]

# 强制 reindex
openclaw memory index [--force]

# 搜索 memory
openclaw memory search <query> [--max-results N] [--min-score 0.6]
```

## 测试策略

该模块包含 comprehensive tests：

| Test File | Coverage |
|-----------|----------|
| `manager.atomic-reindex.test.ts` | 带 rollback 的 Safe reindexing |
| `manager.async-search.test.ts` | Concurrent search/sync |
| `manager.batch.test.ts` | Batch embedding API |
| `manager.sync-errors-do-not-crash.test.ts` | Error resilience |
| `manager.vector-dedupe.test.ts` | Vector deduplication |
| `embeddings.test.ts` | Provider selection |
| `hybrid.test.ts` | Hybrid ranking |
| `internal.test.ts` | Chunking, hashing |

## 未来增强

1. **Multi-modal Memory**: Image/document embeddings
2. **Temporal Queries**: 基于 Time 的 filtering
3. **Memory Graph**: Memories 之间的 Relationship extraction
4. **Compression**: 用于 storage 的 Embedding quantization
5. **Distributed**: Multi-agent shared memory

## 参考

- [sqlite-vec](https://github.com/asg017/sqlite-vec): Vector search extension
- [FTS5](https://www.sqlite.org/fts5.html): Full-text search
- [OpenAI Embeddings](https://platform.openai.com/docs/guides/embeddings)
- [Gemini Embeddings](https://ai.google.dev/gemini-api/docs/embeddings)
