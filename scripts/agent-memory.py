#!/usr/bin/env python3
"""Agent memory client — connects to centralized memory service.

Single-file CLI using only stdlib (urllib, json, argparse). No pip installs.
Calls the Memory Service REST API instead of local SQLite.

Usage:
    python3 memory.py --action store --content "..." --type fact --importance 0.8
    python3 memory.py --action query --query "client preferences"
    python3 memory.py --action recall --id 42
    python3 memory.py --action recent
    python3 memory.py --action stats
    python3 memory.py --action forget --id 42
    python3 memory.py --action context
    python3 memory.py --action export
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.error
import urllib.parse

# ─── Config ──────────────────────────────────────────────────────────────────

MEMORY_URL = os.environ.get("MEMORY_SERVICE_URL", "https://memory-service-production-737e.up.railway.app")

# Derive agent name from AGENT_NAME, MEMORY_PROJECT, or RAILWAY_SERVICE_NAME
def _get_agent_name():
    name = os.environ.get("AGENT_NAME") or os.environ.get("RAILWAY_SERVICE_NAME", "system")
    # Strip emoji and whitespace from Railway service names like "Intel 🧠"
    import re
    return re.sub(r'[^\w-]', '', name.split()[0]).lower() if name else "system"

MEMORY_AGENT = _get_agent_name()
MEMORY_PROJECT = os.environ.get("MEMORY_PROJECT", f"together-{MEMORY_AGENT}")
API_KEY = os.environ.get("MEMORY_API_KEY", "")

# ─── HTTP helpers ────────────────────────────────────────────────────────────

def api_get(path, params=None):
    """GET request to memory service."""
    url = f"{MEMORY_URL}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url)
    if API_KEY:
        req.add_header("x-api-key", API_KEY)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode() if e.fp else str(e)
        return {"error": f"HTTP {e.code}: {body}"}
    except urllib.error.URLError as e:
        return {"error": f"Connection failed: {e.reason}"}


def api_post(path, data):
    """POST request to memory service."""
    url = f"{MEMORY_URL}{path}"
    body = json.dumps(data).encode()
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    if API_KEY:
        req.add_header("x-api-key", API_KEY)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode() if e.fp else str(e)
        return {"error": f"HTTP {e.code}: {body}"}
    except urllib.error.URLError as e:
        return {"error": f"Connection failed: {e.reason}"}


def api_delete(path):
    """DELETE request to memory service."""
    url = f"{MEMORY_URL}{path}"
    req = urllib.request.Request(url, method="DELETE")
    if API_KEY:
        req.add_header("x-api-key", API_KEY)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode() if e.fp else str(e)
        return {"error": f"HTTP {e.code}: {body}"}
    except urllib.error.URLError as e:
        return {"error": f"Connection failed: {e.reason}"}


# ─── Actions ─────────────────────────────────────────────────────────────────

def action_store(args):
    """Store a new memory."""
    if not args.content:
        return error("--content is required")

    entities = args.entities.split(",") if args.entities else []
    topics = args.topics.split(",") if args.topics else []

    result = api_post("/api/store", {
        "project": MEMORY_PROJECT,
        "agent": MEMORY_AGENT,
        "content": args.content,
        "memory_type": args.type or "observation",
        "source": args.source or f"agent:{MEMORY_AGENT}",
        "summary": args.summary,
        "entities": entities,
        "topics": topics,
        "importance": args.importance if args.importance is not None else 0.5,
    })
    output(result)


def action_query(args):
    """Search memories by keyword."""
    if not args.query:
        return error("--query is required")

    params = {
        "project": MEMORY_PROJECT,
        "q": args.query,
        "limit": args.limit or 10,
    }
    if args.type:
        params["type"] = args.type
    if args.importance_above:
        params["importance_above"] = args.importance_above
    if args.agent_filter:
        params["agent"] = args.agent_filter

    result = api_get("/api/query", params)
    output(result)


def action_recall(args):
    """Retrieve a specific memory by ID."""
    if not args.id:
        return error("--id is required")
    result = api_get(f"/api/recall/{args.id}")
    output(result)


def action_recent(args):
    """Show most recent memories."""
    params = {}
    if args.limit:
        params["limit"] = args.limit
    result = api_get(f"/api/recent/{MEMORY_PROJECT}", params)
    output(result)


def action_stats(args):
    """Show memory statistics."""
    result = api_get(f"/api/stats/{MEMORY_PROJECT}")
    output(result)


def action_context(args):
    """Get full project context (high-importance memories + summaries)."""
    result = api_get(f"/api/context/{MEMORY_PROJECT}")
    output(result)


def action_forget(args):
    """Soft-delete a memory."""
    if not args.id:
        return error("--id is required")
    result = api_delete(f"/api/forget/{args.id}")
    output(result)


def action_export(args):
    """Export all active memories."""
    result = api_get(f"/api/recent/{MEMORY_PROJECT}", {"limit": 1000})

    if args.format == "md" and "memories" in result:
        lines = [f"# Agent Memory Export — {MEMORY_PROJECT}\n"]
        lines.append(f"Total: {result.get('count', 0)}\n")
        for m in result["memories"]:
            lines.append(f"## #{m['id']} [{m.get('memory_type', '?')}] (importance: {m.get('importance', '?')})")
            lines.append(f"{m.get('content', '')}\n")
            if m.get("entities"):
                lines.append(f"Entities: {', '.join(m['entities'])}")
            lines.append("---\n")
        print("\n".join(lines))
    else:
        output(result)


def action_consolidate(args):
    """Trigger consolidation on the memory service."""
    result = api_post("/api/consolidate", {"project": MEMORY_PROJECT})
    output(result)


def action_health(args):
    """Check memory service health."""
    result = api_get("/health")
    output(result)


# ─── Helpers ─────────────────────────────────────────────────────────────────

def output(data):
    print(json.dumps(data, indent=2))


def error(msg):
    print(json.dumps({"error": msg}), file=sys.stderr)
    sys.exit(1)


# ─── CLI ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Agent memory client — centralized memory service")
    parser.add_argument("--action", required=True,
                        choices=["store", "query", "recall", "recent", "stats",
                                 "context", "forget", "export", "consolidate", "health"],
                        help="Action to perform")

    # Store args
    parser.add_argument("--content", help="Memory content text")
    parser.add_argument("--type", help="Memory type: observation, fact, reflection, summary, episode, preference")
    parser.add_argument("--source", help="Source identifier")
    parser.add_argument("--summary", help="One-line summary")
    parser.add_argument("--entities", help="Comma-separated entity names")
    parser.add_argument("--topics", help="Comma-separated topic tags")
    parser.add_argument("--importance", type=float, help="Importance 0.0-1.0")

    # Query args
    parser.add_argument("--query", help="Search query keywords")
    parser.add_argument("--importance-above", type=float, dest="importance_above", help="Min importance filter")
    parser.add_argument("--agent-filter", dest="agent_filter", help="Filter by agent name")

    # Common args
    parser.add_argument("--id", type=int, help="Memory ID")
    parser.add_argument("--limit", type=int, help="Max results")
    parser.add_argument("--format", choices=["json", "md"], help="Export format")

    args = parser.parse_args()

    actions = {
        "store": action_store,
        "query": action_query,
        "recall": action_recall,
        "recent": action_recent,
        "stats": action_stats,
        "context": action_context,
        "forget": action_forget,
        "export": action_export,
        "consolidate": action_consolidate,
        "health": action_health,
    }

    actions[args.action](args)


if __name__ == "__main__":
    main()
