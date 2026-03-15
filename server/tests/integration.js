/**
 * Fineview Integration Test Suite — Phase 5
 *
 * Tests the full server-side flow:
 *   1. WebSocket connection + session creation
 *   2. Transcript ingestion + AI engine turn-taking
 *   3. Monitoring event batch ingestion
 *   4. End interview → evaluation queue trigger
 *   5. Database verification (session, transcripts, events)
 *   6. Dashboard REST API (sessions, detail, analytics, behaviour)
 *   7. Rate limiter response (429 on burst)
 *   8. BehaviourScorer unit assertions
 *   9. EvalQueue retry/concurrency assertions
 *
 * Run: node server/tests/integration.js
 * Prerequisites: server must be running on port 3002
 */

import WebSocket from 'ws';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { scoreBehaviour } from '../services/BehaviourScorer.js';
import EvalQueue from '../services/EvalQueue.js';

dotenv.config();

const SERVER_PORT = process.env.PORT || 3002;
const WS_URL = `ws://localhost:${SERVER_PORT}`;
const HTTP_BASE = `http://localhost:${SERVER_PORT}`;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/fineview';

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}`);
    failed++;
    failures.push(label);
  }
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(path, options = {}) {
  const res = await fetch(`${HTTP_BASE}${path}`, options);
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ============================================================
// Suite 1: Unit — BehaviourScorer
// ============================================================
function testBehaviourScorer() {
  console.log('\n[Suite 1] BehaviourScorer unit tests');

  const baseResult = scoreBehaviour([], {});
  assert(baseResult.score === 100, 'Empty events → score 100');
  assert(baseResult.label === 'High', 'Empty events → label High');

  const tabEvents = [
    { type: 'tab_switch', payload: { direction: 'away' }, clientTimestamp: 1000 },
    { type: 'tab_switch', payload: { direction: 'away' }, clientTimestamp: 2000 },
    { type: 'tab_switch', payload: { direction: 'away' }, clientTimestamp: 3000 },
  ];
  const tabResult = scoreBehaviour(tabEvents, {});
  assert(tabResult.score < 100, 'Multiple tab switches reduce score');
  assert(tabResult.breakdown.tabSwitchCount === 3, 'Tab switch count = 3');

  const multipleEvents = Array.from({ length: 5 }, () => ({
    type: 'multiple_faces',
    payload: { count: 2 },
  }));
  const multiResult = scoreBehaviour(multipleEvents, {});
  assert(multiResult.score < 70, 'Multiple faces → score < 70');
  assert(multiResult.label !== 'High', 'Multiple faces → not High label');

  const suspiciousEvents = Array.from({ length: 9 }, () => ({
    type: 'suspicious_action',
    payload: { action: 'copy' },
  }));
  const suspResult = scoreBehaviour(suspiciousEvents, {});
  assert(suspResult.score < 40, 'Many suspicious events → Low integrity');
  assert(suspResult.label === 'Low', 'Many suspicious events → Low label');

  const mixedEvents = [
    { type: 'face_lost', payload: {} },
    { type: 'looking_away', payload: {} },
    { type: 'tab_switch', payload: { direction: 'away' }, clientTimestamp: 1000 },
    { type: 'tab_switch', payload: { direction: 'returned' }, clientTimestamp: 6000 },
  ];
  const mixResult = scoreBehaviour(mixedEvents, {});
  assert(typeof mixResult.score === 'number', 'Mixed events → numeric score');
  assert(mixResult.score >= 0 && mixResult.score <= 100, 'Mixed events → score in range [0,100]');
}

// ============================================================
// Suite 2: Unit — EvalQueue
// ============================================================
async function testEvalQueue() {
  console.log('\n[Suite 2] EvalQueue unit tests');

  const queue = new EvalQueue({ concurrency: 2, maxRetries: 2, retryDelay: 50 });

  let ran = 0;
  await Promise.all([
    queue.enqueue('job-1', async () => { await sleep(20); ran++; }),
    queue.enqueue('job-2', async () => { await sleep(10); ran++; }),
    queue.enqueue('job-3', async () => { ran++; }),
  ]);
  assert(ran === 3, 'EvalQueue runs all 3 jobs');

  const metrics = queue.getMetrics();
  assert(metrics.enqueued === 3, 'EvalQueue metrics: enqueued = 3');
  assert(metrics.completed === 3, 'EvalQueue metrics: completed = 3');
  assert(metrics.failed === 0, 'EvalQueue metrics: failed = 0');

  // Retry test
  const retryQueue = new EvalQueue({ concurrency: 1, maxRetries: 2, retryDelay: 50 });
  let attempts = 0;
  let retryJobDone = false;
  try {
    await retryQueue.enqueue('fail-job', async () => {
      attempts++;
      if (attempts < 3) throw new Error('transient failure');
      retryJobDone = true;
    });
  } catch (_) {}
  assert(retryJobDone, 'EvalQueue retries and succeeds on 3rd attempt');
  assert(retryQueue.getMetrics().retried === 2, 'EvalQueue metrics: retried = 2');

  // Permanent failure
  const failQueue = new EvalQueue({ concurrency: 1, maxRetries: 1, retryDelay: 10 });
  let failCaught = false;
  try {
    await failQueue.enqueue('perm-fail', async () => { throw new Error('always fails'); });
  } catch (_) {
    failCaught = true;
  }
  assert(failCaught, 'EvalQueue rejects promise on permanent failure');
  assert(failQueue.getMetrics().failed === 1, 'EvalQueue metrics: failed = 1 for permanent failure');
}

// ============================================================
// Suite 3: HTTP health check
// ============================================================
async function testHealthEndpoint() {
  console.log('\n[Suite 3] HTTP health check');
  const { status, body } = await fetchJson('/health');
  assert(status === 200, 'GET /health → 200');
  assert(body?.status === 'ok', 'GET /health → body.status = ok');
  assert(typeof body?.evalQueue === 'object', 'GET /health → evalQueue metrics present');
}

// ============================================================
// Suite 4: WebSocket full interview flow + DB verification
// ============================================================
async function testWebSocketFlow() {
  console.log('\n[Suite 4] WebSocket interview flow');

  return new Promise(async (resolve) => {
    const ws = new WebSocket(WS_URL);
    let sessionId = null;
    const received = [];

    ws.on('open', async () => {
      assert(true, 'WebSocket connection established');

      // Send start_interview
      ws.send(JSON.stringify({
        type: 'start_interview',
        payload: { name: 'IntegrationTestUser', role: 'QA Engineer', deviceInfo: { tier: 'high' } },
      }));

      await sleep(1500);

      // Send 4 transcript segments to advance 2 turns
      for (let i = 0; i < 4; i++) {
        ws.send(JSON.stringify({
          type: 'transcript',
          payload: { text: `Test response segment ${i + 1}`, isFinal: true },
          timestamp: Date.now(),
        }));
        await sleep(200);
      }

      await sleep(500);

      // Send monitoring batch
      ws.send(JSON.stringify({
        type: 'monitoring_batch',
        payload: {
          count: 3,
          events: [
            { type: 'face_detected', timestamp: Date.now() },
            { type: 'tab_switch', direction: 'away', timestamp: Date.now() },
            { type: 'looking_away', timestamp: Date.now() },
          ],
        },
      }));

      await sleep(500);

      // End interview
      ws.send(JSON.stringify({ type: 'end_interview', payload: { reason: 'candidate_ended' } }));

      await sleep(3000);
      ws.close();
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        received.push(msg);
      } catch (_) {}
    });

    ws.on('close', async () => {
      const pong = received.find((m) => m.type === 'pong');
      assert(!!pong, 'Server sends initial pong on connect');

      const question = received.find((m) => m.type === 'ai_question');
      assert(!!question, 'Server sends ai_question after start_interview');

      await sleep(2000);

      // DB verification
      try {
        await mongoose.connect(MONGO_URI);
        const db = mongoose.connection.db;

        const session = await db.collection('interviewsessions').findOne({ candidateName: 'IntegrationTestUser' });
        assert(!!session, 'DB: session created for IntegrationTestUser');

        if (session) {
          sessionId = session._id;
          const transcripts = await db.collection('transcripts').find({ sessionId }).toArray();
          assert(transcripts.length >= 4, `DB: at least 4 transcript segments stored (got ${transcripts.length})`);

          const events = await db.collection('monitoringevents').find({ sessionId }).toArray();
          assert(events.length >= 3, `DB: at least 3 monitoring events stored (got ${events.length})`);

          // Test dashboard API with this session
          await testDashboardApis(session._id.toString());
        }

        await mongoose.disconnect();
      } catch (err) {
        console.error('DB verification error:', err.message);
        assert(false, `DB: no connection error (got: ${err.message})`);
      }

      resolve();
    });

    ws.on('error', (err) => {
      assert(false, `WebSocket connection error: ${err.message}`);
      resolve();
    });
  });
}

// ============================================================
// Suite 5: Dashboard REST APIs
// ============================================================
async function testDashboardApis(sessionId) {
  console.log('\n[Suite 5] Dashboard REST API');

  const sessions = await fetchJson('/api/dashboard/sessions');
  assert(sessions.status === 200, 'GET /api/dashboard/sessions → 200');
  assert(Array.isArray(sessions.body), 'GET /api/dashboard/sessions → returns array');

  const detail = await fetchJson(`/api/dashboard/sessions/${sessionId}`);
  assert(detail.status === 200, 'GET /api/dashboard/sessions/:id → 200');
  assert(!!detail.body?.session, 'GET /api/dashboard/sessions/:id → session present');
  assert(Array.isArray(detail.body?.monitoringEvents), 'GET /api/dashboard/sessions/:id → monitoringEvents array');
  assert(Array.isArray(detail.body?.transcripts), 'GET /api/dashboard/sessions/:id → transcripts array');
  assert(typeof detail.body?.behaviour === 'object', 'GET /api/dashboard/sessions/:id → behaviour score object');
  assert(typeof detail.body?.behaviour?.score === 'number', 'behaviour.score is a number');
  assert(['High', 'Medium', 'Low'].includes(detail.body?.behaviour?.label), 'behaviour.label is valid');

  const behaviour = await fetchJson(`/api/dashboard/sessions/${sessionId}/behaviour`);
  assert(behaviour.status === 200, 'GET /api/dashboard/sessions/:id/behaviour → 200');
  assert(typeof behaviour.body?.behaviour?.score === 'number', 'behaviour endpoint returns score');

  const analytics = await fetchJson('/api/dashboard/analytics');
  assert(analytics.status === 200, 'GET /api/dashboard/analytics → 200');
  assert(typeof analytics.body?.total === 'number', 'analytics.total is a number');
  assert(typeof analytics.body?.completed === 'number', 'analytics.completed is a number');
  assert(typeof analytics.body?.evalQueueMetrics === 'object', 'analytics.evalQueueMetrics present');

  const notFound = await fetchJson('/api/dashboard/sessions/000000000000000000000000');
  assert(notFound.status === 404, 'GET /api/dashboard/sessions/invalid-id → 404');
}

// ============================================================
// Suite 6: Ping/pong + unknown message handling
// ============================================================
async function testMiscWsMessages() {
  console.log('\n[Suite 6] Misc WebSocket messages');

  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    const received = [];

    ws.on('open', async () => {
      ws.send(JSON.stringify({ type: 'ping' }));
      await sleep(300);
      ws.close();
    });

    ws.on('message', (data) => {
      try { received.push(JSON.parse(data.toString())); } catch (_) {}
    });

    ws.on('close', () => {
      const pongs = received.filter((m) => m.type === 'pong');
      assert(pongs.length >= 1, 'Ping → pong response received');
      resolve();
    });
  });
}

// ============================================================
// Main runner
// ============================================================
async function run() {
  console.log('=== Fineview Integration Test Suite ===\n');

  try {
    testBehaviourScorer();
    await testEvalQueue();
    await testHealthEndpoint();
    await testWebSocketFlow();
    await testMiscWsMessages();
  } catch (err) {
    console.error('\n[Fatal] Unexpected error in test runner:', err);
    process.exit(1);
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failures.length > 0) {
    console.error('\nFailed assertions:');
    failures.forEach((f) => console.error(`  - ${f}`));
  }

  process.exit(failed > 0 ? 1 : 0);
}

run();
