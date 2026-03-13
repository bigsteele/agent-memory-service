/**
 * Background consolidation loop.
 * Runs on a timer, finds unconsolidated memories, clusters them,
 * uses Gemini Flash to summarize clusters, and stores consolidated memories.
 */

const memoryDb = require('./db');
const extractor = require('./extractor');

const CONSOLIDATION_INTERVAL = parseInt(process.env.CONSOLIDATION_INTERVAL_MS) || 6 * 60 * 60 * 1000; // 6 hours
const CONSOLIDATION_BATCH_SIZE = parseInt(process.env.CONSOLIDATION_BATCH_SIZE) || 50;
const CONSOLIDATION_THRESHOLD = parseInt(process.env.CONSOLIDATION_THRESHOLD) || 20; // Min unconsolidated to trigger
const MAX_CLUSTER_SIZE = parseInt(process.env.MAX_CLUSTER_SIZE) || 8; // Prevent mega-clusters
const IMPORTANCE_PROTECT = parseFloat(process.env.IMPORTANCE_PROTECT) || 0.85; // Never consolidate above this

let running = false;

/**
 * Run consolidation for a single project.
 */
async function consolidateProject(project) {
  const allUnconsolidated = memoryDb.getUnconsolidated(project, CONSOLIDATION_BATCH_SIZE);

  if (allUnconsolidated.length < CONSOLIDATION_THRESHOLD) {
    return { project, status: 'skip', reason: `Only ${allUnconsolidated.length} unconsolidated (threshold: ${CONSOLIDATION_THRESHOLD})` };
  }

  // Protect high-importance memories from consolidation
  const unconsolidated = allUnconsolidated.filter(m => (m.importance || 0) < IMPORTANCE_PROTECT);
  const protected_count = allUnconsolidated.length - unconsolidated.length;

  if (unconsolidated.length < 2) {
    return { project, status: 'skip', reason: `${protected_count} memories protected (importance >= ${IMPORTANCE_PROTECT}), only ${unconsolidated.length} eligible` };
  }

  console.log(`[consolidator] ${project}: Processing ${unconsolidated.length} memories (${protected_count} protected by importance)`);

  // Cluster by entity/topic overlap
  const clusters = clusterMemories(unconsolidated);
  let totalProcessed = 0;
  let totalCreated = 0;

  for (const cluster of clusters) {
    if (cluster.length < 2) continue;

    try {
      // Use Gemini to summarize the cluster
      const consolidated = await extractor.consolidate(cluster);

      // Store the consolidated memory
      const result = memoryDb.store({
        project,
        agent: 'consolidator',
        content: consolidated.content,
        memory_type: 'summary',
        source: 'consolidation',
        summary: consolidated.summary,
        entities: consolidated.entities,
        topics: consolidated.topics,
        importance: consolidated.importance,
      });

      // Mark originals as consolidated
      const ids = cluster.map(m => m.id);
      memoryDb.markConsolidated(ids, result.id);
      totalProcessed += ids.length;
      totalCreated += 1;

      console.log(`[consolidator] ${project}: Consolidated ${ids.length} memories → #${result.id}`);
    } catch (err) {
      console.error(`[consolidator] ${project}: Cluster consolidation failed:`, err.message);
    }
  }

  // Log the consolidation run
  if (totalProcessed > 0) {
    memoryDb.logConsolidation({
      project,
      source_ids: unconsolidated.map(m => m.id),
      summary: `Consolidated ${totalProcessed} memories into ${totalCreated} summaries`,
      insight: `${clusters.length} clusters found`,
      memories_processed: totalProcessed,
      memories_created: totalCreated,
    });
  }

  return { project, status: 'done', processed: totalProcessed, created: totalCreated, clusters: clusters.length };
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
