/**
 * Background consolidation loop with progressive summarization.
 *
 * Runs on a timer, finds unconsolidated memories, clusters them,
 * uses Gemini Flash to summarize clusters, stores consolidated memories,
 * and extracts entity relationship edges.
 *
 * Progressive summarization levels:
 *   Level 0: Raw memories (individual facts, observations, etc.)
 *   Level 1: Daily/cluster summaries (2-8 raw memories → 1 summary)
 *   Level 2: Weekly theme summaries (3-6 L1 summaries → 1 theme)
 *   Level 3: Architectural principles (3+ L2 summaries → 1 principle)
 */

const memoryDb = require('./db');
const extractor = require('./extractor');

const CONSOLIDATION_INTERVAL = parseInt(process.env.CONSOLIDATION_INTERVAL_MS) || 6 * 60 * 60 * 1000; // 6 hours
const CONSOLIDATION_BATCH_SIZE = parseInt(process.env.CONSOLIDATION_BATCH_SIZE) || 50;
const CONSOLIDATION_THRESHOLD = parseInt(process.env.CONSOLIDATION_THRESHOLD) || 20; // Min unconsolidated to trigger
const MAX_CLUSTER_SIZE = parseInt(process.env.MAX_CLUSTER_SIZE) || 8; // Prevent mega-clusters
const IMPORTANCE_PROTECT = parseFloat(process.env.IMPORTANCE_PROTECT) || 0.85; // Never consolidate above this

// Progressive summarization thresholds
const L1_THRESHOLD = 20;  // Min L0 memories to trigger L1 consolidation
const L2_THRESHOLD = 6;   // Min L1 summaries to trigger L2 consolidation
const L3_THRESHOLD = 4;   // Min L2 summaries to trigger L3 consolidation

let running = false;

/**
 * Run consolidation for a single project.
 * Handles Level 0→1 (raw→cluster), Level 1→2 (cluster→theme), Level 2→3 (theme→principle).
 */
async function consolidateProject(project) {
  const results = {
    project,
    levels: {},
  };

  // Level 0 → Level 1: Cluster raw memories
  const l0Result = await consolidateLevel(project, 0, L1_THRESHOLD, 1);
  results.levels.l0_to_l1 = l0Result;

  // Level 1 → Level 2: Consolidate cluster summaries into themes
  const l1Result = await consolidateLevel(project, 1, L2_THRESHOLD, 2);
  results.levels.l1_to_l2 = l1Result;

  // Level 2 → Level 3: Consolidate themes into architectural principles
  const l2Result = await consolidateLevel(project, 2, L3_THRESHOLD, 3);
  results.levels.l2_to_l3 = l2Result;

  const totalProcessed = (l0Result.processed || 0) + (l1Result.processed || 0) + (l2Result.processed || 0);
  const totalCreated = (l0Result.created || 0) + (l1Result.created || 0) + (l2Result.created || 0);

  results.status = totalProcessed > 0 ? 'done' : 'skip';
  results.processed = totalProcessed;
  results.created = totalCreated;

  return results;
}

/**
 * Consolidate memories at a specific level into the next level.
 */
async function consolidateLevel(project, fromLevel, threshold, toLevel) {
  const allUnconsolidated = memoryDb.getUnconsolidated(project, CONSOLIDATION_BATCH_SIZE)
    .filter(m => (m.summary_level || 0) === fromLevel);

  if (allUnconsolidated.length < threshold) {
    return { status: 'skip', reason: `Only ${allUnconsolidated.length} L${fromLevel} (threshold: ${threshold})` };
  }

  // Protect high-importance memories from consolidation
  const unconsolidated = allUnconsolidated.filter(m => (m.importance || 0) < IMPORTANCE_PROTECT);
  const protectedCount = allUnconsolidated.length - unconsolidated.length;

  if (unconsolidated.length < 2) {
    return { status: 'skip', reason: `${protectedCount} protected, only ${unconsolidated.length} eligible` };
  }

  console.log(`[consolidator] ${project}: L${fromLevel}→L${toLevel}: Processing ${unconsolidated.length} memories (${protectedCount} protected)`);

  // Cluster by entity/topic overlap
  const clusters = clusterMemories(unconsolidated);
  let totalProcessed = 0;
  let totalCreated = 0;

  for (const cluster of clusters) {
    if (cluster.length < 2) continue;

    try {
      const consolidated = await extractor.consolidate(cluster);

      const result = memoryDb.store({
        project,
        agent: 'consolidator',
        content: consolidated.content,
        memory_type: 'summary',
        source: `consolidation-L${toLevel}`,
        summary: consolidated.summary,
        entities: consolidated.entities,
        topics: consolidated.topics,
        importance: consolidated.importance,
        summary_level: toLevel,
      });

      // Store entity edges from consolidation
      if (consolidated.edges && consolidated.edges.length) {
        memoryDb.storeEdges(project, result.id, consolidated.edges);
      }

      // Mark originals as consolidated
      const ids = cluster.map(m => m.id);
      memoryDb.markConsolidated(ids, result.id);
      totalProcessed += ids.length;
      totalCreated += 1;

      console.log(`[consolidator] ${project}: L${fromLevel}→L${toLevel}: ${ids.length} memories → #${result.id}`);
    } catch (err) {
      console.error(`[consolidator] ${project}: Cluster consolidation failed:`, err.message);
    }
  }

  // Log the consolidation run
  if (totalProcessed > 0) {
    memoryDb.logConsolidation({
      project,
      source_ids: unconsolidated.map(m => m.id),
      summary: `L${fromLevel}→L${toLevel}: Consolidated ${totalProcessed} into ${totalCreated}`,
      insight: `${clusters.length} clusters at level ${fromLevel}`,
      memories_processed: totalProcessed,
      memories_created: totalCreated,
    });
  }

  return { status: 'done', processed: totalProcessed, created: totalCreated, clusters: clusters.length };
}

/**
 * Cluster memories by entity/topic overlap.
 */
function clusterMemories(memories) {
  const clusters = [];
  const assigned = new Set();

  for (const m of memories) {
    if (assigned.has(m.id)) continue;

    const cluster = [m];
    assigned.add(m.id);

    // Use ONLY the seed memory's entities/topics — no transitive expansion
    const mEntities = new Set(Array.isArray(m.entities) ? m.entities : []);
    const mTopics = new Set(Array.isArray(m.topics) ? m.topics : []);

    for (const other of memories) {
      if (assigned.has(other.id)) continue;
      if (cluster.length >= MAX_CLUSTER_SIZE) break; // Cap cluster size

      const oEntities = new Set(Array.isArray(other.entities) ? other.entities : []);
      const oTopics = new Set(Array.isArray(other.topics) ? other.topics : []);

      // Require entity overlap (topics alone are too broad)
      const sharedEntities = [...mEntities].filter(e => oEntities.has(e));

      // Only cluster if they share at least one entity, OR share 2+ topics
      const sharedTopics = [...mTopics].filter(t => oTopics.has(t));
      if (sharedEntities.length > 0 || sharedTopics.length >= 2) {
        cluster.push(other);
        assigned.add(other.id);
        // DO NOT expand scope — prevents chain reaction clustering
      }
    }

    clusters.push(cluster);
  }

  return clusters;
}

/**
 * Run consolidation across all projects.
 */
async function consolidateAll() {
  if (running) {
    console.log('[consolidator] Already running, skipping');
    return [];
  }

  running = true;
  const results = [];

  try {
    const projects = memoryDb.listProjects();
    for (const project of projects) {
      try {
        const result = await consolidateProject(project.name);
        results.push(result);
      } catch (err) {
        console.error(`[consolidator] ${project.name} failed:`, err.message);
        results.push({ project: project.name, status: 'error', error: err.message });
      }
    }
  } finally {
    running = false;
  }

  return results;
}

/**
 * Start the background consolidation loop.
 */
function start() {
  console.log(`[consolidator] Starting background loop (interval: ${CONSOLIDATION_INTERVAL / 1000}s, threshold: ${CONSOLIDATION_THRESHOLD})`);
  console.log(`[consolidator] Progressive summarization: L0→L1 (${L1_THRESHOLD}), L1→L2 (${L2_THRESHOLD}), L2→L3 (${L3_THRESHOLD})`);

  // First consolidation after 1 hour (give time for memories to accumulate, don't consolidate on fresh deploy)
  setTimeout(async () => {
    const results = await consolidateAll();
    console.log('[consolidator] Initial run complete:', results.map(r => `${r.project}: ${r.status}`).join(', ') || 'no projects');
  }, 60 * 60 * 1000);

  // Then run on interval
  setInterval(async () => {
    console.log('[consolidator] Running scheduled consolidation...');
    const results = await consolidateAll();
    console.log('[consolidator] Complete:', results.map(r => `${r.project}: ${r.status}`).join(', ') || 'no projects');
  }, CONSOLIDATION_INTERVAL);
}

module.exports = { start, consolidateAll, consolidateProject };
