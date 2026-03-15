import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import process from 'node:process';
import cors from 'cors';
import dotenv from 'dotenv';
import { connectDB } from './config/db.js';

import InterviewSession from './models/InterviewSession.js';
import Transcript from './models/Transcript.js';
import MonitoringEvent from './models/MonitoringEvent.js';

import dashboardRoutes from './routes/dashboard.js';
import interviewEngine from './services/InterviewEngine.js';
import {
  generalApiLimiter,
  dashboardApiLimiter,
  initWsBuckets,
  checkWsRateLimit,
} from './middleware/rateLimiter.js';

dotenv.config();

export async function startWorker() {
  await connectDB();

  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ server });
  const port = process.env.PORT || 3002;

  // --- CORS ---
  const corsOrigin = process.env.CORS_ORIGIN || '*';
  app.use(cors(corsOrigin === '*' ? undefined : { origin: corsOrigin }));
  app.use(express.json());

  // --- HTTP Rate Limiters (Phase 5) ---
  app.use('/api/', generalApiLimiter);
  app.use('/api/dashboard', dashboardApiLimiter);

  // --- REST Routes ---
  app.use('/api/dashboard', dashboardRoutes);

  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      workerProcessId: process.pid,
      evalQueue: interviewEngine.getQueueMetrics(),
    });
  });

  // --- WebSocket Handler ---
  wss.on('connection', (ws) => {
    console.log(`[Worker ${process.pid}] New WebSocket connection.`);

    initWsBuckets(ws);

    ws.send(JSON.stringify({ type: 'pong', payload: { message: 'connected to worker ' + process.pid } }));

    ws.on('message', (message) => {
      try {
        const msg = JSON.parse(message);
        const type = msg.type || '';

        // --- WebSocket Rate Limit (Phase 5) ---
        if (!checkWsRateLimit(ws, type)) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'Rate limit exceeded. Slow down.' } }));
          return;
        }

        if (type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', payload: {} }));
          return;
        }

        const sessionId = ws.sessionId;
        const ensureString = (v) => (typeof v === 'string' ? v : '');
        const ensureBoolean = (v) => (typeof v === 'boolean' ? v : false);

        if (type === 'transcript') {
          const payload = msg.payload || {};
          const text = ensureString(payload.text);
          const isFinal = ensureBoolean(payload.isFinal);

          if (!sessionId || !text) {
            console.warn('[Worker] Invalid transcript payload or missing sessionId.');
            return;
          }

          Transcript.create({
            sessionId,
            text,
            isFinal,
            timestamp: msg.timestamp ? new Date(msg.timestamp) : new Date(),
          }).catch((e) => console.error('[Worker] Transcript save error:', e));

          interviewEngine.handleCandidateResponse(sessionId, ws, text, isFinal);

        } else if (type === 'monitoring_event') {
          const payload = msg.payload || {};
          const eventType = ensureString(payload.type);

          if (!sessionId || !eventType) {
            console.warn('[Worker] Invalid monitoring_event payload.');
            return;
          }

          MonitoringEvent.create({
            sessionId,
            type: eventType,
            payload,
            clientTimestamp: msg.timestamp || payload.timestamp,
          }).catch((e) => console.error('[Worker] MonitoringEvent save error:', e));

        } else if (type === 'monitoring_batch') {
          const payload = msg.payload || {};
          const events = Array.isArray(payload.events) ? payload.events : [];

          if (sessionId && events.length > 0) {
            const docs = events
              .filter((e) => e && typeof e.type === 'string')
              .map((e) => ({
                sessionId,
                type: e.type,
                payload: e,
                clientTimestamp: e.timestamp,
              }));
            if (docs.length > 0) {
              MonitoringEvent.insertMany(docs).catch((e) => console.error('[Worker] Batch insert error:', e));
            }
          }

        } else if (type === 'start_interview') {
          const payload = msg.payload || {};
          const name = ensureString(payload.name) || 'Candidate';
          const role = ensureString(payload.role) || 'Unspecified';

          InterviewSession.create({
            candidateName: name,
            jobRole: role,
            status: 'in-progress',
            startTime: new Date(),
            deviceInfo: payload.deviceInfo || {},
          })
            .then((doc) => {
              ws.sessionId = doc._id;
              console.log(`[Worker ${process.pid}] Session started: ${doc._id}`);
              return interviewEngine.startSession(doc._id, ws);
            })
            .catch((e) => console.error('[Worker] start_interview error:', e));

        } else if (type === 'end_interview') {
          const payload = msg.payload || {};
          const reason = ensureString(payload.reason) || 'unknown';

          if (!sessionId) {
            console.warn('[Worker] end_interview received without sessionId.');
            return;
          }

          const update = { endTime: new Date() };

          if (reason === 'candidate_ended') {
            interviewEngine.triggerEvaluation(sessionId, ws);
          } else {
            update.status = 'aborted';
          }

          InterviewSession.findByIdAndUpdate(sessionId, update, {
            writeConcern: { w: 'majority', wtimeout: 5000 },
          }).catch((e) => console.error('[Worker] end_interview DB update error:', e));

          console.log(`[Worker ${process.pid}] end_interview for session ${sessionId} (reason=${reason})`);

        } else {
          console.log(`[Worker ${process.pid}] Unknown message type: ${type}`);
        }

      } catch (err) {
        console.error(`[Worker ${process.pid}] WS message error:`, err);
      }
    });

    ws.on('close', () => {
      console.log(`[Worker ${process.pid}] WebSocket connection closed.`);
    });
  });

  server.listen(port, () => {
    console.log(`[Worker ${process.pid}] HTTP & WebSocket Server listening on port ${port}`);
  });
}
