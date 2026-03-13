#!/usr/bin/env node
/**
 * Interactive setup wizard for Agent Memory Service.
 * Run: node scripts/setup.js
 *
 * Generates a .env file and validates configuration.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const https = require('https');
const http = require('http');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(r => rl.question(q, r));

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  Agent Memory Service — Setup                ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');

  const config = {};

  // Port
  config.PORT = await ask('Server port [3005]: ') || '3005';

  // Database path
  config.MEMORY_DB_PATH = await ask('Database path [./data/memory.db]: ') || './data/memory.db';

  // Gemini
  console.log('');
  console.log('Gemini Flash is used for smart memory extraction (optional).');
  console.log('Get a free key at: https://aistudio.google.com/apikey');
  config.GEMINI_API_KEY = await ask('Gemini API key (enter to skip): ');

  if (config.GEMINI_API_KEY) {
    config.GEMINI_MODEL = await ask('Gemini model [gemini-2.5-flash-preview-05-20]: ') || 'gemini-2.5-flash-preview-05-20';

    // Test Gemini key
    process.stdout.write('Testing Gemini key... ');
    try {
      const result = await testGemini(config.GEMINI_API_KEY, config.GEMINI_MODEL);
      if (result.ok) {
        console.log('OK');
      } else {
        console.log(`FAILED: ${result.error}`);
        console.log('Continuing without Gemini (fallback extraction will be used).');
        config.GEMINI_API_KEY = '';
      }
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      console.log('Continuing without Gemini.');
      config.GEMINI_API_KEY = '';
    }
  }

  // API auth
  console.log('');
  console.log('Optional: Set an API key to require authentication.');
  config.MEMORY_API_KEY = await ask('API auth key (enter to skip): ');

  // Consolidation
  console.log('');
  const intervalHours = await ask('Consolidation interval in hours [6]: ') || '6';
  config.CONSOLIDATION_INTERVAL_MS = String(parseInt(intervalHours) * 60 * 60 * 1000);
  config.CONSOLIDATION_THRESHOLD = await ask('Min memories before consolidation [10]: ') || '10';
  config.CONSOLIDATION_BATCH_SIZE = await ask('Max memories per consolidation batch [50]: ') || '50';

  // Write .env
  const envPath = path.join(process.cwd(), '.env');
  const envLines = [];
  for (const [key, value] of Object.entries(config)) {
    if (value) envLines.push(`${key}=${value}`);
  }
  fs.writeFileSync(envPath, envLines.join('\n') + '\n');
  console.log('');
  console.log(`Wrote ${envPath}`);

  // Ensure data directory exists
  const dbDir = path.dirname(config.MEMORY_DB_PATH);
  fs.mkdirSync(dbDir, { recursive: true });
  console.log(`Created ${dbDir}/`);

  // Summary
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  Setup Complete                              ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Port:           ${config.PORT}`);
  console.log(`  Database:       ${config.MEMORY_DB_PATH}`);
  console.log(`  Gemini:         ${config.GEMINI_API_KEY ? 'Enabled' : 'Disabled (fallback mode)'}`);
  console.log(`  Auth:           ${config.MEMORY_API_KEY ? 'Enabled' : 'Open (no auth)'}`);
  console.log(`  Consolidation:  Every ${intervalHours}h, threshold ${config.CONSOLIDATION_THRESHOLD}, batch ${config.CONSOLIDATION_BATCH_SIZE}`);
  console.log('');
  console.log('  Start the service:');
  console.log('    npm start');
  console.log('');
  console.log('  Or with Docker:');
  console.log('    docker build -t agent-memory-service .');
  console.log('    docker run -p 3005:3005 -v memory-data:/data --env-file .env agent-memory-service');
  console.log('');
  console.log('  Connect your AI tools:');
  console.log('    See docs/CLAUDE-CODE-SETUP.md');
  console.log('');

  rl.close();
}

function testGemini(apiKey, model) {
  return new Promise((resolve, reject) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const body = JSON.stringify({
      contents: [{ parts: [{ text: 'Reply with just the word "ok"' }] }],
      generationConfig: { maxOutputTokens: 10 }
    });

    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) resolve({ ok: false, error: json.error.message });
          else if (json.candidates) resolve({ ok: true });
          else resolve({ ok: false, error: 'Unexpected response' });
        } catch { resolve({ ok: false, error: data.slice(0, 100) }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

main().catch(err => {
  console.error('Setup failed:', err);
  rl.close();
  process.exit(1);
});
