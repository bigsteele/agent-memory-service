#!/usr/bin/env node
/**
 * MCP Server for Agent Memory Service (v2.0).
 *
 * Exposes memory operations as MCP tools so Claude Code, GSD subagents,
 * and Ralph Loops can use memory without curl commands or CLAUDE.md instructions.
 *
 * v2.0 features: scoped context (topics filter), entity graph, contradiction
 * detection on store, include_graph on query.
 *
 * Usage in .mcp.json:
 *   {
 *     "mcpServers": {
 *       "memory": {
 *         "command": "node",
 *         "args": ["/path/to/agent-memory-service/mcp-server.js"],
 *         "env": {
 *           "MEMORY_SERVICE_URL": "https://your-memory-service.example.com",
 *           "MEMORY_PROJECT": "my-project",
 *           "MEMORY_API_KEY": ""
 *         }
 *       }
 *     }
 *   }
 */

const http = require('http');
const https = require('https');

const SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://localhost:3005';
const DEFAULT_PROJECT = process.env.MEMORY_PROJECT || '';
const API_KEY = process.env.MEMORY_API_KEY || '';

// ─── HTTP helpers ───────────────────────────────────────────────────────────

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, SERVICE_URL);
    const mod = url.protocol === 'https:' ? https : http;
    const headers = { 'Content-Type': 'application/json' };
    if (API_KEY) headers['x-api-key'] = API_KEY;

    const payload = body ? JSON.stringify(body) : null;
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

    const req = mod.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ raw: data });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── Tool definitions ───────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'memory_context',
    description: 'Get compressed project context (high-importance memories + summaries + entity graph). Call at start of work to load what the project already knows. Supports topic scoping to get only relevant context (e.g., topics: ["auth", "database"]).',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name (defaults to MEMORY_PROJECT env var)' },
        topics: { type: 'array', items: { type: 'string' }, description: 'Optional topic filter — only return memories tagged with these topics. Reduces context size for focused work.' },
      },
    },
  },
  {
    name: 'memory_query',
    description: 'Search memories by keyword. Use before working on unfamiliar code or debugging to check if the issue has been seen before. Set include_graph=true to also get entity relationships.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Search keywords' },
        project: { type: 'string', description: 'Project name (defaults to MEMORY_PROJECT env var)' },
        limit: { type: 'number', description: 'Max results (default 5)' },
        topics: { type: 'array', items: { type: 'string' }, description: 'Filter by topic tags' },
        include_graph: { type: 'boolean', description: 'Include entity relationship edges for matched entities' },
      },
      required: ['q'],
    },
  },
  {
    name: 'memory_store',
    description: 'Store a structured memory with automatic contradiction detection. If the new memory contradicts an existing one, the old memory is automatically superseded. If it duplicates an existing memory, storage is skipped (NOOP). Keep content to 1-2 concise sentences.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The knowledge to remember (1-2 sentences)' },
        memory_type: { type: 'string', enum: ['fact', 'observation', 'reflection', 'preference', 'episode'], description: 'Type of memory' },
        importance: { type: 'number', description: '0.0-1.0. Most things 0.5-0.6, key decisions 0.7-0.8, critical/security 0.9+' },
        project: { type: 'string', description: 'Project name (defaults to MEMORY_PROJECT env var)' },
        entities: { type: 'array', items: { type: 'string' }, description: 'People, services, tools mentioned' },
        topics: { type: 'array', items: { type: 'string' }, description: 'Category tags (e.g., deployment, auth, database)' },
        edges: { type: 'array', items: { type: 'object', properties: { subject: { type: 'string' }, predicate: { type: 'string' }, object: { type: 'string' } } }, description: 'Entity relationships (e.g., {subject: "Supabase", predicate: "uses", object: "ES256"})' },
      },
      required: ['content', 'memory_type', 'importance'],
    },
  },
  {
    name: 'memory_ingest',
    description: 'Send raw text for smart extraction. The service uses Gemini Flash to extract structured memories and entity relationships automatically. Good for ingesting conversation summaries or debug session notes.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Raw text to extract memories from' },
        project: { type: 'string', description: 'Project name (defaults to MEMORY_PROJECT env var)' },
        source: { type: 'string', description: 'Where this came from (e.g., claude-code, debug-session)' },
      },
      required: ['content'],
    },
  },
  {
    name: 'memory_recent',
    description: 'Get recent memories for a project. Useful to see what was recently stored.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name (defaults to MEMORY_PROJECT env var)' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
    },
  },
  {
    name: 'memory_stats',
    description: 'Get memory store statistics for a project, including entity edge count and consolidation status.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name (defaults to MEMORY_PROJECT env var)' },
      },
    },
  },
  {
    name: 'memory_forget',
    description: 'Delete a specific memory by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Memory ID to delete' },
      },
      required: ['id'],
    },
  },
  {
    name: 'memory_graph',
    description: 'Get entity relationship graph for the project or a specific entity. Returns subject-predicate-object triples showing how entities relate (e.g., "Supabase uses ES256", "chat-relay depends-on Supabase SDK").',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name (defaults to MEMORY_PROJECT env var)' },
        entity: { type: 'string', description: 'Optional — get edges for a specific entity. If omitted, returns the full project graph.' },
        limit: { type: 'number', description: 'Max edges to return (default 50)' },
      },
    },
  },
];

// ─── Tool execution ─────────────────────────────────────────────────────────

async function executeTool(name, args) {
  const project = args.project || DEFAULT_PROJECT;

  switch (name) {
    case 'memory_context': {
      if (!project) return { error: 'No project specified. Set MEMORY_PROJECT env var or pass project parameter.' };
      let path = `/api/context/${encodeURIComponent(project)}`;
      if (args.topics && args.topics.length) {
        path += `?topics=${args.topics.map(encodeURIComponent).join(',')}`;
      }
      return await request('GET', path);
    }

    case 'memory_query': {
      const params = new URLSearchParams({ q: args.q, limit: String(args.limit || 5) });
      if (project) params.set('project', project);
      if (args.topics && args.topics.length) params.set('topics', args.topics.join(','));
      if (args.include_graph) params.set('include_graph', 'true');
      return await request('GET', `/api/query?${params}`);
    }

    case 'memory_store': {
      if (!project) return { error: 'No project specified. Set MEMORY_PROJECT env var or pass project parameter.' };
      return await request('POST', '/api/store', {
        project,
        content: args.content,
        memory_type: args.memory_type,
        importance: args.importance,
        entities: args.entities || [],
        topics: args.topics || [],
        edges: args.edges || [],
        source: 'claude-code-mcp',
      });
    }

    case 'memory_ingest': {
      if (!project) return { error: 'No project specified. Set MEMORY_PROJECT env var or pass project parameter.' };
      return await request('POST', '/api/ingest', {
        project,
        content: args.content,
        source: args.source || 'claude-code-mcp',
      });
    }

    case 'memory_recent': {
      if (!project) return { error: 'No project specified. Set MEMORY_PROJECT env var or pass project parameter.' };
      const limit = args.limit || 10;
      return await request('GET', `/api/recent/${encodeURIComponent(project)}?limit=${limit}`);
    }

    case 'memory_stats': {
      if (!project) return { error: 'No project specified. Set MEMORY_PROJECT env var or pass project parameter.' };
      return await request('GET', `/api/stats/${encodeURIComponent(project)}`);
    }

    case 'memory_forget': {
      return await request('DELETE', `/api/forget/${args.id}`);
    }

    case 'memory_graph': {
      if (!project) return { error: 'No project specified. Set MEMORY_PROJECT env var or pass project parameter.' };
      if (args.entity) {
        return await request('GET', `/api/graph/${encodeURIComponent(project)}/${encodeURIComponent(args.entity)}`);
      }
      const limit = args.limit || 50;
      return await request('GET', `/api/graph/${encodeURIComponent(project)}?limit=${limit}`);
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ─── MCP stdio transport ────────────────────────────────────────────────────

let buffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;

  // MCP uses newline-delimited JSON over stdio
  let newlineIdx;
  while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newlineIdx).trim();
    buffer = buffer.slice(newlineIdx + 1);
    if (line) handleMessage(line);
  }
});

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handleMessage(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // ignore malformed
  }

  const { jsonrpc, id, method, params } = msg;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: {
          name: 'agent-memory-service',
          version: '2.0.0',
        },
      },
    });
    return;
  }

  if (method === 'notifications/initialized') {
    return; // no response needed
  }

  if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: { tools: TOOLS },
    });
    return;
  }

  if (method === 'tools/call') {
    const toolName = params.name;
    const toolArgs = params.arguments || {};

    try {
      const result = await executeTool(toolName, toolArgs);
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        },
      });
    } catch (err) {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true,
        },
      });
    }
    return;
  }

  // Unknown method — respond with error
  if (id !== undefined) {
    send({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }
}

process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
