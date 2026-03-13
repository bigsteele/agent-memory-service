# Agent Memory Service — Architecture

## How It Works

```
┌─────────────────────────────────────────────────────────────────────┐
│                        YOUR AI TOOLS                                │
│                                                                     │
│   Claude Code        Cursor          Agents         Dashboard       │
│   ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐        │
│   │ Project │    │ Project │    │  Bot 1  │    │  Admin  │        │
│   │   A     │    │   B     │    │  Bot 2  │    │  Panel  │        │
│   └────┬────┘    └────┬────┘    └────┬────┘    └────┬────┘        │
│        │              │              │              │               │
└────────┼──────────────┼──────────────┼──────────────┼───────────────┘
         │              │              │              │
         ▼              ▼              ▼              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│                   MEMORY SERVICE  (REST API)                        │
│                   ═══════════════════════                           │
│                                                                     │
│   ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│   │  INGEST  │  │  QUERY   │  │ CONTEXT  │  │  STORE   │          │
│   │          │  │          │  │          │  │          │          │
│   │ Raw text │  │ Keyword  │  │ Returns  │  │ Direct   │          │
│   │ in, LLM  │  │ search,  │  │ top mem- │  │ struct-  │          │
│   │ extracts │  │ ranked   │  │ ories +  │  │ ured     │          │
│   │ memories │  │ by score │  │ summaries│  │ insert   │          │
│   └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘          │
│        │              │              │              │               │
│        ▼              ▼              ▼              ▼               │
│   ┌─────────────────────────────────────────────────────┐          │
│   │                                                     │          │
│   │              SQLite  (memory.db)                    │          │
│   │                                                     │          │
│   │   memories ─── consolidations ─── projects          │          │
│   │                                                     │          │
│   └──────────────────────┬──────────────────────────────┘          │
│                          │                                          │
│                          ▼                                          │
│   ┌─────────────────────────────────────────────────────┐          │
│   │         BACKGROUND CONSOLIDATOR  (every 6h)         │          │
│   │                                                     │          │
│   │   1. Find unconsolidated memories                   │          │
│   │   2. Cluster by shared entities/topics              │          │
│   │   3. Gemini Flash summarizes each cluster           │          │
│   │   4. Store summary, supersede originals             │          │
│   │   5. Knowledge grows sharper over time              │          │
│   └─────────────────────────────────────────────────────┘          │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘


═══════════════════════════════════════════════════════════════════════
                     GEMINI FLASH  ($0.15/M tokens)
                     Used for extraction & consolidation
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
                      └──────┬───────┘
                             │
                             ▼
  ┌──────────────────────────────────────┐
  │         MEMORY STORE (SQLite)        │
  │                                      │
  │  ┌────┐ ┌────┐ ┌────┐ ┌────┐       │
  │  │ #1 │ │ #2 │ │ #3 │ │ #4 │  ...  │
  │  │fact│ │obs │ │fact│ │pref│       │
  │  │0.8 │ │0.5 │ │0.7 │ │0.6 │       │
  │  └────┘ └────┘ └────┘ └────┘       │
  │                                      │
  └──────────────┬───────────────────────┘
                 │
                 │  Every 6 hours
                 ▼
  ┌──────────────────────────────────────┐
  │        CONSOLIDATION                 │
  │                                      │
  │  Cluster: #1, #3 (shared entities)   │
  │       ↓                              │
  │  Gemini Flash summarizes             │
  │       ↓                              │
  │  New summary #5 created              │
  │  #1, #3 marked superseded            │
  │                                      │
  │  Before: 4 memories, 800 tokens      │
  │  After:  3 memories, 400 tokens      │
  │                                      │
  └──────────────────────────────────────┘
                 │
                 ▼
  ┌──────────────────────────────────────┐
  │           QUERY / CONTEXT            │
  │                                      │
  │  Only active memories returned       │
  │  Ranked by importance + recency      │
  │  One API call = full project context │
  │                                      │
  │  Token cost: ~200-500 tokens         │
  │  vs. rediscovering: 5,000-10,000     │
  └──────────────────────────────────────┘
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
│  │               │  │               │           │
│  │  Can't see B  │  │  Can't see A  │           │
│  └───────────────┘  └───────────────┘           │
│                                                  │
│  ┌───────────────┐  ┌───────────────┐           │
│  │  Project: C   │  │  Project: D   │           │
│  │               │  │               │           │
│  │  128 memories │  │  3 memories   │           │
│  │  8 summaries  │  │  0 summaries  │           │
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
  │  cd /path/to/any-project                 │
  │  bash connect-project.sh YOUR_URL        │
  │                                          │
  │  ✓ Tests connection                      │
  │  ✓ Registers project                     │
  │  ✓ Updates CLAUDE.md                     │
  │  ✓ Updates .cursorrules (if exists)      │
  │  ✓ Gitignores credentials               │
  │                                          │
  │  Claude Code now knows how to use memory │
  └────────────────────┬─────────────────────┘
                       │
                       ▼
  ┌──────────────────────────────────────────┐
  │  3. USE  (automatic)                    │
  │                                          │
  │  Claude reads CLAUDE.md instructions     │
  │     ↓                                    │
  │  Fetches context at conversation start   │
  │     ↓                                    │
  │  Searches before unfamiliar work         │
  │     ↓                                    │
  │  Stores discoveries when done            │
  │     ↓                                    │
  │  Next conversation starts with knowledge │
  └──────────────────────────────────────────┘
```

## Cost Comparison

```
  WITHOUT MEMORY SERVICE               WITH MEMORY SERVICE
  ════════════════════                  ═══════════════════

  Every conversation:                  Every conversation:

  ┌──────────────────┐                 ┌──────────────────┐
  │ Read CLAUDE.md   │ ~2K tokens      │ Fetch /context   │ ~500 tokens
  │ Read MEMORY.md   │ ~2K tokens      │ (one API call)   │
  │ Read config files│ ~3K tokens      │                  │
  │ Re-read docs     │ ~3K tokens      │ Already knows:   │
  │                  │                 │ • Past decisions │
  │ Re-discover:     │                 │ • Known gotchas  │
  │ • Same gotchas   │ ~2K tokens      │ • API quirks     │
  │ • Same patterns  │                 │ • User prefs     │
  │ • Same API quirks│                 └──────────────────┘
  └──────────────────┘
                                        Cost: ~$0.001/conversation
  Cost: ~$0.03/conversation             Service: ~$5-10/month
  × 50 conversations/day
  = ~$1.50/day = ~$45/month             Total: ~$10/month
                                        Savings: ~$35/month + better results
```
