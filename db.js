/**
 * SQLite memory store — multi-project, structured, with consolidation support.
 * Uses better-sqlite3 for synchronous, fast, single-file persistence.
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

  CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
  CREATE INDEX IF NOT EXISTS idx_memories_project_agent ON memories(project, agent);
  CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(project)
    WHERE superseded_by IS NULL;
  CREATE INDEX IF NOT EXISTS idx_memories_unconsolidated ON memories(project)
    WHERE consolidated = 0 AND superseded_by IS NULL;
  CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
  CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type);
  CREATE INDEX IF NOT EXISTS idx_consolidations_project ON consolidations(project);
`);

// ─── Prepared Statements ────────────────────────────────────────────────────

const stmts = {
  insertMemory: db.prepare(`
    INSERT INTO memories (project, agent, content, memory_type, source, summary, entities, topics, importance)
    VALUES (@project, @agent, @content, @memory_type, @source, @summary, @entities, @topics, @importance)
  `),

  queryMemories: (whereClauses, params, limit) => {
    const where = whereClauses.length ? 'WHERE ' + whereClauses.join(' AND ') : '';
    return db.prepare(`
      SELECT id, content, memory_type, agent, source, summary, entities, topics,
             importance, access_count, created_at
      FROM memories
      ${where}
      ORDER BY importance DESC, created_at DESC
      LIMIT ?
    `).all(...params, limit);
  },

  getMemory: db.prepare('SELECT * FROM memories WHERE id = ?'),

  getRecentMemories: db.prepare(`
    SELECT id, content, memory_type, agent, source, importance, created_at
    FROM memories WHERE project = ? AND superseded_by IS NULL
    ORDER BY created_at DESC LIMIT ?
  `),

  getUnconsolidated: db.prepare(`
    SELECT id, content, memory_type, agent, source, summary, entities, topics,
           importance, created_at
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
};

// ─── API ────────────────────────────────────────────────────────────────────

function store({ project, agent, content, memory_type, source, summary, entities, topics, importance }) {
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
  });

  return { id: info.lastInsertRowid, project, memory_type: memory_type || 'observation' };
}

function query({ project, q, agent, type, importance_above, limit }) {
  const whereClauses = ['superseded_by IS NULL'];
  const params = [];

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
    by_type: byType,
    by_agent: byAgent,
    avg_importance: avgImportance ? Math.round(avgImportance * 1000) / 1000 : 0,
    top_accessed: topAccessed,
    date_range: dateRange,
  };
}

function context(project) {
  // Return a compressed context summary for LLM consumption
  // High-importance active memories + latest consolidation summaries
  const highImportance = db.prepare(`
    SELECT id, content, memory_type, agent, entities, topics, importance, created_at
    FROM memories
    WHERE project = ? AND superseded_by IS NULL AND importance >= 0.7
    ORDER BY importance DESC, created_at DESC
    LIMIT 30
  `).all(project).map(r => ({
    ...r,
    entities: JSON.parse(r.entities),
    topics: JSON.parse(r.topics),
  }));

  const recentSummaries = db.prepare(`
    SELECT id, content, agent, entities, topics, importance, created_at
    FROM memories
    WHERE project = ? AND superseded_by IS NULL AND memory_type = 'summary'
    ORDER BY created_at DESC
    LIMIT 10
  `).all(project).map(r => ({
    ...r,
    entities: JSON.parse(r.entities),
    topics: JSON.parse(r.topics),
  }));

  const recentFacts = db.prepare(`
    SELECT id, content, agent, importance, created_at
    FROM memories
    WHERE project = ? AND superseded_by IS NULL AND memory_type = 'fact' AND importance >= 0.5
    ORDER BY created_at DESC
    LIMIT 20
  `).all(project);

  const s = stats(project);

  return {
    project,
    stats: { total: s.total_memories, active: s.active_memories, unconsolidated: s.unconsolidated },
    high_importance: highImportance,
    summaries: recentSummaries,
    recent_facts: recentFacts,
  };
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

module.exports = {
  db, store, query, recall, recent, forget, getUnconsolidated,
  markConsolidated, logConsolidation, stats, context, listProjects, prune,
};
