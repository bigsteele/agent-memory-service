#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Connect any project to your Agent Memory Service
#
# Run from the ROOT of the project you want to connect:
#   bash /path/to/agent-memory-service/scripts/connect-project.sh https://your-memory-service.com
#
# Or pipe from URL:
#   curl -s https://raw.githubusercontent.com/bigsteele/agent-memory-service/main/scripts/connect-project.sh | bash -s -- https://your-memory-service.com
#
# What this does:
#   1. Detects project name from the current directory
#   2. Tests connection to the memory service
#   3. Registers the project
#   4. Adds MCP server config to .mcp.json (zero CLAUDE.md bloat)
#   5. Optionally adds CLAUDE.md curl fallback (--with-claude-md)
# ─────────────────────────────────────────────────────────────────────────────

set -e

MEMORY_URL="${1:-$MEMORY_SERVICE_URL}"
API_KEY="${2:-$MEMORY_API_KEY}"
MCP_SERVER_PATH="${AGENT_MEMORY_SERVICE_PATH:-}"
WITH_CLAUDE_MD=false

# Parse flags
for arg in "$@"; do
    case $arg in
        --with-claude-md) WITH_CLAUDE_MD=true ;;
        --mcp-path=*) MCP_SERVER_PATH="${arg#*=}" ;;
    esac
done

if [ -z "$MEMORY_URL" ]; then
    echo "Usage: connect-project.sh <MEMORY_SERVICE_URL> [API_KEY] [--with-claude-md] [--mcp-path=/path/to/mcp-server.js]"
    echo ""
    echo "Connects your project to the memory service via MCP (recommended) or CLAUDE.md (fallback)."
    echo ""
    echo "Examples:"
    echo "  bash connect-project.sh https://your-memory-service.example.com"
    echo "  bash connect-project.sh https://your-memory-service.example.com my-api-key"
    echo "  bash connect-project.sh https://your-memory-service.example.com --with-claude-md"
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

# ─── MCP Setup ───────────────────────────────────────────────────────────────

# Find mcp-server.js — check common locations
if [ -z "$MCP_SERVER_PATH" ]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    if [ -f "$SCRIPT_DIR/mcp-server.js" ]; then
        MCP_SERVER_PATH="$SCRIPT_DIR/mcp-server.js"
    elif [ -f "$HOME/agent-memory-service/mcp-server.js" ]; then
        MCP_SERVER_PATH="$HOME/agent-memory-service/mcp-server.js"
    fi
fi

if [ -n "$MCP_SERVER_PATH" ] && [ -f "$MCP_SERVER_PATH" ]; then
    echo -n "Setting up MCP server... "

    # Build the MCP server entry
    MCP_ENV="{\"MEMORY_SERVICE_URL\": \"${MEMORY_URL}\", \"MEMORY_PROJECT\": \"${PROJECT_ID}\""
    if [ -n "$API_KEY" ]; then
        MCP_ENV="$MCP_ENV, \"MEMORY_API_KEY\": \"${API_KEY}\""
    fi
    MCP_ENV="$MCP_ENV}"

    MCP_ENTRY="{\"command\": \"node\", \"args\": [\"${MCP_SERVER_PATH}\"], \"env\": ${MCP_ENV}}"

    if [ -f .mcp.json ]; then
        # Merge into existing .mcp.json
        if command -v node &> /dev/null; then
            node -e "
                const fs = require('fs');
                const cfg = JSON.parse(fs.readFileSync('.mcp.json', 'utf8'));
                cfg.mcpServers = cfg.mcpServers || {};
                cfg.mcpServers.memory = ${MCP_ENTRY};
                fs.writeFileSync('.mcp.json', JSON.stringify(cfg, null, 2) + '\n');
            "
        else
            # Fallback: use python
            python3 -c "
import json
cfg = json.load(open('.mcp.json'))
cfg.setdefault('mcpServers', {})['memory'] = json.loads('${MCP_ENTRY}')
json.dump(cfg, open('.mcp.json', 'w'), indent=2)
"
        fi
    else
        # Create new .mcp.json
        echo "{\"mcpServers\": {\"memory\": ${MCP_ENTRY}}}" | node -e "
            process.stdin.setEncoding('utf8');
            let d=''; process.stdin.on('data',c=>d+=c);
            process.stdin.on('end',()=>{
                require('fs').writeFileSync('.mcp.json', JSON.stringify(JSON.parse(d), null, 2) + '\n');
            });
        " 2>/dev/null || echo "{\"mcpServers\": {\"memory\": ${MCP_ENTRY}}}" > .mcp.json
    fi

    echo "OK"
    echo "  Added 'memory' MCP server to .mcp.json"
    echo "  Tools: memory_context, memory_query, memory_store, memory_ingest, memory_recent, memory_stats, memory_forget, memory_graph"
    echo ""
    echo "  Claude Code, GSD subagents, and Ralph Loops will automatically have access."
    echo "  No CLAUDE.md instructions needed — tool descriptions are self-documenting."
else
    echo ""
    echo "WARNING: Could not find mcp-server.js"
    echo "  Clone the repo and pass the path:"
    echo "    --mcp-path=/path/to/agent-memory-service/mcp-server.js"
    echo ""
    echo "  Or set AGENT_MEMORY_SERVICE_PATH env var."
    echo ""
    WITH_CLAUDE_MD=true
    echo "Falling back to CLAUDE.md setup..."
fi

# ─── Optional CLAUDE.md fallback ─────────────────────────────────────────────

if [ "$WITH_CLAUDE_MD" = true ]; then
    MEMORY_BLOCK="
## Project Memory

Memory service at \`${MEMORY_URL}\` — project: \`${PROJECT_ID}\`

**Load context at start:** \`curl -s \"${MEMORY_URL}/api/context/${PROJECT_ID}\"\`

**Search:** \`curl -s \"${MEMORY_URL}/api/query?project=${PROJECT_ID}&q=KEYWORDS\"\`

**Store:** \`curl -s -X POST \"${MEMORY_URL}/api/store\" -H \"Content-Type: application/json\" -d '{\"project\":\"${PROJECT_ID}\",\"content\":\"WHAT\",\"memory_type\":\"fact\",\"importance\":0.7,\"source\":\"claude-code\"}'\`
"

    if [ -f CLAUDE.md ]; then
        if grep -q "Project Memory" CLAUDE.md; then
            echo "CLAUDE.md already has memory section (skipped)"
        else
            echo "$MEMORY_BLOCK" >> CLAUDE.md
            echo "Updated CLAUDE.md with memory section"
        fi
    else
        echo "$MEMORY_BLOCK" > CLAUDE.md
        echo "Created CLAUDE.md with memory section"
    fi
fi

# Add .mcp.json to gitignore if not already tracked
if [ -f .gitignore ]; then
    if ! grep -qF ".mcp.json" .gitignore && ! git ls-files --error-unmatch .mcp.json 2>/dev/null; then
        echo "" >> .gitignore
        echo "# MCP server config (contains service URLs)" >> .gitignore
        echo ".mcp.json" >> .gitignore
    fi
fi

echo ""
echo "Done! Memory service connected for project '${PROJECT_ID}'."
echo ""
echo "Test it:"
echo "  curl -s \"${MEMORY_URL}/api/stats/${PROJECT_ID}\""
echo ""
