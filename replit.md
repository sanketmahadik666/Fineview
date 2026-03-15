# Fineview

An AI-powered interview platform that connects candidates with an automated interviewer via WebSocket, records transcripts, and provides recruiter dashboards with evaluation scores.

## Architecture

- **Frontend**: React + Vite, served on port 5000
- **Backend**: Node.js + Express + WebSocket (`ws`), running on port 3001
- **Database**: MongoDB (local, data stored in `/home/runner/workspace/data/db`)
- **LLM**: OpenAI-compatible API (configurable via env vars)

## Startup

All services are started via `start.sh`:
1. MongoDB starts first (binds to `127.0.0.1:27017`)
2. Backend (`server/server.js`) starts in background on port 3001
3. Vite dev server starts on port 5000 (main workflow)

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `MONGO_URI` | MongoDB connection string | `mongodb://localhost:27017/fineview` |
| `PORT` | Backend server port | `3001` |
| `LLM_API_KEY` | LLM provider API key | (required for AI features) |
| `LLM_API_URL` | LLM provider endpoint (OpenAI-compatible) | (required for AI features) |
| `LLM_MODEL` | Model name to use | `gpt-4.1-mini` |
| `CORS_ORIGIN` | Allowed CORS origin | `*` |

## Key Files

- `start.sh` — startup script (MongoDB + backend + frontend)
- `client/` — React frontend (Vite)
- `server/app.js` — Express + WebSocket server logic
- `server/server.js` — Cluster entry point
- `server/config/db.js` — MongoDB connection
- `server/models/` — Mongoose models (InterviewSession, Transcript, MonitoringEvent)
- `server/services/InterviewEngine.js` — Interview orchestration
- `server/services/LLMService.js` — LLM API wrapper
- `server/routes/dashboard.js` — Recruiter dashboard REST API

## WebSocket Message Types

- `start_interview` — Begin session (name, role)
- `transcript` — Send speech-to-text chunk
- `monitoring_event` — Send single monitoring event
- `monitoring_batch` — Send batch of monitoring events
- `end_interview` — End session
- `ping` / `pong` — Heartbeat

## Deployment

Uses VM deployment target (always-on) due to WebSocket connections and local MongoDB.
