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

dotenv.config();

export async function startWorker() {
  // Connect to DB before accepting traffic
  await connectDB();

  const app = express();
  const server = createServer(app);
  
  // Create WebSocket Server attached to the HTTP server
  const wss = new WebSocketServer({ server });

  const port = process.env.PORT || 3002;

  // Middleware
  const corsOrigin = process.env.CORS_ORIGIN || '*';
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

  // WebSocket connection handling
  wss.on('connection', (ws, req) => {
    console.log(`[Worker ${process.pid}] New WebSocket connection established.`);
    
    // Send a welcome ping to confirm connection
    ws.send(JSON.stringify({ type: 'pong', payload: { message: 'connected to worker ' + process.pid } }));

    ws.on('message', (message) => {
      try {
        const parsedMessage = JSON.parse(message);
        
        // Handle heartbeat logic
        if (parsedMessage.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', payload: {} }));
          return;
        }

        const sessionId = ws.sessionId;

        const ensureString = (val) => (typeof val === 'string' ? val : '');
        const ensureBoolean = (val) => (typeof val === 'boolean' ? val : false);

        // Message Routing
        if (parsedMessage.type === 'transcript') {
          const payload = parsedMessage.payload || {};
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
            timestamp: parsedMessage.timestamp
              ? new Date(parsedMessage.timestamp)
              : new Date(),
          }).catch(e => console.error(e));

          // Pass to AI Engine for turn-taking logic (only on final segments)
          interviewEngine.handleCandidateResponse(sessionId, ws, text, isFinal);
          console.log(`[Worker ${process.pid}] Received transcript: ${text}`);
        } else if (parsedMessage.type === 'monitoring_event') {
          const payload = parsedMessage.payload || {};
          const eventType = ensureString(payload.type);
          if (!sessionId || !eventType) {
            console.warn('[Worker] Invalid monitoring_event payload or missing sessionId.');
            return;
          }

          MonitoringEvent.create({
            sessionId,
            type: eventType,
            payload,
            clientTimestamp: parsedMessage.timestamp || payload.timestamp,
          }).catch(e => console.error(e));
          console.log(`[Worker ${process.pid}] Received monitoring event: ${eventType}`);
        } else if (parsedMessage.type === 'monitoring_batch') {
          const payload = parsedMessage.payload || {};
          const events = Array.isArray(payload.events) ? payload.events : [];
          if (sessionId && events.length > 0) {
            const eventsToInsert = events
              .filter(e => e && typeof e.type === 'string')
              .map(e => ({
                sessionId,
                type: e.type,
                payload: e,
                clientTimestamp: e.timestamp,
              }));
            if (eventsToInsert.length > 0) {
              MonitoringEvent.insertMany(eventsToInsert).catch(e => console.error(e));
            }
          }
          console.log(
            `[Worker ${process.pid}] Received monitoring batch of ${payload.count || 0} events.`
          );
        } else if (parsedMessage.type === 'start_interview') {
          const payload = parsedMessage.payload || {};
          const name = ensureString(payload.name) || 'Candidate';
          const role = ensureString(payload.role) || 'Unspecified';

          InterviewSession.create({
            candidateName: name,
            jobRole: role,
            status: 'in-progress',
            startTime: new Date(),
            deviceInfo: payload.deviceInfo || {},
          })
            .then(doc => {
              ws.sessionId = doc._id;
              console.log(`[Worker ${process.pid}] Session started: ${ws.sessionId}`);
              // Let the AI engine orchestrate the questions
              interviewEngine.startSession(doc._id, ws).catch(err => {
                console.error('[Worker] Failed to start interview session via InterviewEngine:', err);
              });
            })
            .catch(e => console.error(e));
        } else if (parsedMessage.type === 'end_interview') {
          const payload = parsedMessage.payload || {};
          const reason = ensureString(payload.reason) || 'unknown';
          if (!sessionId) {
            console.warn('[Worker] end_interview received without a sessionId.');
            return;
          }

          const update = {
            endTime: new Date(),
          };

          // For a normal candidate-initiated end, we trigger a best-effort evaluation
          // and let the InterviewEngine set status to "completed".
          if (reason !== 'candidate_ended') {
            update.status = 'aborted';
          } else {
            interviewEngine.triggerEvaluation(sessionId, ws).catch(err => {
              console.error('[Worker] Failed to trigger evaluation on end_interview:', err);
            });
          }

          InterviewSession.findByIdAndUpdate(sessionId, update, {
            writeConcern: { w: 'majority', wtimeout: 5000 },
          }).catch(e => console.error(e));

          console.log(
            `[Worker ${process.pid}] end_interview received for session ${sessionId} (reason=${reason}).`
          );
        } else {
          console.log(`[Worker ${process.pid}] Received unknown message type: ${parsedMessage.type}`);
        }

      } catch (err) {
        console.error(`[Worker ${process.pid}] Error parsing WebSocket message:`, err);
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
