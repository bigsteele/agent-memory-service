#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Connect any project to your Agent Memory Service
#
# Run from the ROOT of the project you want to connect:
#   bash /path/to/connect-project.sh https://your-memory-service.com
#
# Or pipe from URL:
#   curl -s https://raw.githubusercontent.com/YOUR_ORG/agent-memory-service/main/scripts/connect-project.sh | bash -s -- https://your-memory-service.com
#
# What this does:
#   1. Detects project name from the current directory
#   2. Tests connection to the memory service
#   3. Registers the project
#   4. Appends memory instructions to CLAUDE.md (and .cursorrules if present)
#   5. Creates .claude/memory-config.env (gitignored)
# ─────────────────────────────────────────────────────────────────────────────

set -e

MEMORY_URL="${1:-$MEMORY_SERVICE_URL}"
API_KEY="${2:-$MEMORY_API_KEY}"

if [ -z "$MEMORY_URL" ]; then
    echo "Usage: connect-project.sh <MEMORY_SERVICE_URL> [API_KEY]"
    echo ""
    echo "Example:"
    echo "  bash connect-project.sh https://memory-service-production.up.railway.app"
    echo "  bash connect-project.sh https://memory-service-production.up.railway.app my-api-key"
    exit 1
fi

# Strip trailing slash
MEMORY_URL="${MEMORY_URL%/}"

# Detect project name
PROJECT_ID=$(basename "$(pwd)" | tr '[:upper:]' '[:lower:]' | tr ' .' '-' | tr -cd 'a-z0-9-')
echo "Project: $PROJECT_ID"
echo "Service: $MEMORY_URL"

# Test connection
echo -n "Testing connection... "
HEALTH=$(curl -s "$MEMORY_URL/health" 2>/dev/null || echo "")
if echo "$HEALTH" | grep -q '"status":"ok"'; then
    echo "OK"
else
    echo "FAILED"
    echo "Could not reach $MEMORY_URL/health"
    echo "Make sure the memory service is running."
    exit 1
fi

# Register project
echo -n "Registering project... "
AUTH_HEADER=""
if [ -n "$API_KEY" ]; then
    AUTH_HEADER="-H x-api-key:${API_KEY}"
fi

curl -s -X POST "$MEMORY_URL/api/store" \
  -H "Content-Type: application/json" \
  $AUTH_HEADER \
  -d "{\"project\":\"${PROJECT_ID}\",\"content\":\"Project registered: $(basename $(pwd))\",\"memory_type\":\"fact\",\"importance\":0.2,\"source\":\"setup\",\"topics\":[\"project-setup\"]}" > /dev/null 2>&1
echo "OK"

# Save config
mkdir -p .claude
cat > .claude/memory-config.env << EOF
MEMORY_SERVICE_URL=${MEMORY_URL}
MEMORY_API_KEY=${API_KEY}
PROJECT_ID=${PROJECT_ID}
EOF
echo "Created .claude/memory-config.env"

# Add to gitignore
if [ -f .gitignore ]; then
    if ! grep -qF "memory-config.env" .gitignore; then
        echo ".claude/memory-config.env" >> .gitignore
    fi
else
    echo ".claude/memory-config.env" > .gitignore
fi

# Generate the CLAUDE.md memory block
MEMORY_BLOCK="
## Project Memory

This project uses a memory service for persistent knowledge across conversations.
Project ID: \`${PROJECT_ID}\`

**IMPORTANT: At the start of each conversation, load project context:**
\`\`\`bash
curl -s \"${MEMORY_URL}/api/context/${PROJECT_ID}\"${API_KEY:+ -H \"x-api-key: ${API_KEY}\"}
\`\`\`

**Search before working on unfamiliar areas:**
\`\`\`bash
curl -s \"${MEMORY_URL}/api/query?project=${PROJECT_ID}&q=SEARCH+TERMS&limit=5\"${API_KEY:+ -H \"x-api-key: ${API_KEY}\"}
\`\`\`

**Store discoveries after learning something non-obvious:**
\`\`\`bash
curl -s -X POST \"${MEMORY_URL}/api/ingest\" \\
  -H \"Content-Type: application/json\"${API_KEY:+ \\
  -H \"x-api-key: ${API_KEY}\"} \\
  -d '{\"project\":\"${PROJECT_ID}\",\"source\":\"claude-code\",\"content\":\"DESCRIBE WHAT YOU LEARNED\"}'
\`\`\`

**Direct store for structured facts:**
\`\`\`bash
curl -s -X POST \"${MEMORY_URL}/api/store\" \\
  -H \"Content-Type: application/json\"${API_KEY:+ \\
  -H \"x-api-key: ${API_KEY}\"} \\
  -d '{\"project\":\"${PROJECT_ID}\",\"content\":\"THE FACT\",\"memory_type\":\"fact\",\"importance\":0.7,\"entities\":[\"Entity\"],\"topics\":[\"topic\"],\"source\":\"claude-code\"}'
\`\`\`

### When to Store
- Non-obvious patterns, gotchas, workarounds
- Architectural decisions and their reasoning
- Bug fixes that required investigation
- External service behavior (API quirks, rate limits)
- User preferences and corrections

### When NOT to Store
- Code already in the repo
- Trivial operations
- Anything in CLAUDE.md
- Temporary debugging state

### Memory Types & Importance
| Type | When | Importance |
|------|------|------------|
| \`fact\` | Verified info | 0.5-0.9 |
| \`observation\` | Noticed pattern | 0.4-0.6 |
| \`reflection\` | Lesson learned | 0.5-0.7 |
| \`preference\` | How user wants things done | 0.6-0.8 |
| \`episode\` | What happened narrative | 0.4-0.6 |

### Other Commands
\`\`\`bash
# Stats
curl -s \"${MEMORY_URL}/api/stats/${PROJECT_ID}\"
# Recent
curl -s \"${MEMORY_URL}/api/recent/${PROJECT_ID}?limit=20\"
# Forget
curl -s -X DELETE \"${MEMORY_URL}/api/forget/MEMORY_ID\"
# Consolidate
curl -s -X POST \"${MEMORY_URL}/api/consolidate\" -H \"Content-Type: application/json\" -d '{\"project\":\"${PROJECT_ID}\"}'
\`\`\`
"

# Append to CLAUDE.md
if [ -f CLAUDE.md ]; then
    if grep -q "Project Memory" CLAUDE.md; then
        echo "CLAUDE.md already has memory section (skipped)"
    else
        echo "$MEMORY_BLOCK" >> CLAUDE.md
        echo "Updated CLAUDE.md"
    fi
else
    echo "$MEMORY_BLOCK" > CLAUDE.md
    echo "Created CLAUDE.md"
fi

# Also update .cursorrules if it exists
if [ -f .cursorrules ]; then
    if ! grep -q "Project Memory" .cursorrules; then
        echo "$MEMORY_BLOCK" >> .cursorrules
        echo "Updated .cursorrules"
    fi
fi

echo ""
echo "Done! Memory service connected for project '${PROJECT_ID}'."
echo ""
echo "Test it:"
echo "  curl -s \"${MEMORY_URL}/api/stats/${PROJECT_ID}\""
echo ""
