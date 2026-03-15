/**
 * Gemini Flash extractor — structured extraction, entity graph, and contradiction detection.
 * Uses Google Gemini 2.5 Flash for cheap, fast structured extraction.
 * Falls back to simple heuristics if no API key is configured.
 */

const https = require('https');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

const EXTRACTION_PROMPT = `You are a memory extraction engine. Given raw content, extract structured memory metadata.

Return ONLY valid JSON with these fields:
{
  "memories": [
    {
      "content": "One clear, concise fact or observation (1-2 sentences max)",
      "memory_type": "observation|fact|reflection|episode|preference",
      "summary": "One-line summary",
      "entities": ["entity1", "entity2"],
      "topics": ["topic1", "topic2"],
      "importance": 0.5,
      "edges": [
        {"subject": "Entity A", "predicate": "uses", "object": "Entity B", "confidence": 0.9}
      ]
    }
  ]
}

Rules:
- Extract 1-5 discrete memories from the content. Each memory should be a single, standalone piece of information.
- memory_type: "fact" for verified info, "observation" for noticed patterns, "reflection" for interpretations, "episode" for event narratives, "preference" for stated preferences.
- importance: 0.1 (trivial) to 1.0 (critical). Most things are 0.4-0.6. Only truly critical items (security, money, deadlines) get 0.8+.
- entities: People, companies, projects, services, tools mentioned.
- topics: 2-4 category tags for grouping related memories.
- edges: Entity relationships found in the content. Common predicates: uses, depends-on, connects-to, deployed-on, configured-with, replaces, manages, contains, runs-on, calls, owns, blocks, fixes. Only include edges with clear relationships stated in the content.
- Be concise. Strip fluff. Keep only what's worth remembering.
- If the content is trivial (greetings, acknowledgments), return {"memories": []}.`;

const CONTRADICTION_PROMPT = `You are a memory contradiction detector. Given a NEW memory and a list of EXISTING memories, classify the relationship.

Return ONLY valid JSON:
{
  "action": "ADD|UPDATE|NOOP",
  "supersede_ids": [],
  "reason": "Brief explanation"
}

Rules:
- ADD: The new memory contains genuinely new information not covered by existing memories. This is the most common action.
- UPDATE: The new memory updates or corrects information in one or more existing memories. List the IDs to supersede in supersede_ids. Use this when the new memory contradicts or refines an existing one.
- NOOP: The new memory is a near-duplicate of an existing memory. Nothing to store. Only use NOOP when the existing memory already captures the same information with equivalent or better detail.

Bias toward ADD — only use UPDATE when there is a clear contradiction or refinement, and only use NOOP when it is truly a duplicate.`;

/**
 * Extract structured memories from raw content using Gemini Flash.
 */
async function extract(content, source) {
  if (!GEMINI_API_KEY) {
    return extractFallback(content, source);
  }

  try {
    const body = JSON.stringify({
      contents: [{
        parts: [{
          text: `${EXTRACTION_PROMPT}\n\nSource: ${source || 'unknown'}\n\nContent:\n${content.slice(0, 8000)}`
        }]
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 2000,
        responseMimeType: 'application/json',
      }
    });

    const response = await httpPost(GEMINI_URL, body);
    const text = response.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      console.warn('[extractor] Empty Gemini response, using fallback');
      return extractFallback(content, source);
    }

    const parsed = JSON.parse(text);
    return parsed.memories || [];
  } catch (err) {
    console.error('[extractor] Gemini extraction failed:', err.message);
    return extractFallback(content, source);
  }
}

/**
 * Detect contradictions between new content and existing memories.
 * Returns { action: 'ADD'|'UPDATE'|'NOOP', supersede_ids: number[], reason: string }
 */
async function detectContradiction(newContent, existingMemories) {
  if (!GEMINI_API_KEY || !existingMemories.length) {
    return { action: 'ADD', supersede_ids: [], reason: 'No Gemini or no existing memories to compare' };
  }

  const existingText = existingMemories.map(m =>
    `[ID:${m.id}] (${m.memory_type}, importance: ${m.importance}) ${m.content}`
  ).join('\n');

  try {
    const body = JSON.stringify({
      contents: [{
        parts: [{
          text: `${CONTRADICTION_PROMPT}\n\nNEW MEMORY:\n${newContent}\n\nEXISTING MEMORIES:\n${existingText}`
        }]
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 500,
        responseMimeType: 'application/json',
      }
    });

    const response = await httpPost(GEMINI_URL, body);
    const text = response.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) return { action: 'ADD', supersede_ids: [], reason: 'Empty response' };
    const parsed = JSON.parse(text);
    return {
      action: parsed.action || 'ADD',
      supersede_ids: parsed.supersede_ids || [],
      reason: parsed.reason || '',
    };
  } catch (err) {
    console.error('[extractor] Contradiction detection failed:', err.message);
    return { action: 'ADD', supersede_ids: [], reason: `Error: ${err.message}` };
  }
}

/**
 * Simple heuristic extraction when no LLM is available.
 * Splits content into sentences and assigns basic metadata.
 */
function extractFallback(content, source) {
  // Don't extract trivial content
  if (content.length < 20) return [];

  // Simple entity extraction — capitalized words that aren't sentence starters
  const entityPattern = /(?:^|\s)([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/g;
  const entities = [];
  let match;
  while ((match = entityPattern.exec(content)) !== null) {
    const ent = match[1].trim();
    if (ent.length > 2 && !['The', 'This', 'That', 'When', 'What', 'How', 'Why', 'And', 'But', 'For'].includes(ent)) {
      entities.push(ent);
    }
  }

  // Simple topic extraction from common keywords
  const topicKeywords = {
    deploy: 'deployment', config: 'configuration', error: 'errors', fix: 'bugfix',
    test: 'testing', build: 'build', api: 'api', database: 'database', db: 'database',
    auth: 'authentication', user: 'users', payment: 'billing', security: 'security',
    performance: 'performance', cache: 'caching', migration: 'migration',
  };
  const topics = [];
  const lower = content.toLowerCase();
  for (const [kw, topic] of Object.entries(topicKeywords)) {
    if (lower.includes(kw) && !topics.includes(topic)) topics.push(topic);
  }

  // Estimate importance
  let importance = 0.5;
  if (lower.includes('critical') || lower.includes('security') || lower.includes('breaking')) importance = 0.9;
  else if (lower.includes('important') || lower.includes('deadline') || lower.includes('revenue')) importance = 0.7;
  else if (lower.includes('minor') || lower.includes('trivial') || lower.includes('cleanup')) importance = 0.3;

  return [{
    content: content.slice(0, 500),
    memory_type: 'observation',
    summary: content.slice(0, 100),
    entities: [...new Set(entities)].slice(0, 10),
    topics: topics.slice(0, 4),
    importance,
    edges: [],
  }];
}

/**
 * Consolidation prompt — takes a cluster of memories and produces a summary.
 */
async function consolidate(memories) {
  if (!GEMINI_API_KEY) {
    return consolidateFallback(memories);
  }

  const memoriesText = memories.map((m, i) =>
    `[${i + 1}] (${m.memory_type}, importance: ${m.importance}) ${m.content}`
  ).join('\n');

  const prompt = `You are a memory consolidation engine. Given a cluster of related memories, produce a single consolidated summary.

Return ONLY valid JSON:
{
  "content": "Consolidated summary combining key information from all memories (2-4 sentences)",
  "summary": "One-line summary",
  "entities": ["merged entity list"],
  "topics": ["merged topic list"],
  "importance": 0.7,
  "insight": "Any cross-cutting pattern or insight discovered across these memories (1 sentence, or null)",
  "edges": [
    {"subject": "Entity A", "predicate": "uses", "object": "Entity B", "confidence": 0.9}
  ]
}

Rules:
- Merge duplicate information, keep the most specific version.
- Importance should be the max of the input memories (consolidated knowledge is more valuable).
- Keep entities and topics merged and deduplicated.
- The insight field should capture any pattern that isn't obvious from individual memories.
- Extract entity relationship edges from the consolidated knowledge.

Memories to consolidate:
${memoriesText}`;

  try {
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 1000,
        responseMimeType: 'application/json',
      }
    });

    const response = await httpPost(GEMINI_URL, body);
    const text = response.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) return consolidateFallback(memories);
    return JSON.parse(text);
  } catch (err) {
    console.error('[extractor] Gemini consolidation failed:', err.message);
    return consolidateFallback(memories);
  }
}

function consolidateFallback(memories) {
  const allEntities = new Set();
  const allTopics = new Set();
  let maxImportance = 0;

  for (const m of memories) {
    const entities = Array.isArray(m.entities) ? m.entities : JSON.parse(m.entities || '[]');
    const topics = Array.isArray(m.topics) ? m.topics : JSON.parse(m.topics || '[]');
    entities.forEach(e => allEntities.add(e));
    topics.forEach(t => allTopics.add(t));
    if (m.importance > maxImportance) maxImportance = m.importance;
  }

  return {
    content: memories.map(m => m.content.slice(0, 100)).join(' | '),
    summary: `Consolidated ${memories.length} memories`,
    entities: [...allEntities],
    topics: [...allTopics],
    importance: maxImportance,
    insight: null,
    edges: [],
  };
}

// ─── HTTP Helper ────────────────────────────────────────────────────────────

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Invalid JSON: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

module.exports = { extract, consolidate, detectContradiction };
