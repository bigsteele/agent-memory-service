# Agent Memory Service

Persistent AI memory for coding assistants and autonomous agents. Drop-in memory layer that works with Claude Code, Cursor, Windsurf, OpenAI Codex, or any LLM-powered tool.

Inspired by [Google's Always-On Memory Agent](https://github.com/GoogleCloudPlatform/generative-ai/tree/main/gemini/agents/always-on-memory-agent), rebuilt for production multi-project use with entity graphs, temporal invalidation, and progressive summarization.

## What It Does

Your AI assistant forgets everything between conversations. This fixes that.

- **Ingest** — Send raw conversation text. Gemini Flash extracts structured memories and entity relationships for pennies.
- **Store** — Persist facts, observations, decisions, and gotchas with automatic contradiction detection.
- **Query** — Search across all memories by keyword, entity, topic, or importance. Optionally include entity graph.
- **Context** — One API call returns everything the AI needs to know, scoped by topic and compressed. Includes entity graph.
- **Graph** — Entity-relationship graph shows how things connect (e.g., "Supabase uses ES256", "relay depends-on SDK").
- **Consolidate** — Progressive summarization merges related memories across 3 levels, keeping the store lean.

### v2.0 Features

| Feature | What It Does | Token Impact |
|---------|-------------|--------------|
| **Entity Graph** | Stores subject-predicate-object relationships between entities. Included in context and query responses. | Navigable knowledge — fewer follow-up queries |
| **Scoped Context** | Filter context by topic (e.g., `topics=auth,database`). Only relevant memories returned. | 40-70% context reduction for focused work |
| **Contradiction Detection** | New memories automatically checked against existing ones. Duplicates skipped, contradictions supersede old versions. | Prevents stale data accumulation |
| **Temporal Invalidation** | Superseded memories get `valid_until` timestamp. Expired memories excluded from queries. | Cleaner context, no conflicting information |
| **Progressive Summarization** | 3-level consolidation: raw→cluster→theme→principle. Context returns highest level available. | Compact context that grows slower than memory count |

## Quick Start

### Local (2 minutes)

```bash
git clone https://github.com/bigsteele/agent-memory-service.git
cd agent-memory-service
npm install
node server.js
```

Open `http://localhost:3005/health` — you're running.

### With Gemini Flash (recommended)

Get a free API key at [aistudio.google.com](https://aistudio.google.com/apikey).

```bash
GEMINI_API_KEY=your-key node server.js
```

Now `/api/ingest` will use Gemini Flash ($0.15/M tokens) to extract structured memories and entity relationships from raw text instead of basic heuristics.

### Docker

```bash
docker build -t agent-memory-service .
docker run -p 3005:3005 -v memory-data:/data -e GEMINI_API_KEY=your-key agent-memory-service
```

### Railway / Render / Fly.io

1. Push this repo to your hosting platform
2. Mount a persistent volume at `/data` (for SQLite)
3. Set env vars: `GEMINI_API_KEY`, `MEMORY_API_KEY` (optional auth)
4. Deploy

## API Reference

### `POST /api/ingest` — Smart Ingest

Send raw text. The service extracts structured memories and entity relationships using Gemini Flash.

```bash
curl -X POST http://localhost:3005/api/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "project": "my-app",
    "source": "conversation",
    "content": "We switched from Redis to in-memory caching because Redis was adding 500ms p99 latency. The team decided this was acceptable since our dataset fits in RAM."
  }'
```

### `POST /api/store` — Direct Store (with Contradiction Detection)

Store a pre-structured memory. The service automatically checks for contradictions with existing memories:
- **ADD** — New information, stored normally
- **UPDATE** — Contradicts existing memory, old one superseded
- **NOOP** — Duplicate of existing memory, storage skipped

```bash
curl -X POST http://localhost:3005/api/store \
  -H "Content-Type: application/json" \
  -d '{
    "project": "my-app",
    "content": "Redis cache causes 500ms p99 latency in production",
    "memory_type": "fact",
    "importance": 0.8,
    "entities": ["Redis"],
    "topics": ["performance", "caching"],
    "edges": [{"subject": "Redis", "predicate": "causes", "object": "500ms latency"}],
    "source": "debug-session"
  }'
```

Response includes contradiction info:
```json
{
  "status": "stored",
  "id": 42,
  "contradiction": {
    "action": "UPDATE",
    "superseded": [15],
    "reason": "Updates Redis latency from 200ms to 500ms"
  }
}
```

### `GET /api/query` — Search Memories

```bash
# Basic search
curl "http://localhost:3005/api/query?project=my-app&q=redis+performance&limit=5"

# With topic filter and entity graph
curl "http://localhost:3005/api/query?project=my-app&q=redis&topics=performance,caching&include_graph=true"
```

Results ranked by importance, then recency. Searches across content, summary, entities, and topics.

### `GET /api/context/:project` — LLM Context (Scoped)

Returns a compressed summary optimized for injecting into an LLM system prompt. Supports topic scoping.

```bash
# Full project context
curl http://localhost:3005/api/context/my-app

# Scoped to specific topics (smaller, focused context)
curl "http://localhost:3005/api/context/my-app?topics=auth,database"
```

Returns:
- High-importance memories (importance >= 0.7), filtered by topics if specified
- Recent consolidated summaries (sorted by summary level, highest first)
- Recent facts
- Entity graph (full or filtered to relevant entities)
- Stats overview

### `GET /api/graph/:project` — Entity Graph

```bash
# Full project graph
curl "http://localhost:3005/api/graph/my-app?limit=50"

# Edges for a specific entity
curl "http://localhost:3005/api/graph/my-app/Supabase"
```

Returns subject-predicate-object triples showing how entities relate.

### `GET /api/stats/:project` — Memory Stats

```bash
curl http://localhost:3005/api/stats/my-app
```

Now includes `entity_edges` count.

### `GET /api/recent/:project` — Recent Memories

```bash
curl "http://localhost:3005/api/recent/my-app?limit=20"
```

### `GET /api/recall/:id` — Get Specific Memory

```bash
curl http://localhost:3005/api/recall/42
```

### `POST /api/consolidate` — Manual Consolidation

```bash
# Consolidate a specific project
curl -X POST http://localhost:3005/api/consolidate \
  -H "Content-Type: application/json" \
  -d '{"project": "my-app"}'

# Consolidate all projects
curl -X POST http://localhost:3005/api/consolidate
```

### `DELETE /api/forget/:id` — Forget a Memory

```bash
curl -X DELETE http://localhost:3005/api/forget/42
```

### `POST /api/prune` — Bulk Cleanup

```bash
curl -X POST http://localhost:3005/api/prune \
  -H "Content-Type: application/json" \
  -d '{"project": "my-app", "before": "2025-01-01", "importance_below": 0.3}'
```

### `GET /api/projects` — List All Projects

```bash
curl http://localhost:3005/api/projects
```

### `GET /health` — Health Check

```bash
curl http://localhost:3005/health
```

Returns version, feature list, project count, Gemini status, and uptime.

## Connecting Your AI Tools

### Claude Code (MCP — Recommended)

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/path/to/agent-memory-service/mcp-server.js"],
      "env": {
        "MEMORY_SERVICE_URL": "https://your-memory-service.com",
        "MEMORY_PROJECT": "your-project-name",
        "MEMORY_API_KEY": ""
      }
    }
  }
}
```

This gives Claude Code 8 MCP tools with zero CLAUDE.md bloat:

| Tool | Purpose |
|------|---------|
| `memory_context` | Load project knowledge (supports topic scoping) |
| `memory_query` | Search memories (supports entity graph inclusion) |
| `memory_store` | Store with automatic contradiction detection |
| `memory_ingest` | Smart extraction via Gemini Flash |
| `memory_recent` | Recent memories |
| `memory_stats` | Store statistics |
| `memory_forget` | Delete a memory |
| `memory_graph` | Browse entity relationship graph |

**Why MCP instead of curl instructions?**
- **Saves tokens** — no curl commands or response parsing in context
- **Works with subagents** — GSD subagents automatically inherit MCP tools
- **Works with loops** — Ralph Loops and other iteration patterns don't waste tokens on memory management
- **Self-documenting** — tool schemas describe usage; no CLAUDE.md instructions needed
- **Cleaner** — native tool calls instead of Bash(curl) parsing

Or use the connect script:

```bash
bash /path/to/agent-memory-service/scripts/connect-project.sh https://your-memory-service.com
```

Then add one line to CLAUDE.md (optional):

```markdown
## Memory Service
Available via the `memory` MCP server (configured in `.mcp.json`). Use `memory_context` to load project knowledge, `memory_query` to search, `memory_store` to persist discoveries, `memory_graph` to explore entity relationships.
```

### Claude Code (CLAUDE.md Fallback)

If you can't use MCP, see [docs/CLAUDE-CODE-SETUP.md](docs/CLAUDE-CODE-SETUP.md) for curl-based CLAUDE.md instructions.

### Cursor / Windsurf / Other AI Editors

Add curl instructions to `.cursorrules`, `.windsurfrules`, or your editor's AI config file. See [docs/CLAUDE-CODE-SETUP.md](docs/CLAUDE-CODE-SETUP.md) — the format works for any editor.

### Autonomous Agents (OpenClaw, LangGraph, etc.)

Any agent with HTTP access can use the REST API directly. For Python agents, use the included `scripts/agent-memory.py` — stdlib-only CLI that wraps the full API.

```bash
# Store a memory with entity edges
python3 memory.py --action store --content "Supabase uses ES256 JWT signing" \
  --type fact --importance 0.8 --entities Supabase,ES256 --topics auth,jwt \
  --edges "Supabase:uses:ES256"

# Scoped context load
python3 memory.py --action context --topics auth,deployment

# Entity graph lookup
python3 memory.py --action graph --entity Supabase

# Query with graph
python3 memory.py --action query --query "auth" --include-graph
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3005` | HTTP server port |
| `MEMORY_DB_PATH` | `/data/memory.db` | SQLite file path |
| `GEMINI_API_KEY` | — | Google Gemini API key (enables smart extraction + contradiction detection) |
| `GEMINI_MODEL` | `gemini-2.5-flash-preview-05-20` | Which Gemini model to use |
| `MEMORY_API_KEY` | — | API key for auth (optional, set `x-api-key` header) |
| `CONSOLIDATION_INTERVAL_MS` | `21600000` | Background consolidation interval (default: 6h) |
| `CONSOLIDATION_BATCH_SIZE` | `50` | Max memories per consolidation run |
| `CONSOLIDATION_THRESHOLD` | `20` | Min unconsolidated memories before consolidation triggers |
| `MAX_CLUSTER_SIZE` | `8` | Max memories merged into a single summary |
| `IMPORTANCE_PROTECT` | `0.85` | Memories at or above this importance are never consolidated |

## How It Works

### Memory Types

| Type | When to Use |
|------|-------------|
| `observation` | Something noticed during work |
| `fact` | Verified, concrete information |
| `reflection` | Interpretation, lesson learned, or inference |
| `summary` | Auto-generated from consolidation |
| `episode` | Narrative of a sequence of events |
| `preference` | How something should be done |

### Importance Scoring

| Score | Meaning |
|-------|---------|
| 0.9-1.0 | Critical — security, money, breaking changes |
| 0.7-0.8 | High — key decisions, integration patterns |
| 0.5-0.6 | Medium — useful context, normal observations |
| 0.3-0.4 | Low — minor details |
| 0.1-0.2 | Trivial — might help someday |

### Progressive Summarization

Memories consolidate through 3 levels:

| Level | Name | Trigger | What It Produces |
|-------|------|---------|-----------------|
| 0 → 1 | Raw → Cluster | 20+ L0 memories | Daily/cluster summaries (2-8 raw → 1 summary) |
| 1 → 2 | Cluster → Theme | 6+ L1 summaries | Weekly theme summaries (3-6 L1 → 1 theme) |
| 2 → 3 | Theme → Principle | 4+ L2 themes | Architectural principles (3+ L2 → 1 principle) |

Context endpoint returns the highest available level per topic cluster. A project with 500 raw memories might compress to 50 L1 summaries, 8 L2 themes, and 2 L3 principles — dramatically reducing context size over time.

### Entity Graph

Every memory can contain entity-relationship edges:

```
Subject ──predicate──→ Object
Supabase ──uses──→ ES256
chat-relay ──depends-on──→ Supabase SDK
Trader ──runs-on──→ Railway
```

Edges are extracted automatically by Gemini Flash during ingest/consolidation, or provided explicitly on store. The graph is included in context responses and can be queried independently via `/api/graph`.

### Contradiction Detection

When storing a new memory (with Gemini enabled):
1. Service searches for similar existing memories (keyword overlap)
2. Gemini classifies: ADD (new info), UPDATE (supersedes old), or NOOP (duplicate)
3. For UPDATE: old memories get `superseded_by` + `valid_until` timestamps
4. For NOOP: storage skipped, returns pointer to existing memory

This prevents data rot — stale information is automatically cleaned up as new knowledge arrives.

### Safety Guardrails

- High-importance memories (>= 0.85) are **never** consolidated — they stay as-is forever
- Clusters capped at 8 memories to prevent mega-merges that lose detail
- No transitive expansion — only the seed memory's tags determine cluster scope
- Requires 20+ unconsolidated memories before running (prevents premature consolidation)
- First run waits 1 hour after deploy (prevents consolidating freshly-seeded data)
- Contradiction detection biases toward ADD — only supersedes on clear contradictions

### Multi-Project

Each memory is scoped to a `project` name. Projects are auto-created on first use. One service handles unlimited projects with full isolation.

### Without Gemini

Works without `GEMINI_API_KEY`. Falls back to:
- Regex-based entity extraction (capitalized words)
- Keyword-based topic detection
- Rule-based importance scoring
- No contradiction detection (all stores are ADD)
- No entity edge extraction from ingest

Less accurate, but zero cost and no external dependencies.

## Architecture

```
Client (Claude Code / Cursor / Agent / Dashboard)
  │
  POST /api/ingest ──→ Gemini Flash extracts memories + entity edges
  POST /api/store  ──→ Contradiction check → store/supersede/skip
  GET  /api/query  ──→ SQLite search, ranked, with optional entity graph
  GET  /api/context ─→ Scoped summary + entity graph for LLM prompts
  GET  /api/graph  ──→ Entity relationship graph (full or per-entity)
  │
  └──→ SQLite (memory.db)
         ├── memories (content, entities, topics, importance, summary_level)
         ├── entity_edges (subject, predicate, object, confidence)
         ├── consolidations (audit log)
         └── projects (auto-registered)
               │
               └──→ Background Consolidator (every 6h)
                      │
                      └──→ Progressive: L0→L1→L2→L3
                           Gemini Flash summarizes + extracts edges
                           Supersedes originals → keeps store lean
```

## Cost

| Component | Cost |
|-----------|------|
| Hosting | $5-10/mo (small always-on container) |
| Gemini Flash extraction | ~$0.01/day for typical usage |
| Gemini Flash consolidation | ~$0.005/day (runs every 6h) |
| Gemini Flash contradiction detection | ~$0.005/day |
| SQLite | Free (local file) |
| **Total** | **~$5-10/mo** |

Compare to re-discovering the same knowledge every conversation at $3-15/M tokens with Claude or GPT-4.

## License

MIT
