# Agent Memory Service — Architecture (v2.0)

## How It Works

```
┌─────────────────────────────────────────────────────────────────────┐
│                        YOUR AI TOOLS                                │
│                                                                     │
│   Claude Code        Cursor          Agents         Dashboard       │
│   ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐        │
│   │ MCP     │    │ Project │    │  Bot 1  │    │  Admin  │        │
│   │ Server  │    │   B     │    │  Bot 2  │    │  Panel  │        │
│   └────┬────┘    └────┬────┘    └────┬────┘    └────┬────┘        │
│        │              │              │              │               │
└────────┼──────────────┼──────────────┼──────────────┼───────────────┘
         │              │              │              │
         ▼              ▼              ▼              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│                   MEMORY SERVICE v2.0  (REST API)                   │
│                   ═══════════════════════════════                   │
│                                                                     │
│   ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│   │  INGEST  │  │  STORE   │  │ CONTEXT  │  │  GRAPH   │          │
│   │          │  │          │  │          │  │          │          │
│   │ Raw text │  │ Direct + │  │ Scoped   │  │ Entity   │          │
│   │ → Gemini │  │ contra-  │  │ by topic │  │ relation │          │
│   │ extracts │  │ diction  │  │ + entity │  │ ships    │          │
│   │ + edges  │  │ detect   │  │ graph    │  │          │          │
│   └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘          │
│        │              │              │              │               │
│        ▼              ▼              ▼              ▼               │
│   ┌─────────────────────────────────────────────────────┐          │
│   │                                                     │          │
│   │              SQLite  (memory.db)                    │          │
│   │                                                     │          │
│   │   memories ─── entity_edges ─── consolidations      │          │
│   │      │              │                               │          │
│   │   summary_level  subject─predicate─object           │          │
│   │   valid_until    confidence                         │          │
│   │                                                     │          │
│   └──────────────────────┬──────────────────────────────┘          │
│                          │                                          │
│                          ▼                                          │
│   ┌─────────────────────────────────────────────────────┐          │
│   │    PROGRESSIVE CONSOLIDATION  (every 6h)            │          │
│   │                                                     │          │
│   │    Level 0 (raw)                                    │          │
│   │      ↓  20+ memories trigger                       │          │
│   │    Level 1 (cluster summaries)                      │          │
│   │      ↓  6+ L1 summaries trigger                    │          │
│   │    Level 2 (theme summaries)                        │          │
│   │      ↓  4+ L2 themes trigger                       │          │
│   │    Level 3 (architectural principles)               │          │
│   │                                                     │          │
│   │    Each level extracts entity edges                 │          │
│   │    Superseded memories get valid_until              │          │
│   └─────────────────────────────────────────────────────┘          │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘


═══════════════════════════════════════════════════════════════════════
                     GEMINI FLASH  ($0.15/M tokens)
                     Extraction + Consolidation + Contradiction Detection
                     Falls back to heuristics if no key
═══════════════════════════════════════════════════════════════════════
```

## Memory Lifecycle

```
  ┌─────────────┐
  │ Conversation │
  │ or Event     │
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐     ┌──────────────┐
  │   INGEST    │────▶│ Gemini Flash  │
  │  /api/ingest│     │ extracts:     │
  └─────────────┘     │  • entities   │
                      │  • topics     │
                      │  • importance │
                      │  • type       │
                      │  • edges      │
                      └──────┬───────┘
                             │
         ┌───────────────────┤
         │                   │
         ▼                   ▼
  ┌──────────────┐   ┌──────────────────┐
  │ CONTRADICTION│   │   ENTITY GRAPH   │
  │   DETECTION  │   │                  │
  │              │   │  subject─pred─obj│
  │  ADD: store  │   │  chat-relay      │
  │  UPDATE:     │   │    ─depends─on─▶ │
  │   supersede  │   │  Supabase SDK    │
  │  NOOP: skip  │   │                  │
  └──────┬───────┘   └──────────────────┘
         │
         ▼
  ┌──────────────────────────────────────┐
  │         MEMORY STORE (SQLite)        │
  │                                      │
  │  ┌────┐ ┌────┐ ┌────┐ ┌────┐       │
  │  │ #1 │ │ #2 │ │ #3 │ │ #4 │  ...  │
  │  │fact│ │obs │ │fact│ │pref│       │
  │  │0.8 │ │0.5 │ │0.7 │ │0.6 │       │
  │  │L0  │ │L0  │ │L0  │ │L0  │       │
  │  └────┘ └────┘ └────┘ └────┘       │
  │                                      │
  └──────────────┬───────────────────────┘
                 │
                 │  Every 6 hours
                 ▼
  ┌──────────────────────────────────────┐
  │   PROGRESSIVE CONSOLIDATION          │
  │                                      │
  │  L0→L1: Cluster #1,#3 (entities)    │
  │       ↓                              │
  │  Gemini summarizes + extracts edges  │
  │       ↓                              │
  │  New L1 summary #5 created           │
  │  #1, #3 superseded (valid_until set) │
  │                                      │
  │  L1→L2: Cluster L1 summaries         │
  │       ↓                              │
  │  New L2 theme #10 created            │
  │                                      │
  │  L2→L3: Cluster L2 themes            │
  │       ↓                              │
  │  New L3 principle #15 created        │
  │                                      │
  │  500 L0 → 50 L1 → 8 L2 → 2 L3      │
  └──────────────────────────────────────┘
                 │
                 ▼
  ┌──────────────────────────────────────┐
  │        QUERY / CONTEXT               │
  │                                      │
  │  Only active memories returned       │
  │  Expired (valid_until) excluded      │
  │  Ranked by importance + recency      │
  │  Scoped by topic when requested      │
  │  Entity graph included               │
  │                                      │
  │  Full context: ~500 tokens           │
  │  Scoped context: ~150 tokens         │
  └──────────────────────────────────────┘
```

## v2.0 Feature: Contradiction Detection

```
  ┌──────────────────┐
  │  New Memory:     │
  │  "Port is 3005"  │
  └────────┬─────────┘
           │
           ▼
  ┌──────────────────┐
  │  findSimilar()   │──── keyword overlap search
  │  Found 2 matches │
  └────────┬─────────┘
           │
           ▼
  ┌──────────────────┐      ┌──────────────────┐
  │  Gemini Flash    │─────▶│  Result:          │
  │  Compare new vs  │      │                  │
  │  existing        │      │  ADD → store it  │
  └──────────────────┘      │  UPDATE → store, │
                            │    supersede old  │
                            │  NOOP → skip it  │
                            └──────────────────┘
```

## v2.0 Feature: Entity Graph

```
  ┌─────────────────────────────────────────┐
  │           entity_edges TABLE             │
  │                                          │
  │  ┌────────────┐  uses   ┌──────────┐    │
  │  │ chat-relay │────────▶│ Supabase │    │
  │  └────────────┘         │   SDK    │    │
  │        │                └────┬─────┘    │
  │        │ requires-           │           │
  │        │ version        validates       │
  │        ▼                     ▼           │
  │  ┌──────────┐         ┌──────────┐      │
  │  │  v2.98   │         │ ES256 JWT│      │
  │  └──────────┘         └──────────┘      │
  │                                          │
  │  GET /api/graph/project                  │
  │  GET /api/graph/project/entity           │
  │  Included in /api/context response       │
  └─────────────────────────────────────────┘
```

## v2.0 Feature: Scoped Context

```
  Full context load:              Scoped context load:
  GET /api/context/proj           GET /api/context/proj?topics=auth

  ┌─────────────────────┐        ┌─────────────────────┐
  │ ALL high-importance │        │ auth-tagged only    │
  │ 30 memories         │        │ 3 memories          │
  │ 10 summaries        │        │ 1 summary           │
  │ 20 facts            │        │ 2 facts             │
  │ Full entity graph   │        │ Filtered graph      │
  │                     │        │                     │
  │ ~500 tokens         │        │ ~150 tokens         │
  └─────────────────────┘        └─────────────────────┘

  Use scoped context in GSD subagents / focused work
  Use full context at start of new conversations
```

## Multi-Project Isolation

```
┌─────────────────────────────────────────────────┐
│              ONE MEMORY SERVICE                  │
│                                                  │
│  ┌───────────────┐  ┌───────────────┐           │
│  │  Project: A   │  │  Project: B   │           │
│  │               │  │               │           │
│  │  45 memories  │  │  12 memories  │           │
│  │  3 summaries  │  │  0 summaries  │           │
│  │  15 edges     │  │  4 edges      │           │
│  │               │  │               │           │
│  │  Can't see B  │  │  Can't see A  │           │
│  └───────────────┘  └───────────────┘           │
│                                                  │
│  All in one SQLite file                          │
│  Scoped by project name                          │
│  Unlimited projects                              │
└─────────────────────────────────────────────────┘
```

## Setup Flow

```
  ┌──────────────────────────────────────────┐
  │  1. DEPLOY  (one time)                   │
  │                                          │
  │  git clone agent-memory-service          │
  │  npm run setup    ← interactive wizard   │
  │  npm start        ← running on :3005     │
  │                                          │
  │  Or: docker / Railway / Render / Fly     │
  └────────────────────┬─────────────────────┘
                       │
                       ▼
  ┌──────────────────────────────────────────┐
  │  2. CONNECT  (per project)              │
  │                                          │
  │  Option A: MCP (recommended)             │
  │  → Add to .mcp.json                      │
  │  → 8 tools auto-available                │
  │  → Zero CLAUDE.md bloat                  │
  │                                          │
  │  Option B: CLAUDE.md curl instructions   │
  │  → Add curl examples to CLAUDE.md        │
  │  → Works with any AI editor              │
  │                                          │
  │  Option C: connect-project.sh script     │
  │  → Auto-detects and configures both      │
  └────────────────────┬─────────────────────┘
                       │
                       ▼
  ┌──────────────────────────────────────────┐
  │  3. USE  (automatic)                    │
  │                                          │
  │  AI uses MCP tools or curl commands      │
  │     ↓                                    │
  │  Fetches scoped context at start         │
  │     ↓                                    │
  │  Searches + checks graph before work     │
  │     ↓                                    │
  │  Stores discoveries (auto-deduplicates)  │
  │     ↓                                    │
  │  Next conversation starts with knowledge │
  └──────────────────────────────────────────┘
```

## Cost Comparison

```
  WITHOUT MEMORY SERVICE               WITH MEMORY SERVICE v2.0
  ════════════════════                  ════════════════════════

  Every conversation:                  Every conversation:

  ┌──────────────────┐                 ┌──────────────────┐
  │ Read CLAUDE.md   │ ~2K tokens      │ Fetch /context   │ ~200-500 tokens
  │ Read MEMORY.md   │ ~2K tokens      │ (scoped by topic)│
  │ Read config files│ ~3K tokens      │                  │
  │ Re-read docs     │ ~3K tokens      │ Already knows:   │
  │                  │                 │ • Past decisions │
  │ Re-discover:     │                 │ • Known gotchas  │
  │ • Same gotchas   │ ~2K tokens      │ • Entity graph   │
  │ • Same patterns  │                 │ • User prefs     │
  │ • Same API quirks│                 │ • No duplicates  │
  └──────────────────┘                 └──────────────────┘

  Cost: ~$0.03/conversation            Cost: ~$0.001/conversation
  × 50 conversations/day               Service: ~$5-10/month
  = ~$1.50/day = ~$45/month
                                        Total: ~$10/month
                                        Savings: ~$35/month + better results
```

## SQLite Schema

```sql
-- Core memories with progressive summarization
memories (
  id, project, agent, content, memory_type, source,
  summary, entities[], topics[], importance,
  access_count, last_accessed_at,
  consolidated, superseded_by,
  summary_level,    -- 0=raw, 1=cluster, 2=theme, 3=principle
  valid_until,      -- temporal invalidation
  created_at, updated_at
)

-- Entity relationship graph
entity_edges (
  id, project,
  subject, predicate, object,  -- "Supabase" "uses" "ES256"
  memory_id,                   -- source memory
  confidence,                  -- 0.0-1.0
  created_at
)

-- Consolidation audit log
consolidations (
  id, project, source_ids[], summary, insight,
  memories_processed, memories_created, created_at
)

-- Auto-registered projects
projects (
  name, display_name, description, config{},
  created_at, last_activity_at
)
```
