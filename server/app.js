import express from 'express';
import { createServer } from 'node:http';
import process from 'node:process';
import cors from 'cors';
import dotenv from 'dotenv';
import { Server as SocketIOServer } from 'socket.io';
import { connectDB } from './config/db.js';

import InterviewSession from './models/InterviewSession.js';
import Transcript from './models/Transcript.js';
import MonitoringEvent from './models/MonitoringEvent.js';

import dashboardRoutes from './routes/dashboard.js';
import interviewEngine from './services/InterviewEngine.js';

dotenv.config();

export async function startWorker() {
  // Connect to DB before accepting traffic
  await connectDB();

  const app = express();
  const server = createServer(app);

  // Create Socket.IO server attached to the HTTP server
  const port = process.env.PORT || 3001;
  const corsOrigin = process.env.CORS_ORIGIN || '*';

  const io = new SocketIOServer(server, {
    cors: {
      origin: corsOrigin === '*' ? '*' : corsOrigin,
      credentials: true,
    },
  });

  const interviewNs = io.of('/interview');

  // Middleware
  app.use(
    cors(
      corsOrigin === '*'
        ? undefined
        : {
            origin: corsOrigin,
          }
    )
  );
  app.use(express.json());

  // REST Routing
  app.use('/api/dashboard', dashboardRoutes);

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', workerProcessId: process.pid });
  });

  // Socket.IO interview namespace handling (spec-aligned event names)
  interviewNs.on('connection', (socket) => {
    console.log(`[Worker ${process.pid}] New Socket.IO connection on /interview: ${socket.id}`);

    const ensureString = (val) => (typeof val === 'string' ? val : '');

    socket.on('session:start', async (payload) => {
      try {
        console.log('[SocketIO] session:start', payload?.sessionId);
        // Minimal integration: create a session document if not already present.
        // We currently don't store sessionId/candidateId in schema; reuse existing fields.
        await InterviewSession.create({
          candidateName: payload?.candidateId || 'Candidate',
          jobRole: 'Unspecified',
          status: 'in-progress',
          startTime: new Date(payload?.timestamp || Date.now()),
          deviceInfo: payload?.device || {},
        });
      } catch (err) {
        console.error('[SocketIO] Error handling session:start', err);
      }
    });

    socket.on('transcript:final', async (payload) => {
      try {
        const text = ensureString(payload?.text);
        if (!text) return;

        // Persist transcript text for now without tying to spec sessionId
        await Transcript.create({
          // sessionId mapping could be added once schema is extended
          sessionId: payload.sessionId || null,
          text,
          isFinal: true,
          timestamp: new Date(payload?.timestamp || Date.now()),
        }).catch((e) => console.error(e));

        console.log('[SocketIO] transcript:final received');
      } catch (err) {
        console.error('[SocketIO] Error handling transcript:final', err);
      }
    });

    socket.on('monitoring:face', async (payload) => {
      try {
        await MonitoringEvent.create({
          sessionId: payload.sessionId || null,
          type: 'monitoring:face',
          payload,
          clientTimestamp: payload?.timestamp,
        }).catch((e) => console.error(e));
      } catch (err) {
        console.error('[SocketIO] Error handling monitoring:face', err);
      }
    });

    socket.on('monitoring:tabswitch', async (payload) => {
      try {
        await MonitoringEvent.create({
          sessionId: payload.sessionId || null,
          type: 'monitoring:tabswitch',
          payload,
          clientTimestamp: payload?.timestamp,
        }).catch((e) => console.error(e));
      } catch (err) {
        console.error('[SocketIO] Error handling monitoring:tabswitch', err);
      }
    });

    socket.on('vad:event', async (payload) => {
      try {
        await MonitoringEvent.create({
          sessionId: payload.sessionId || null,
          type: 'vad:event',
          payload,
          clientTimestamp: payload?.timestamp,
        }).catch((e) => console.error(e));
      } catch (err) {
        console.error('[SocketIO] Error handling vad:event', err);
      }
    });

    socket.on('session:end', async (payload) => {
      try {
        console.log('[SocketIO] session:end', payload?.sessionId);
        // For now, just log; full mapping to InterviewSession can be added when schema includes sessionId.
      } catch (err) {
        console.error('[SocketIO] Error handling session:end', err);
      }
    });
  });

  server.listen(port, () => {
    console.log(`[Worker ${process.pid}] HTTP & Socket.IO Server listening on port ${port}`);
  });
}
