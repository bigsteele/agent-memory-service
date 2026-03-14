# Agent Memory Service

Persistent AI memory for coding assistants and autonomous agents. Drop-in memory layer that works with Claude Code, Cursor, Windsurf, OpenAI Codex, or any LLM-powered tool.

Inspired by [Google's Always-On Memory Agent](https://github.com/GoogleCloudPlatform/generative-ai/tree/main/gemini/agents/always-on-memory-agent), rebuilt for production multi-project use.

## What It Does

Your AI assistant forgets everything between conversations. This fixes that.

- **Ingest** — Send raw conversation text. Gemini Flash extracts structured memories (entities, topics, importance) for pennies.
- **Store** — Persist facts, observations, decisions, and gotchas in SQLite.
- **Query** — Search across all memories by keyword, entity, topic, or importance.
- **Context** — One API call returns everything the AI needs to know, compressed and ranked.
- **Consolidate** — Background process merges related memories every 6 hours, keeping the store lean.

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

Now `/api/ingest` will use Gemini Flash ($0.15/M tokens) to extract structured memories from raw text instead of basic heuristics.

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

Send raw text. The service extracts structured memories using Gemini Flash.

```bash
curl -X POST http://localhost:3005/api/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "project": "my-app",
    "source": "conversation",
    "content": "We switched from Redis to in-memory caching because Redis was adding 500ms p99 latency. The team decided this was acceptable since our dataset fits in RAM."
  }'
```

Response:
```json
{
  "status": "ingested",
  "count": 2,
  "memories": [
    {"id": 1, "project": "my-app", "memory_type": "fact"},
    {"id": 2, "project": "my-app", "memory_type": "reflection"}
  ]
}
```

### `POST /api/store` — Direct Store

Store a pre-structured memory when you know exactly what to save.

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
    "source": "debug-session"
  }'
```

### `GET /api/query` — Search Memories

```bash
curl "http://localhost:3005/api/query?project=my-app&q=redis+performance&limit=5"
```

Results ranked by importance, then recency. Searches across content, summary, entities, and topics.

### `GET /api/context/:project` — LLM Context

Returns a compressed summary optimized for injecting into an LLM system prompt. One call, everything the AI needs.

```bash
curl http://localhost:3005/api/context/my-app
```

Returns:
- High-importance memories (importance >= 0.7)
- Recent consolidated summaries
- Recent facts
- Stats overview

### `GET /api/stats/:project` — Memory Stats

```bash
curl http://localhost:3005/api/stats/my-app
```

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

This gives Claude Code 7 MCP tools (`memory_context`, `memory_query`, `memory_store`, `memory_ingest`, `memory_recent`, `memory_stats`, `memory_forget`) with zero CLAUDE.md bloat. Tool descriptions are self-documenting.

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
Available via the `memory` MCP server (configured in `.mcp.json`). Use `memory_context` to load project knowledge, `memory_query` to search, `memory_store` to persist discoveries.
```

### Claude Code (CLAUDE.md Fallback)

If you can't use MCP, see [docs/CLAUDE-CODE-SETUP.md](docs/CLAUDE-CODE-SETUP.md) for curl-based CLAUDE.md instructions.

### Cursor / Windsurf / Other AI Editors

Add curl instructions to `.cursorrules`, `.windsurfrules`, or your editor's AI config file. See [docs/CLAUDE-CODE-SETUP.md](docs/CLAUDE-CODE-SETUP.md) — the format works for any editor.

### Autonomous Agents

Any agent with HTTP access can use the REST API directly. Store memories from agent conversations, query before taking actions, let consolidation handle cleanup.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3005` | HTTP server port |
| `MEMORY_DB_PATH` | `/data/memory.db` | SQLite file path |
| `GEMINI_API_KEY` | — | Google Gemini API key (enables smart extraction) |
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

### Consolidation

Every 6 hours (configurable), the service:
1. Finds unconsolidated memories (skips any with importance >= `IMPORTANCE_PROTECT`)
2. Clusters by shared entities or 2+ shared topics (max `MAX_CLUSTER_SIZE` per cluster)
3. Sends each cluster to Gemini Flash for summarization
4. Stores the summary as a new `summary` memory
5. Marks originals as superseded (soft-deleted, still queryable by ID)

**Safety guardrails:**
- High-importance memories (>= 0.85) are **never** consolidated — they stay as-is forever
- Clusters are capped at 8 memories to prevent mega-merges that lose detail
- No transitive expansion — only the seed memory's tags determine the cluster scope
- Requires 20+ unconsolidated memories before running (prevents premature consolidation)
- First run waits 1 hour after deploy (prevents consolidating freshly-seeded data)

### Multi-Project

Each memory is scoped to a `project` name. Projects are auto-created on first use. One service handles unlimited projects with full isolation.

### Without Gemini

Works without `GEMINI_API_KEY`. Falls back to:
- Regex-based entity extraction (capitalized words)
- Keyword-based topic detection
- Rule-based importance scoring

Less accurate, but zero cost and no external dependencies.

## Architecture

```
Client (Claude Code / Cursor / Agent / Dashboard)
  │
  POST /api/ingest ──→ Gemini Flash extracts structured memories
  POST /api/store  ──→ Direct structured storage
  GET  /api/query  ──→ SQLite keyword search, ranked by importance
  GET  /api/context ─→ Compressed summary for LLM system prompts
  │
  └──→ SQLite (memory.db on persistent volume)
         │
         └──→ Background Consolidator (every 6h)
                │
                └──→ Gemini Flash summarizes related memory clusters
                     Supersedes originals → keeps store lean
```

## Cost

| Component | Cost |
|-----------|------|
| Hosting | $5-10/mo (small always-on container) |
| Gemini Flash extraction | ~$0.01/day for typical usage |
| Gemini Flash consolidation | ~$0.005/day (runs every 6h) |
| SQLite | Free (local file) |
| **Total** | **~$5-10/mo** |

Compare to re-discovering the same knowledge every conversation at $3-15/M tokens with Claude or GPT-4.

## License

MIT
