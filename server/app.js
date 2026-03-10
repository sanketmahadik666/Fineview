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

  const port = process.env.PORT || 3001;

  // Middleware
  app.use(cors());
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

        // Message Routing
        if (parsedMessage.type === 'transcript') {
          if (sessionId) {
            Transcript.create({
              sessionId,
              text: parsedMessage.payload.text,
              isFinal: parsedMessage.payload.isFinal,
              timestamp: new Date(parsedMessage.timestamp),
            }).catch(e => console.error(e));

            // Pass to AI Engine for turn-taking logic
            interviewEngine.handleCandidateResponse(sessionId, ws, parsedMessage.payload.text, parsedMessage.payload.isFinal);
          }
          console.log(`[Worker ${process.pid}] Received transcript: ${parsedMessage.payload.text}`);
        } else if (parsedMessage.type === 'monitoring_event') {
          if (sessionId) {
            MonitoringEvent.create({
              sessionId,
              type: parsedMessage.payload.type,
              payload: parsedMessage.payload,
              clientTimestamp: parsedMessage.timestamp
            }).catch(e => console.error(e));
          }
          console.log(`[Worker ${process.pid}] Received monitoring event: ${parsedMessage.payload.type}`);
        } else if (parsedMessage.type === 'monitoring_batch') {
          if (sessionId && parsedMessage.payload.events) {
            const eventsToInsert = parsedMessage.payload.events.map(e => ({
              sessionId,
              type: e.type,
              payload: e,
              clientTimestamp: e.timestamp
            }));
            // Insert many efficiently 
            MonitoringEvent.insertMany(eventsToInsert).catch(e => console.error(e));
          }
          console.log(`[Worker ${process.pid}] Received monitoring batch of ${parsedMessage.payload.count} events.`);
        } else if (parsedMessage.type === 'start_interview') {
          // Creating a new session or mapping existing
          InterviewSession.create({
            candidateName: parsedMessage.payload.name || 'Candidate',
            jobRole: parsedMessage.payload.role || 'Unspecified',
            status: 'in-progress',
            startTime: new Date(),
            deviceInfo: parsedMessage.payload.deviceInfo
          }).then(doc => {
            ws.sessionId = doc._id;
            console.log(`[Worker ${process.pid}] Session started: ${ws.sessionId}`);
            // Let the AI engine orchestrate the questions
            interviewEngine.startSession(doc._id, ws);
          }).catch(e => console.error(e));
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
