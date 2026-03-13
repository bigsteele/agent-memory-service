---
name: agent_memory
description: "When you need to remember something important, recall past knowledge, search your memory, get project context, review memory stats, or manage your long-term knowledge base."
---

# Agent Memory System

You have a persistent memory engine connected to a centralized memory service. It survives restarts and redeploys. All agents share the same service but memories are scoped by project — you only see your own.

**Script:** `/data/workspace/skills/memory/memory.py`
**Service:** Memory Service REST API (auto-configured via env vars)

## When to Store Memories

Store memories when you encounter information worth keeping:
- Key facts about clients, contacts, or projects
- Decisions made and their reasoning
- Lessons learned from mistakes or successes
- User preferences and working patterns
- Important dates, deadlines, or milestones
- Research findings or analysis conclusions

**DO NOT store:** trivial greetings, duplicate information, raw data dumps, or anything already in your skill docs.

## Memory Types

| Type | When to Use |
|------|-------------|
| `observation` | Something you noticed during a conversation or task |
| `fact` | A verified piece of information (a name, date, number, decision) |
| `reflection` | Your interpretation or inference about something |
| `summary` | A consolidated summary of multiple related memories |
| `episode` | A narrative of a conversation or sequence of events |
| `preference` | A user or business preference that should guide future behavior |

## Importance Scoring Guide

| Score | Meaning | Examples |
|-------|---------|----------|
| 0.9-1.0 | Critical | Client contract terms, security credentials, compliance rules |
| 0.7-0.8 | High | Key decisions, project deadlines, important preferences |
| 0.5-0.6 | Medium | Useful context, meeting notes, general observations |
| 0.3-0.4 | Low | Minor details, temporary context |
| 0.1-0.2 | Trivial | Might be useful someday, probably not |

## Commands

### Get Project Context (Start of Conversations)
```bash
cd /data/workspace/skills/memory && python3 memory.py --action context
```
Returns high-importance memories and summaries. **Use this at the start of important conversations** to load what you already know.

### Store a Memory
```bash
cd /data/workspace/skills/memory && python3 memory.py --action store \
  --content "Client Acme Corp prefers weekly status updates on Mondays" \
  --type preference \
  --source "conversation:thread_abc123" \
  --importance 0.7 \
  --entities "Acme Corp" \
  --topics "client-preferences,communication"
```
Always include: `--content`, `--type`, `--importance`.
Include `--entities` and `--topics` when relevant — they power search.

### Query Memories
```bash
cd /data/workspace/skills/memory && python3 memory.py --action query \
  --query "Acme Corp preferences" \
  --limit 10
```
Add `--type fact` or `--importance-above 0.7` to narrow results.

### Recall Specific Memory
```bash
cd /data/workspace/skills/memory && python3 memory.py --action recall --id 42
```

### View Recent Memories
```bash
cd /data/workspace/skills/memory && python3 memory.py --action recent --limit 20
```

### Memory Stats
```bash
cd /data/workspace/skills/memory && python3 memory.py --action stats
```

### Export All Memories
```bash
cd /data/workspace/skills/memory && python3 memory.py --action export --format json
cd /data/workspace/skills/memory && python3 memory.py --action export --format md
```

### Forget a Memory
```bash
cd /data/workspace/skills/memory && python3 memory.py --action forget --id 42
```

### Check Service Health
```bash
cd /data/workspace/skills/memory && python3 memory.py --action health
```

### Trigger Consolidation
```bash
cd /data/workspace/skills/memory && python3 memory.py --action consolidate
```

## Cross-Agent Memory

All agents share the same memory service. Each agent's memories are scoped by project name (set via `MEMORY_PROJECT` env var). This means:

- **Your memories are private** — other agents can't see them unless they use the same project name
- **Shared projects are possible** — if two agents use the same `MEMORY_PROJECT`, they share memories
- **Agent attribution** — every memory is tagged with which agent stored it (`AGENT_NAME` env var)

## Best Practices

1. **Load context first** — Run `--action context` at the start of important conversations
2. **Store as you go** — When you learn something important, store it immediately
3. **Be specific** — "Client wants weekly updates" > "had a meeting with client"
4. **Tag entities** — Always include people, companies, and project names in `--entities`
5. **Tag topics** — Use consistent topic tags for better search and consolidation
6. **Score honestly** — Not everything is importance 0.9. Most observations are 0.4-0.6
7. **Query before answering** — When asked about something you might know, query first
