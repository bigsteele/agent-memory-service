/**
 * Memory Service — Always-on REST API for multi-project AI memory.
 *
 * Stores structured memories in SQLite, extracts metadata via Gemini Flash,
 * runs background consolidation, and serves context to Claude Code + agents.
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
    version: '1.0.0',
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
      stored.push(result);
    }

    res.json({ status: 'ingested', count: stored.length, memories: stored });
  } catch (err) {
    console.error('[ingest] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Direct store — store a pre-structured memory (no LLM extraction)
app.post('/api/store', (req, res) => {
  try {
    const { project, agent, content, memory_type, source, summary, entities, topics, importance } = req.body;

    if (!project || !content) {
      return res.status(400).json({ error: 'project and content are required' });
    }

    const result = memoryDb.store({
      project, agent, content, memory_type, source, summary, entities, topics, importance,
    });

    res.json({ status: 'stored', ...result });
  } catch (err) {
    console.error('[store] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Query ───────────────────────────────────────────────────────────────────

app.get('/api/query', (req, res) => {
  try {
    const { project, q, agent, type, importance_above, limit } = req.query;
    if (!q) return res.status(400).json({ error: 'q (query) is required' });

    const results = memoryDb.query({
      project,
      q,
      agent,
      type,
      importance_above: importance_above ? parseFloat(importance_above) : undefined,
      limit: limit ? parseInt(limit) : 10,
    });

    res.json({ query: q, count: results.length, memories: results });
  } catch (err) {
    console.error('[query] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Context ─────────────────────────────────────────────────────────────────

// Returns a compressed context summary for LLM consumption
app.get('/api/context/:project', (req, res) => {
  try {
    const ctx = memoryDb.context(req.params.project);
    res.json(ctx);
  } catch (err) {
    console.error('[context] Error:', err);
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
  console.log(`[memory-service] Listening on port ${PORT}`);
  console.log(`[memory-service] Gemini extraction: ${process.env.GEMINI_API_KEY ? 'enabled' : 'disabled (fallback mode)'}`);
  console.log(`[memory-service] API key auth: ${API_KEY ? 'enabled' : 'disabled'}`);

  // Start background consolidation
  consolidator.start();
});
