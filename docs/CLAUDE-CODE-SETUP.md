## Project Memory System

This project uses a centralized memory service to persist knowledge across conversations. The memory service stores structured memories (facts, observations, decisions, gotchas) so that future conversations don't waste tokens rediscovering the same information.

### Connection

- **URL:** `https://memory-service-production.up.railway.app`
- **Project ID:** Use the repo/directory name in lowercase with hyphens (e.g., `my-saas-app`)
- **Auth:** Include `x-api-key: MEMORY_API_KEY_HERE` header if auth is enabled

### How Memory Works

The memory service stores structured memories with:
- **content** — the actual knowledge (1-2 sentences, concise)
- **memory_type** — `fact`, `observation`, `reflection`, `preference`, `episode`, or `summary`
- **importance** — 0.0 to 1.0 score (most things are 0.4-0.6, only critical items get 0.8+)
- **entities** — people, companies, services, tools mentioned
- **topics** — category tags for grouping (e.g., `deployment`, `auth`, `database`)
- **source** — where this came from (e.g., `claude-code`, `conversation`, `debug-session`)

A background process consolidates related memories every 6 hours using a cheap LLM (Gemini Flash), merging duplicates and creating summaries.

### When to Query Memory

**At the start of every conversation**, fetch project context:
```bash
curl -s "https://memory-service-production.up.railway.app/api/context/PROJECT_ID"
```
This returns high-importance memories + consolidated summaries in a single call. Read this before doing any work.

**Before working on unfamiliar code**, search for relevant knowledge:
```bash
curl -s "https://memory-service-production.up.railway.app/api/query?project=PROJECT_ID&q=SEARCH+TERMS&limit=5"
```

**Before debugging**, check if the issue has been seen before:
```bash
curl -s "https://memory-service-production.up.railway.app/api/query?project=PROJECT_ID&q=ERROR+KEYWORDS&limit=5"
```

### When to Store Memories

**STORE after:**
- Discovering a non-obvious pattern, gotcha, or workaround
- Making an architectural decision (store the decision AND the reasoning)
- Fixing a bug that took investigation (what caused it, what fixed it)
- Learning how an external service actually behaves (API quirks, rate limits, auth flows)
- Completing a significant feature or migration
- Getting corrected by the user on how they want things done

**Smart ingest** — send raw text and the service extracts structured memories automatically:
```bash
curl -s -X POST "https://memory-service-production.up.railway.app/api/ingest" \
  -H "Content-Type: application/json" \
  -d '{"project":"PROJECT_ID","source":"claude-code","content":"Describe what you learned in plain English. The service will extract entities, topics, and importance automatically."}'
```

**Direct store** — when you want to control the structure yourself:
```bash
curl -s -X POST "https://memory-service-production.up.railway.app/api/store" \
  -H "Content-Type: application/json" \
  -d '{
    "project": "PROJECT_ID",
    "content": "The specific fact or observation",
    "memory_type": "fact",
    "importance": 0.7,
    "entities": ["ServiceName", "PersonName"],
    "topics": ["deployment", "auth"],
    "source": "claude-code"
  }'
```

### DO NOT Store

- Code that's in the repo (that's what git is for)
- Trivial operations (ran npm install, created a file)
- Anything already documented in this CLAUDE.md
- Temporary debugging state that won't matter tomorrow
- File paths or line numbers (they change constantly)

### Memory Types

| Type | Use When | Example |
|------|----------|---------|
| `fact` | Verified, concrete information | "Supabase project uses ES256 JWT signing, not HS256" |
| `observation` | Pattern you noticed | "Deploys take ~4 min, CSS changes don't need full rebuild" |
| `reflection` | Your interpretation or lesson | "Auth failures always spike after cert rotation — check certs first" |
| `preference` | How the user/project wants things done | "Owner prefers shadcn/ui components, never installs new UI libraries" |
| `episode` | Narrative of what happened | "Migration failed on FK constraint, rolled back, added ON DELETE CASCADE, reran successfully" |

### Importance Guide

| Score | When | Example |
|-------|------|---------|
| 0.9-1.0 | Security, money, data loss risk | "Production DB credentials rotated on 2026-03-01" |
| 0.7-0.8 | Key decisions, integration patterns | "We chose Stripe over Paddle because of multi-currency support" |
| 0.5-0.6 | Useful context, normal findings | "The CI pipeline runs ESLint before tests" |
| 0.3-0.4 | Minor details | "Logo SVG is in public/assets, not src/assets" |
| 0.1-0.2 | Trivial, might help someday | "The original repo was forked from a template" |

### Other Endpoints

```bash
# Get memory stats
curl -s "https://memory-service-production.up.railway.app/api/stats/PROJECT_ID"

# Get recent memories
curl -s "https://memory-service-production.up.railway.app/api/recent/PROJECT_ID?limit=20"

# Forget a memory
curl -s -X DELETE "https://memory-service-production.up.railway.app/api/forget/MEMORY_ID"

# Manually trigger consolidation
curl -s -X POST "https://memory-service-production.up.railway.app/api/consolidate" \
  -H "Content-Type: application/json" \
  -d '{"project":"PROJECT_ID"}'

# List all projects
curl -s "https://memory-service-production.up.railway.app/api/projects"
```
