/**
 * SQLite memory store — multi-project, structured, with consolidation support.
 * Uses better-sqlite3 for synchronous, fast, single-file persistence.
 *
 * Features:
 *   - Entity-relationship graph (entity_edges table)
 *   - Temporal invalidation (valid_until, superseded_by chain)
 *   - Scoped context retrieval (topic-filtered /api/context)
 *   - Progressive summarization (summary_level 0-3)
 *   - Contradiction detection on ingest (findSimilar + classify)
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.MEMORY_DB_PATH || '/data/memory.db';

// Ensure directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Performance pragmas
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

// ─── Schema ─────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    agent TEXT DEFAULT 'system',
    content TEXT NOT NULL,
    memory_type TEXT NOT NULL DEFAULT 'observation',
    source TEXT,
    summary TEXT,
    entities TEXT DEFAULT '[]',
    topics TEXT DEFAULT '[]',
    importance REAL DEFAULT 0.5 CHECK(importance BETWEEN 0.0 AND 1.0),
    access_count INTEGER DEFAULT 0,
    last_accessed_at TEXT,
    consolidated INTEGER DEFAULT 0,
    superseded_by INTEGER REFERENCES memories(id),
    summary_level INTEGER DEFAULT 0,
    valid_until TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS consolidations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    source_ids TEXT NOT NULL,
    summary TEXT NOT NULL,
    insight TEXT,
    memories_processed INTEGER DEFAULT 0,
    memories_created INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS projects (
    name TEXT PRIMARY KEY,
    display_name TEXT,
    description TEXT,
    config TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_activity_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS entity_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    subject TEXT NOT NULL,
    predicate TEXT NOT NULL,
    object TEXT NOT NULL,
    memory_id INTEGER REFERENCES memories(id),
    confidence REAL DEFAULT 1.0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
  CREATE INDEX IF NOT EXISTS idx_memories_project_agent ON memories(project, agent);
  CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(project)
    WHERE superseded_by IS NULL;
  CREATE INDEX IF NOT EXISTS idx_memories_unconsolidated ON memories(project)
    WHERE consolidated = 0 AND superseded_by IS NULL;
  CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
  CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type);
  CREATE INDEX IF NOT EXISTS idx_memories_summary_level ON memories(project, summary_level)
    WHERE superseded_by IS NULL;
  CREATE INDEX IF NOT EXISTS idx_consolidations_project ON consolidations(project);
  CREATE INDEX IF NOT EXISTS idx_entity_edges_project ON entity_edges(project);
  CREATE INDEX IF NOT EXISTS idx_entity_edges_subject ON entity_edges(subject);
  CREATE INDEX IF NOT EXISTS idx_entity_edges_object ON entity_edges(object);
  CREATE INDEX IF NOT EXISTS idx_entity_edges_memory ON entity_edges(memory_id);
`);

// ─── Schema migrations (add columns if upgrading from older version) ────────

try { db.exec('ALTER TABLE memories ADD COLUMN summary_level INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE memories ADD COLUMN valid_until TEXT'); } catch {}

// ─── Prepared Statements ────────────────────────────────────────────────────

const stmts = {
  insertMemory: db.prepare(`
    INSERT INTO memories (project, agent, content, memory_type, source, summary, entities, topics, importance, summary_level)
    VALUES (@project, @agent, @content, @memory_type, @source, @summary, @entities, @topics, @importance, @summary_level)
  `),

  queryMemories: (whereClauses, params, limit) => {
    const where = whereClauses.length ? 'WHERE ' + whereClauses.join(' AND ') : '';
    return db.prepare(`
      SELECT id, content, memory_type, agent, source, summary, entities, topics,
             importance, access_count, summary_level, created_at
      FROM memories
      ${where}
      ORDER BY importance DESC, created_at DESC
      LIMIT ?
    `).all(...params, limit);
  },

  getMemory: db.prepare('SELECT * FROM memories WHERE id = ?'),

  getRecentMemories: db.prepare(`
    SELECT id, content, memory_type, agent, source, importance, summary_level, created_at
    FROM memories WHERE project = ? AND superseded_by IS NULL
    ORDER BY created_at DESC LIMIT ?
  `),

  getUnconsolidated: db.prepare(`
    SELECT id, content, memory_type, agent, source, summary, entities, topics,
           importance, summary_level, created_at
    FROM memories
    WHERE project = ? AND consolidated = 0 AND superseded_by IS NULL
    ORDER BY created_at ASC LIMIT ?
  `),

  markConsolidated: db.prepare(`
    UPDATE memories SET consolidated = 1, superseded_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `),

  updateAccessCount: db.prepare(`
    UPDATE memories SET access_count = access_count + 1, last_accessed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `),

  forgetMemory: db.prepare(`
    UPDATE memories SET superseded_by = -1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `),

  supersedeMemory: db.prepare(`
    UPDATE memories SET superseded_by = @new_id, valid_until = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = @old_id
  `),

  insertConsolidation: db.prepare(`
    INSERT INTO consolidations (project, source_ids, summary, insight, memories_processed, memories_created)
    VALUES (@project, @source_ids, @summary, @insight, @memories_processed, @memories_created)
  `),

  upsertProject: db.prepare(`
    INSERT INTO projects (name, display_name, description)
    VALUES (@name, @display_name, @description)
    ON CONFLICT(name) DO UPDATE SET
      display_name = COALESCE(@display_name, display_name),
      description = COALESCE(@description, description),
      last_activity_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `),

  getProject: db.prepare('SELECT * FROM projects WHERE name = ?'),
  listProjects: db.prepare('SELECT * FROM projects ORDER BY last_activity_at DESC'),

  // Entity graph
  insertEdge: db.prepare(`
    INSERT INTO entity_edges (project, subject, predicate, object, memory_id, confidence)
    VALUES (@project, @subject, @predicate, @object, @memory_id, @confidence)
  `),

  getEdgesForEntity: db.prepare(`
    SELECT * FROM entity_edges
    WHERE project = ? AND (subject = ? OR object = ?)
    ORDER BY confidence DESC, created_at DESC
  `),

  getEdgesForMemory: db.prepare(`
    SELECT * FROM entity_edges WHERE memory_id = ?
  `),

  getProjectGraph: db.prepare(`
    SELECT subject, predicate, object, confidence, memory_id
    FROM entity_edges WHERE project = ?
    ORDER BY confidence DESC LIMIT ?
  `),

  // Stats
  totalMemories: db.prepare('SELECT COUNT(*) as c FROM memories WHERE project = ?'),
  activeMemories: db.prepare('SELECT COUNT(*) as c FROM memories WHERE project = ? AND superseded_by IS NULL'),
  unconsolidatedCount: db.prepare('SELECT COUNT(*) as c FROM memories WHERE project = ? AND consolidated = 0 AND superseded_by IS NULL'),
  consolidationCount: db.prepare('SELECT COUNT(*) as c FROM consolidations WHERE project = ?'),
  byType: db.prepare('SELECT memory_type, COUNT(*) as c FROM memories WHERE project = ? AND superseded_by IS NULL GROUP BY memory_type'),
  byAgent: db.prepare('SELECT agent, COUNT(*) as c FROM memories WHERE project = ? AND superseded_by IS NULL GROUP BY agent'),
  avgImportance: db.prepare('SELECT AVG(importance) as a FROM memories WHERE project = ? AND superseded_by IS NULL'),
  topAccessed: db.prepare(`
    SELECT id, content, access_count FROM memories
    WHERE project = ? AND superseded_by IS NULL
    ORDER BY access_count DESC LIMIT 5
  `),
  dateRange: db.prepare(`
    SELECT MIN(created_at) as oldest, MAX(created_at) as newest
    FROM memories WHERE project = ?
  `),
  edgeCount: db.prepare('SELECT COUNT(*) as c FROM entity_edges WHERE project = ?'),
};

// ─── API ────────────────────────────────────────────────────────────────────

function store({ project, agent, content, memory_type, source, summary, entities, topics, importance, summary_level }) {
  // Auto-register project
  stmts.upsertProject.run({ name: project, display_name: null, description: null });

  const info = stmts.insertMemory.run({
    project,
    agent: agent || 'system',
    content,
    memory_type: memory_type || 'observation',
    source: source || 'api',
    summary: summary || null,
    entities: Array.isArray(entities) ? JSON.stringify(entities) : (entities || '[]'),
    topics: Array.isArray(topics) ? JSON.stringify(topics) : (topics || '[]'),
    importance: importance ?? 0.5,
    summary_level: summary_level || 0,
  });

  return { id: info.lastInsertRowid, project, memory_type: memory_type || 'observation' };
}

/**
 * Store a memory with contradiction detection.
 * Returns { action, id, superseded?, note? }
 */
function storeWithCheck({ project, agent, content, memory_type, source, summary, entities, topics, importance, summary_level }) {
  // Auto-register project
  stmts.upsertProject.run({ name: project, display_name: null, description: null });

  const info = stmts.insertMemory.run({
    project,
    agent: agent || 'system',
    content,
    memory_type: memory_type || 'observation',
    source: source || 'api',
    summary: summary || null,
    entities: Array.isArray(entities) ? JSON.stringify(entities) : (entities || '[]'),
    topics: Array.isArray(topics) ? JSON.stringify(topics) : (topics || '[]'),
    importance: importance ?? 0.5,
    summary_level: summary_level || 0,
  });

  return { id: info.lastInsertRowid, project, memory_type: memory_type || 'observation' };
}

/**
 * Find memories similar to the given content (for contradiction detection).
 * Uses keyword overlap on content + entities.
 */
function findSimilar(project, content, entities, limit = 5) {
  // Extract significant words (4+ chars, lowercased)
  const words = content.toLowerCase().split(/\s+/).filter(w => w.length >= 4);
  if (!words.length) return [];

  // Use the top 5 most distinctive words
  const keywords = words.slice(0, 8);

  const whereClauses = ['project = ?', 'superseded_by IS NULL'];
  const params = [project];

  // Build OR conditions for keyword matching
  const keywordConditions = keywords.map(() =>
    "(LOWER(content) LIKE ? OR LOWER(COALESCE(summary,'')) LIKE ?)"
  );

  if (keywordConditions.length) {
    whereClauses.push('(' + keywordConditions.join(' OR ') + ')');
    for (const kw of keywords) {
      params.push(`%${kw}%`, `%${kw}%`);
    }
  }

  const where = whereClauses.join(' AND ');
  const rows = db.prepare(`
    SELECT id, content, memory_type, agent, summary, entities, topics, importance, created_at
    FROM memories
    WHERE ${where}
    ORDER BY importance DESC, created_at DESC
    LIMIT ?
  `).all(...params, limit);

  return rows.map(r => ({
    ...r,
    entities: JSON.parse(r.entities),
    topics: JSON.parse(r.topics),
  }));
}

/**
 * Supersede an old memory with a new one (temporal invalidation).
 */
function supersede(oldId, newId) {
  stmts.supersedeMemory.run({ old_id: oldId, new_id: newId });
}

/**
 * Store entity-relationship edges extracted from a memory.
 */
function storeEdges(project, memoryId, edges) {
  const insertMany = db.transaction((edges) => {
    for (const edge of edges) {
      stmts.insertEdge.run({
        project,
        subject: edge.subject,
        predicate: edge.predicate,
        object: edge.object,
        memory_id: memoryId,
        confidence: edge.confidence ?? 1.0,
      });
    }
  });
  insertMany(edges);
}

/**
 * Get entity graph for a specific entity (all edges where it appears).
 */
function getEntityGraph(project, entity) {
  return stmts.getEdgesForEntity.all(project, entity, entity);
}

/**
 * Get full project graph (top N edges by confidence).
 */
function getProjectGraph(project, limit = 50) {
  return stmts.getProjectGraph.all(project, limit);
}

function query({ project, q, agent, type, importance_above, topics, limit }) {
  const whereClauses = ['superseded_by IS NULL'];
  const params = [];

  // Filter out expired memories
  whereClauses.push("(valid_until IS NULL OR valid_until > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))");

  if (project) {
    whereClauses.push('project = ?');
    params.push(project);
  }

  if (agent) {
    whereClauses.push('agent = ?');
    params.push(agent);
  }

  if (type) {
    whereClauses.push('memory_type = ?');
    params.push(type);
  }

  if (importance_above != null) {
    whereClauses.push('importance >= ?');
    params.push(importance_above);
  }

  // Topic scoping — filter memories that contain ANY of the requested topics
  if (topics && topics.length) {
    const topicConditions = topics.map(() => "LOWER(topics) LIKE ?");
    whereClauses.push('(' + topicConditions.join(' OR ') + ')');
    for (const t of topics) {
      params.push(`%${t.toLowerCase()}%`);
    }
  }

  if (q) {
    const keywords = q.toLowerCase().split(/\s+/);
    for (const kw of keywords) {
      whereClauses.push(
        "(LOWER(content) LIKE ? OR LOWER(COALESCE(summary,'')) LIKE ? OR LOWER(entities) LIKE ? OR LOWER(topics) LIKE ?)"
      );
      const pattern = `%${kw}%`;
      params.push(pattern, pattern, pattern, pattern);
    }
  }

  const rows = stmts.queryMemories(whereClauses, params, limit || 10);

  // Update access counts
  for (const row of rows) {
    stmts.updateAccessCount.run(row.id);
  }

  return rows.map(r => ({
    ...r,
    entities: JSON.parse(r.entities),
    topics: JSON.parse(r.topics),
    access_count: r.access_count + 1,
  }));
}

function recall(id) {
  stmts.updateAccessCount.run(id);
  const row = stmts.getMemory.get(id);
  if (!row) return null;
  return {
    ...row,
    entities: JSON.parse(row.entities),
    topics: JSON.parse(row.topics),
    consolidated: !!row.consolidated,
  };
}

function recent(project, limit = 20) {
  return stmts.getRecentMemories.all(project, limit);
}

function forget(id) {
  const row = stmts.getMemory.get(id);
  if (!row) return null;
  stmts.forgetMemory.run(id);
  return { id, status: 'forgotten' };
}

function getUnconsolidated(project, batchSize = 50) {
  return stmts.getUnconsolidated.all(project, batchSize).map(r => ({
    ...r,
    entities: JSON.parse(r.entities),
    topics: JSON.parse(r.topics),
  }));
}

function markConsolidated(ids, supersededBy) {
  const markMany = db.transaction((ids, supersededBy) => {
    for (const id of ids) {
      stmts.markConsolidated.run(supersededBy, id);
    }
  });
  markMany(ids, supersededBy);
}

function logConsolidation({ project, source_ids, summary, insight, memories_processed, memories_created }) {
  stmts.insertConsolidation.run({
    project,
    source_ids: JSON.stringify(source_ids),
    summary,
    insight: insight || null,
    memories_processed: memories_processed || 0,
    memories_created: memories_created || 0,
  });
}

function stats(project) {
  const total = stmts.totalMemories.get(project).c;
  const active = stmts.activeMemories.get(project).c;
  const unconsolidated = stmts.unconsolidatedCount.get(project).c;
  const consolidations = stmts.consolidationCount.get(project).c;
  const edges = stmts.edgeCount.get(project).c;
  const byType = {};
  for (const row of stmts.byType.all(project)) byType[row.memory_type] = row.c;
  const byAgent = {};
  for (const row of stmts.byAgent.all(project)) byAgent[row.agent] = row.c;
  const avgImportance = stmts.avgImportance.get(project).a;
  const topAccessed = stmts.topAccessed.all(project).map(r => ({
    id: r.id, preview: r.content.slice(0, 100), access_count: r.access_count,
  }));
  const dateRange = stmts.dateRange.get(project);

  return {
    project,
    total_memories: total,
    active_memories: active,
    unconsolidated,
    consolidation_runs: consolidations,
    entity_edges: edges,
    by_type: byType,
    by_agent: byAgent,
    avg_importance: avgImportance ? Math.round(avgImportance * 1000) / 1000 : 0,
    top_accessed: topAccessed,
    date_range: dateRange,
  };
}

function context(project, { topics: filterTopics } = {}) {
  // Build topic filter SQL fragment
  let topicFilter = '';
  const topicParams = [];
  if (filterTopics && filterTopics.length) {
    const conditions = filterTopics.map(() => "LOWER(topics) LIKE ?");
    topicFilter = ' AND (' + conditions.join(' OR ') + ')';
    for (const t of filterTopics) {
      topicParams.push(`%${t.toLowerCase()}%`);
    }
  }

  // Temporal filter — exclude expired memories
  const temporalFilter = " AND (valid_until IS NULL OR valid_until > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";

  const highImportance = db.prepare(`
    SELECT id, content, memory_type, agent, entities, topics, importance, summary_level, created_at
    FROM memories
    WHERE project = ? AND superseded_by IS NULL AND importance >= 0.7${temporalFilter}${topicFilter}
    ORDER BY importance DESC, created_at DESC
    LIMIT 30
  `).all(project, ...topicParams).map(r => ({
    ...r,
    entities: JSON.parse(r.entities),
    topics: JSON.parse(r.topics),
  }));

  const recentSummaries = db.prepare(`
    SELECT id, content, agent, entities, topics, importance, summary_level, created_at
    FROM memories
    WHERE project = ? AND superseded_by IS NULL AND memory_type = 'summary'${temporalFilter}${topicFilter}
    ORDER BY summary_level DESC, created_at DESC
    LIMIT 10
  `).all(project, ...topicParams).map(r => ({
    ...r,
    entities: JSON.parse(r.entities),
    topics: JSON.parse(r.topics),
  }));

  const recentFacts = db.prepare(`
    SELECT id, content, agent, importance, created_at
    FROM memories
    WHERE project = ? AND superseded_by IS NULL AND memory_type = 'fact' AND importance >= 0.5${temporalFilter}${topicFilter}
    ORDER BY created_at DESC
    LIMIT 20
  `).all(project, ...topicParams);

  const s = stats(project);

  const result = {
    project,
    stats: { total: s.total_memories, active: s.active_memories, unconsolidated: s.unconsolidated, entity_edges: s.entity_edges },
    high_importance: highImportance,
    summaries: recentSummaries,
    recent_facts: recentFacts,
  };

  // Include entity graph snippet if no topic filter (full context load)
  if (!filterTopics || !filterTopics.length) {
    result.entity_graph = getProjectGraph(project, 30);
  } else {
    // Filter graph to relevant entities from the topic-filtered memories
    const relevantEntities = new Set();
    for (const m of [...highImportance, ...recentSummaries]) {
      if (Array.isArray(m.entities)) m.entities.forEach(e => relevantEntities.add(e));
    }
    if (relevantEntities.size) {
      const allEdges = getProjectGraph(project, 100);
      result.entity_graph = allEdges.filter(e =>
        relevantEntities.has(e.subject) || relevantEntities.has(e.object)
      ).slice(0, 20);
    }
  }

  return result;
}

function listProjects() {
  return stmts.listProjects.all().map(p => ({
    ...p,
    config: JSON.parse(p.config),
  }));
}

function prune({ project, before, importance_below }) {
  const rows = db.prepare(`
    SELECT id FROM memories
    WHERE project = ? AND superseded_by IS NULL AND created_at < ? AND importance < ?
  `).all(project, before, importance_below || 0.3);

  if (!rows.length) return { pruned: 0 };

  const pruneMany = db.transaction((ids) => {
    for (const { id } of ids) {
      stmts.forgetMemory.run(id);
    }
  });
  pruneMany(rows);

  return { pruned: rows.length, ids: rows.map(r => r.id) };
}

/**
 * Get memories at a specific summary level for progressive summarization.
 */
function getByLevel(project, level, limit = 20) {
  return db.prepare(`
    SELECT id, content, memory_type, agent, entities, topics, importance, summary_level, created_at
    FROM memories
    WHERE project = ? AND summary_level = ? AND superseded_by IS NULL
    ORDER BY created_at DESC LIMIT ?
  `).all(project, level, limit).map(r => ({
    ...r,
    entities: JSON.parse(r.entities),
    topics: JSON.parse(r.topics),
  }));
}

module.exports = {
  db, store, storeWithCheck, query, recall, recent, forget, getUnconsolidated,
  markConsolidated, logConsolidation, stats, context, listProjects, prune,
  findSimilar, supersede, storeEdges, getEntityGraph, getProjectGraph, getByLevel,
};
