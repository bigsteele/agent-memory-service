/**
 * Memory Service — Always-on REST API for multi-project AI memory.
 *
 * Stores structured memories in SQLite, extracts metadata via Gemini Flash,
 * runs background consolidation, and serves context to Claude Code + agents.
 *
 * v2.0 features: entity graph, temporal invalidation, scoped context,
 * progressive summarization, contradiction detection.
 */

const express = require('express');
const cors = require('cors');
const memoryDb = require('./db');
const extractor = require('./extractor');
const consolidator = require('./consolidator');

const app = express();
const PORT = parseInt(process.env.PORT) || 3005;
const API_KEY = process.env.MEMORY_API_KEY;

// ─── Middleware ──────────────────────────────────────────────────────────────

app.use(cors({ origin: true }));
app.use(express.json({ limit: '1mb' }));

// API key auth (optional — skip if no key configured)
app.use('/api', (req, res, next) => {
  if (!API_KEY) return next();
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (key !== API_KEY) return res.status(401).json({ error: 'Invalid API key' });
  next();
});

// ─── Health ──────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  const projects = memoryDb.listProjects();
  res.json({
    status: 'ok',
    version: '2.0.0',
    features: ['entity-graph', 'temporal-invalidation', 'scoped-context', 'progressive-summarization', 'contradiction-detection'],
    projects: projects.length,
    gemini: !!process.env.GEMINI_API_KEY,
    uptime: Math.floor(process.uptime()),
  });
});

// ─── Ingest ──────────────────────────────────────────────────────────────────

// Smart ingest — extracts structured memories from raw content via Gemini
app.post('/api/ingest', async (req, res) => {
  try {
    const { project, source, content, agent } = req.body;

    if (!project || !content) {
      return res.status(400).json({ error: 'project and content are required' });
    }

    const memories = await extractor.extract(content, source);

    if (!memories.length) {
      return res.json({ status: 'skipped', reason: 'No memories worth extracting' });
    }

    const stored = [];
    for (const mem of memories) {
      const result = memoryDb.store({
        project,
        agent: agent || 'system',
        content: mem.content,
        memory_type: mem.memory_type,
        source: source || 'api',
        summary: mem.summary,
        entities: mem.entities,
        topics: mem.topics,
        importance: mem.importance,
      });

      // Store entity edges if extracted
      if (mem.edges && mem.edges.length) {
        memoryDb.storeEdges(project, result.id, mem.edges);
      }

      stored.push(result);
    }

    res.json({ status: 'ingested', count: stored.length, memories: stored });
  } catch (err) {
    console.error('[ingest] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Direct store — with optional contradiction detection
app.post('/api/store', async (req, res) => {
  try {
    const { project, agent, content, memory_type, source, summary, entities, topics, importance, edges, check_contradictions } = req.body;

    if (!project || !content) {
      return res.status(400).json({ error: 'project and content are required' });
    }

    // Contradiction detection (opt-in via check_contradictions flag, or always when Gemini available)
    let contradictionResult = null;
    const shouldCheck = check_contradictions !== false && process.env.GEMINI_API_KEY;

    if (shouldCheck) {
      const parsedEntities = Array.isArray(entities) ? entities : [];
      const similar = memoryDb.findSimilar(project, content, parsedEntities, 5);

      if (similar.length > 0) {
        contradictionResult = await extractor.detectContradiction(content, similar);

        if (contradictionResult.action === 'NOOP') {
          return res.json({
            status: 'skipped',
            action: 'NOOP',
            reason: contradictionResult.reason,
            similar_to: similar[0].id,
          });
        }
      }
    }

    const result = memoryDb.store({
      project, agent, content, memory_type, source, summary, entities, topics, importance,
    });

    // Handle UPDATE — supersede old memories
    if (contradictionResult && contradictionResult.action === 'UPDATE' && contradictionResult.supersede_ids.length) {
      for (const oldId of contradictionResult.supersede_ids) {
        memoryDb.supersede(oldId, result.id);
      }
    }

    // Store entity edges if provided
    if (edges && edges.length) {
      memoryDb.storeEdges(project, result.id, edges);
    }

    const response = { status: 'stored', ...result };
    if (contradictionResult) {
      response.contradiction = {
        action: contradictionResult.action,
        superseded: contradictionResult.supersede_ids,
        reason: contradictionResult.reason,
      };
    }

    res.json(response);
  } catch (err) {
    console.error('[store] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Query ───────────────────────────────────────────────────────────────────

app.get('/api/query', (req, res) => {
  try {
    const { project, q, agent, type, importance_above, limit, topics, include_graph } = req.query;
    if (!q) return res.status(400).json({ error: 'q (query) is required' });

    const parsedTopics = topics ? topics.split(',').map(t => t.trim()).filter(Boolean) : undefined;

    const results = memoryDb.query({
      project,
      q,
      agent,
      type,
      importance_above: importance_above ? parseFloat(importance_above) : undefined,
      topics: parsedTopics,
      limit: limit ? parseInt(limit) : 10,
    });

    const response = { query: q, count: results.length, memories: results };

    // Include entity graph connections for result entities
    if (include_graph === 'true' && project) {
      const entities = new Set();
      for (const m of results) {
        if (Array.isArray(m.entities)) m.entities.forEach(e => entities.add(e));
      }
      const edges = [];
      for (const entity of entities) {
        edges.push(...memoryDb.getEntityGraph(project, entity));
      }
      // Deduplicate edges by id
      const seen = new Set();
      response.entity_graph = edges.filter(e => {
        if (seen.has(e.id)) return false;
        seen.add(e.id);
        return true;
      });
    }

    res.json(response);
  } catch (err) {
    console.error('[query] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Context ─────────────────────────────────────────────────────────────────

// Returns a compressed context summary for LLM consumption
// Supports topic scoping via ?topics=auth,database
app.get('/api/context/:project', (req, res) => {
  try {
    const topics = req.query.topics
      ? req.query.topics.split(',').map(t => t.trim()).filter(Boolean)
      : undefined;
    const ctx = memoryDb.context(req.params.project, { topics });
    res.json(ctx);
  } catch (err) {
    console.error('[context] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Entity Graph ───────────────────────────────────────────────────────────

app.get('/api/graph/:project', (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit) : 50;
    const edges = memoryDb.getProjectGraph(req.params.project, limit);
    res.json({ project: req.params.project, edges, count: edges.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/graph/:project/:entity', (req, res) => {
  try {
    const edges = memoryDb.getEntityGraph(req.params.project, req.params.entity);
    res.json({ entity: req.params.entity, edges, count: edges.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Recall / Recent ─────────────────────────────────────────────────────────

app.get('/api/recall/:id', (req, res) => {
  const memory = memoryDb.recall(parseInt(req.params.id));
  if (!memory) return res.status(404).json({ error: 'Memory not found' });
  res.json(memory);
});

app.get('/api/recent/:project', (req, res) => {
  const limit = req.query.limit ? parseInt(req.query.limit) : 20;
  const memories = memoryDb.recent(req.params.project, limit);
  res.json({ count: memories.length, memories });
});

// ─── Stats ───────────────────────────────────────────────────────────────────

app.get('/api/stats/:project', (req, res) => {
  try {
    const s = memoryDb.stats(req.params.project);
    res.json(s);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Projects ────────────────────────────────────────────────────────────────

app.get('/api/projects', (req, res) => {
  const projects = memoryDb.listProjects();
  res.json({ count: projects.length, projects });
});

// ─── Consolidation ───────────────────────────────────────────────────────────

app.post('/api/consolidate', async (req, res) => {
  try {
    const { project } = req.body || {};
    let results;
    if (project) {
      results = [await consolidator.consolidateProject(project)];
    } else {
      results = await consolidator.consolidateAll();
    }
    res.json({ status: 'done', results });
  } catch (err) {
    console.error('[consolidate] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Management ──────────────────────────────────────────────────────────────

app.delete('/api/forget/:id', (req, res) => {
  const result = memoryDb.forget(parseInt(req.params.id));
  if (!result) return res.status(404).json({ error: 'Memory not found' });
  res.json(result);
});

app.post('/api/prune', (req, res) => {
  try {
    const { project, before, importance_below } = req.body;
    if (!project || !before) return res.status(400).json({ error: 'project and before are required' });
    const result = memoryDb.prune({ project, before, importance_below });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[memory-service] v2.0.0 listening on port ${PORT}`);
  console.log(`[memory-service] Features: entity-graph, temporal-invalidation, scoped-context, progressive-summarization, contradiction-detection`);
  console.log(`[memory-service] Gemini extraction: ${process.env.GEMINI_API_KEY ? 'enabled' : 'disabled (fallback mode)'}`);
  console.log(`[memory-service] API key auth: ${API_KEY ? 'enabled' : 'disabled'}`);

  // Start background consolidation
  consolidator.start();
});
