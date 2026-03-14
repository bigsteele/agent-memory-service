# Claude Code Setup

Two ways to connect: **MCP (recommended)** or **CLAUDE.md curl fallback**.

---

## Option 1: MCP Server (Recommended)

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/path/to/agent-memory-service/mcp-server.js"],
      "env": {
        "MEMORY_SERVICE_URL": "https://your-memory-service.example.com",
        "MEMORY_PROJECT": "your-project-name",
        "MEMORY_API_KEY": ""
      }
    }
  }
}
```

Then add one line to CLAUDE.md (optional):

```markdown
## Memory Service
Available via the `memory` MCP server (configured in `.mcp.json`). Use `memory_context` to load project knowledge, `memory_query` to search, `memory_store` to persist discoveries.
```

**That's it.** Claude Code gets 7 tools automatically:
- `memory_context` — load project knowledge at start of work
- `memory_query` — search before working on unfamiliar code
- `memory_store` — save discoveries (facts, observations, preferences)
- `memory_ingest` — send raw text for smart extraction via Gemini
- `memory_recent` — see what was recently stored
- `memory_stats` — memory store statistics
- `memory_forget` — delete a specific memory

**Why MCP over curl?**
- No CLAUDE.md bloat (curl instructions eat ~500 tokens per conversation)
- GSD subagents automatically inherit MCP tools
- Ralph Loops don't waste tokens on memory management
- Tool schemas are self-documenting

---

## Option 2: CLAUDE.md Curl Fallback

If you can't use MCP, add this block to your project's `CLAUDE.md`. Replace `YOUR_URL` and `PROJECT_ID`:

```markdown
## Project Memory

Memory service at `YOUR_URL` — project: `PROJECT_ID`

**Load context at start:** `curl -s "YOUR_URL/api/context/PROJECT_ID"`

**Search:** `curl -s "YOUR_URL/api/query?project=PROJECT_ID&q=KEYWORDS"`

**Store:**
\`\`\`bash
curl -s -X POST "YOUR_URL/api/store" \
  -H "Content-Type: application/json" \
  -d '{"project":"PROJECT_ID","content":"WHAT YOU LEARNED","memory_type":"fact","importance":0.7,"source":"claude-code"}'
\`\`\`

**Smart ingest (auto-extract via Gemini):**
\`\`\`bash
curl -s -X POST "YOUR_URL/api/ingest" \
  -H "Content-Type: application/json" \
  -d '{"project":"PROJECT_ID","source":"claude-code","content":"Raw text describing what you learned"}'
\`\`\`
```

### When to Store
- Non-obvious patterns, gotchas, workarounds
- Architectural decisions and their reasoning
- Bug fixes that required investigation
- External service behavior (API quirks, rate limits)
- User preferences and corrections

### When NOT to Store
- Code already in the repo (that's what git is for)
- Trivial operations (ran npm install, created a file)
- Anything already in CLAUDE.md
- Temporary debugging state
- File paths or line numbers (they change)

### Memory Types

| Type | Use When | Example |
|------|----------|---------|
| `fact` | Verified info | "Supabase uses ES256 JWT signing" |
| `observation` | Pattern noticed | "Deploys take ~4 min, CSS doesn't need full rebuild" |
| `reflection` | Lesson learned | "Auth failures spike after cert rotation — check certs first" |
| `preference` | How user wants things done | "Owner prefers shadcn/ui, never install new UI libs" |
| `episode` | What happened | "Migration failed on FK, rolled back, added CASCADE, reran" |

### Importance Guide

| Score | When |
|-------|------|
| 0.9-1.0 | Security, money, data loss risk |
| 0.7-0.8 | Key decisions, integration patterns |
| 0.5-0.6 | Useful context, normal findings |
| 0.3-0.4 | Minor details |

---

## Using the Connect Script

The fastest way — auto-detects project name, tests connection, sets up MCP:

```bash
bash /path/to/agent-memory-service/scripts/connect-project.sh https://your-memory-service.example.com
```

Add `--with-claude-md` flag to also add curl instructions to CLAUDE.md.
