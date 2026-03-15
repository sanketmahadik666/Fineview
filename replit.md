# Fineview

An AI-powered interview platform that connects candidates with an automated interviewer via WebSocket, records transcripts, monitors proctoring signals, and provides recruiter dashboards with evaluation scores and behaviour integrity analysis.

## Architecture

- **Frontend**: React + Vite, served on port 5000
- **Backend**: Node.js + Express + WebSocket (`ws`), 4-worker cluster on port 3002
- **Database**: MongoDB (local, data stored in `/home/runner/workspace/data/db`)
- **LLM**: OpenAI-compatible API (configurable via env vars)
- **Proxy**: Vite dev server proxies `/api` → `http://localhost:3002` and `/ws` → `ws://localhost:3002`

## Implementation Status

### Phase 1 ✅ Complete
- `DeviceCapability` — browser/hardware capability probe
- `VoiceActivityDetection` — AudioWorklet-based VAD (off main thread)
- `SpeechCapture` — Web Speech API STT wrapper
- `SocketService` — native WebSocket client with heartbeat, reconnect, batch buffer
- `vadWorklet.js` — VAD AudioWorkletProcessor (RMS + EMA smoothing)

### Phase 2 ✅ Complete
- `MeydaModule` — spectral audio feature extraction (ZCR, RMS, centroid, flatness, 13-band mel energies) via AudioWorklet; shares AudioContext with VAD
- `meydaWorklet.js` — AudioWorkletProcessor with manual DFT + Hann window + triangular mel filterbank
- `NlpModule` — compromise.js NLP: filler detection, keyword extraction, vocabulary richness, communication score (0–100)
- `WebcamMonitor` + `webcamWorker.js` — MediaPipe FaceLandmarker in OffscreenCanvas worker; gaze detection

### Phase 3 ✅ Complete
- MongoDB session store (InterviewSession, Transcript, MonitoringEvent models)
- Backend WebSocket server with session lifecycle management
- `EvalQueue` — in-process async FIFO queue (concurrency 2, 3 retries + exponential backoff, metrics); decouples evaluation from WS handler

### Phase 4 ✅ Complete
- `LLMService` — OpenAI-compatible API wrapper for question generation + JSON evaluation
- `InterviewEngine` — AI question turn-taking + EvalQueue-backed final evaluation
- `BehaviourScorer` — deterministic integrity scorer (0–100, High/Medium/Low) from MonitoringEvent stream
- Dashboard REST API: sessions list, session detail + behaviour score, on-demand behaviour, analytics aggregate

### Phase 5 ✅ Complete
- `rateLimiter.js` — HTTP rate limits (express-rate-limit) + per-connection WebSocket token bucket
- Adaptive degradation wired through all services (VAD threshold, FFT size, webcam frame rate)
- Integration test suite: 44 tests across BehaviourScorer, EvalQueue, HTTP endpoints, WebSocket flow, DB verification, Dashboard API

## Startup

All services are started via `start.sh`:
1. MongoDB starts (binds to `127.0.0.1:27017`)
2. Backend cluster starts on port 3002 (4 workers)
3. Vite dev server starts on port 5000 (main workflow entry)

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `MONGO_URI` | MongoDB connection string | `mongodb://localhost:27017/fineview` |
| `PORT` | Backend server port | `3002` |
| `LLM_API_KEY` | LLM provider API key | (required for AI features) |
| `LLM_API_URL` | LLM provider endpoint (OpenAI-compatible) | (required for AI features) |
| `LLM_MODEL` | Model name to use | `gpt-4.1-mini` |
| `CORS_ORIGIN` | Allowed CORS origin | `*` |
| `DASHBOARD_API_KEY` | Recruiter dashboard API key | (open in dev if unset) |

## Key Files

### Client
- `client/src/hooks/useInterview.js` — orchestrates all client services (VAD, Meyda, NLP, Speech, Webcam, Socket)
- `client/src/services/MeydaModule.js` — AudioWorklet feature extractor wrapper
- `client/src/services/NlpModule.js` — compromise.js NLP preprocessing
- `client/src/services/VoiceActivityDetection.js` — AudioWorklet VAD
- `client/src/services/SpeechCapture.js` — Web Speech API STT
- `client/src/services/WebcamMonitor.js` — MediaPipe face detection (Worker)
- `client/src/services/SocketService.js` — WebSocket client
- `client/src/services/BrowserActivityTracker.js` — tab switch / focus monitoring
- `client/src/services/DeviceCapability.js` — browser capability probe
- `client/public/vadWorklet.js` — VAD AudioWorkletProcessor
- `client/public/meydaWorklet.js` — Meyda AudioWorkletProcessor (manual DFT)

### Server
- `server/app.js` — Express + WebSocket server + rate limiters
- `server/server.js` — Cluster entry point
- `server/config/db.js` — MongoDB connection
- `server/models/` — Mongoose models (InterviewSession, Transcript, MonitoringEvent)
- `server/services/InterviewEngine.js` — AI interview orchestration + EvalQueue
- `server/services/LLMService.js` — OpenAI-compatible LLM wrapper
- `server/services/EvalQueue.js` — Async evaluation queue with retry/backoff
- `server/services/BehaviourScorer.js` — Deterministic integrity scorer
- `server/routes/dashboard.js` — Recruiter REST API
- `server/middleware/rateLimiter.js` — HTTP + WebSocket rate limiting
- `server/tests/integration.js` — 44-test integration suite

## WebSocket Message Types

| Client → Server | Purpose |
|---|---|
| `start_interview` | Begin session (name, role, deviceInfo) |
| `transcript` | STT chunk (text, isFinal) |
| `monitoring_event` | Single proctoring event |
| `monitoring_batch` | Batched proctoring events |
| `end_interview` | End session (reason) |
| `ping` | Heartbeat |

| Server → Client | Purpose |
|---|---|
| `pong` | Heartbeat reply / welcome |
| `ai_question` | Next interview question |
| `interview_completed` | Final scores payload |
| `error` | Rate limit or protocol error |

## Dashboard REST API

| Endpoint | Description |
|---|---|
| `GET /api/dashboard/sessions` | List all sessions |
| `GET /api/dashboard/sessions/:id` | Detail + behaviour score + transcript |
| `GET /api/dashboard/sessions/:id/behaviour` | On-demand behaviour score |
| `GET /api/dashboard/analytics` | Aggregate stats, role breakdown, queue metrics |
| `GET /health` | Worker health + EvalQueue metrics |

## Deployment

Uses VM deployment target (always-on) due to WebSocket connections and local MongoDB.
