**FINEVIEW**

Low-Level Design Document

JS-Environment Architecture | Module Strategy | Trade-off Register | Scaling Blueprint

This LLD is built from direct scraping of every library's official documentation --- ricky0123/vad, MediaPipe @tasks-vision, Meyda.js, compromise, Socket.IO v4 --- cross-referenced against the Fineview PRD scope. It defines the exact internal architecture, threading model, module contracts, and scaling decisions that make the system production-ready.

**1. JavaScript Thread Architecture**

The browser's single main thread is the most critical constraint in Fineview. Four concurrent heavyweight operations --- Silero ONNX inference, MediaPipe WebGL inference, Meyda FFT transforms, and React UI rendering --- cannot all share the main thread without frame drops and VAD misfire storms. This section defines the thread topology.

**1.1 Thread Map**

  ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  **Thread**                 **Runtime**                         **Owns**                                                                                                 **Communicates Via**
  -------------------------- ----------------------------------- -------------------------------------------------------------------------------------------------------- ----------------------------------------------
  Main Thread                Window                              React UI, Socket.IO client, event aggregation, compromise.js NLP                                         postMessage to workers / AudioWorklet

  AudioWorklet Thread        AudioWorkletGlobalScope             Meyda FFT, RMS, ZCR (per-frame), raw PCM buffer relay to VAD worklet                                     AudioWorkletNode port.postMessage

  VAD ONNX Worker            AudioWorkletGlobalScope (bundled)   Silero V5 ONNX model, speech probability per 96ms frame, onSpeechEnd Float32Array                        Callbacks via AudioWorkletNode → main thread

  Vision Worker (optional)   Web Worker                          MediaPipe FaceLandmarker --- 478 landmarks, 52 blendshapes, 4x4 matrix --- on 640x480 offscreen canvas   postMessage structured clone

  Web Speech API             Browser Internal                    STT inference (Chrome server-side) --- transcript + confidence + isFinal                                 SpeechRecognition events → main thread
  ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

> ⓘ AudioWorklet is the ONLY correct place to run Meyda in 2024. ScriptProcessorNode (the old approach) is deprecated and creates glitches. The vad-web package uses its own AudioWorklet thread for Silero --- do not share AudioContext between Meyda and VAD.

**1.2 Two AudioContext Problem & Fix**

Meyda and @ricky0123/vad-web both need an AudioContext. Naive implementations create two, causing device-level sample-rate conflicts and excessive CPU. The fix is to pass a shared AudioContext into Meyda and let VAD's MicVAD.new() use a custom getStream that draws from the same MediaStream.

```
// SINGLE shared AudioContext + MediaStream strategy
const audioCtx = new AudioContext({ sampleRate: 16000 }); // match VAD's 16kHz
const stream = await navigator.mediaDevices.getUserMedia({
audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
});

// 1. Fork: Meyda reads from same stream via a source node
const meydaSource = audioCtx.createMediaStreamSource(stream);

// 2. VAD uses MicVAD.new with custom getStream returning SAME stream
const vad = await MicVAD.new({
getStream: () => Promise.resolve(stream), // reuse --- no second getUserMedia
pauseStream: () => Promise.resolve(), // no-op, main code manages stream
resumeStream: () => Promise.resolve(stream),
model: 'v5', // Silero V5 --- more accurate than legacy
baseAssetPath: '/assets/vad/', // self-hosted --- no CDN dependency
onnxWASMBasePath: '/assets/ort/',
processorType: 'AudioWorklet', // NEVER ScriptProcessor in production
// Algorithm tuning for interview domain:
positiveSpeechThreshold: 0.4, // default 0.3 --- slightly stricter for interview noise
negativeSpeechThreshold: 0.3, // default 0.25
redemptionMs: 1200, // default 1400 --- faster sentence-end detection
preSpeechPadMs: 600, // default 800 --- smaller pad to reduce segment size
minSpeechMs: 500, // default 400 --- filter ultra-short fillers
submitUserSpeechOnPause: true, // flush pending speech if interview is paused
onSpeechStart: handleSpeechStart,
onSpeechEnd: handleSpeechEnd, // receives Float32Array at 16kHz
onVADMisfire: handleMisfire,
onFrameProcessed: handleFrame, // {isSpeech: float, notSpeech: float} per 96ms
});
```
>
> ⚠ Do NOT set sampleRate: 16000 on AudioContext when Meyda is also connected. Meyda expects 44100Hz for its FFT math (spectralCentroid Hz values are computed from sampleRate). Run AudioContext at 44100Hz and use an OfflineAudioContext resampler to produce the 16kHz Float32Array that VAD's onSpeechEnd expects.

**1.3 Meyda on AudioWorklet --- Correct Setup**

Meyda's callback fires ~86 times/second at bufferSize 512. This MUST run in the AudioWorklet thread, not the main thread, to avoid blocking React rendering. Use Meyda's low-level extract() API inside a custom processor.

```
// custom-audio-processor.js (AudioWorkletGlobalScope)
import Meyda from 'meyda';

class FineviewProcessor extends AudioWorkletProcessor {
constructor() {
super();
this._buf = new Float32Array(512);
this._pos = 0;
this._sampleRate = 44100;
}
process(inputs) {
const input = inputs[0]?.[0];
if (!input) return true;
for (const s of input) {
this._buf[this._pos++] = s;
if (this._pos === 512) {
const features = Meyda.extract(
['rms','energy','zcr','spectralCentroid','spectralFlatness','spectralSpread','mfcc'],
this._buf
);
this.port.postMessage(features); // structured clone to main thread
this._pos = 0;
}
}
return true; // keep alive
}
}
registerProcessor('fineview-processor', FineviewProcessor);
```
>
> ⓘ Meyda's numberOfMFCCCoefficients defaults to 13. Keep it at 13 for Fineview --- this is the standard for speech ML pipelines. Using 20 would be more detailed but the evaluator LLM receives a JSON summary, not raw MFCCs anyway.

**2. Client Module Architecture**

The client is decomposed into 6 independent modules. Each module owns exactly one library, has a single output interface (emitFn or callback), and can be disabled without affecting others. This is the boundary that enables adaptive degradation.

**2.1 Module Boundary Diagram (textual)**

```
┌──────────────────────────────────────────────────────────────┐
│ DeviceCapabilityProbe (runs once on session start) │
│ → outputs: tier: LOW | MID | HIGH │
│ → controls which modules below are activated │
└─────────────────────┬────────────────────────────────────────┘
│ tier config
┌────────────┼──────────────┬────────────────┐
▼ ▼ ▼ ▼
┌──────────┐ ┌──────────┐ ┌──────────────┐ ┌──────────────┐
│ VadModule│ │SttModule │ │ MeydaModule │ │ VisionModule │
│(Silero v5│ │(WebSpeech│ │(AudioWorklet)│ │(MediaPipe) │
│AudioWork.│ │ API) │ │ │ │ │
└─────┬────┘ └─────┬────┘ └──────┬───────┘ └──────┬───────┘
│ speech │ transcript │ features │ landmarks
└────────────►├──────────────►├────────────────►│
▼ ▼ ▼
┌───────────────────────────────────────────┐
│ EventAggregator │
│ (buffers, timestamps, merges streams) │
└───────────────────┬───────────────────────┘
│
┌───────────▼──────────┐
│ NlpModule │
│ (compromise.js on │
│ final transcript) │
└───────────┬───────────┘
│ enriched payload
┌───────────▼──────────┐
│ SocketEmitter │
│ (Socket.IO client) │
└──────────────────────┘
```

**2.2 DeviceCapabilityProbe**

Runs once before any module is initialized. Scores the device and returns a tier that gates module activation. This is the implementation of the Adaptive Degradation strategy from the PRD.

```
// device-probe.js
export async function probeDevice() {
const cores = navigator.hardwareConcurrency || 2;
const memGB = navigator.deviceMemory || 1; // only Chrome/Edge
const conn = navigator.connection?.effectiveType || '4g';

// WebGL check --- needed for MediaPipe GPU delegate
const canvas = document.createElement('canvas');
const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
const hasGPU = !!gl;

// ONNX WASM check --- needed for Silero VAD
const hasSharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined';

let tier = 'HIGH';
if (cores <= 2 || memGB < 2 || !hasGPU) tier = 'LOW';
else if (cores <= 3 || memGB < 4) tier = 'MID';

return {
tier,
cores, memGB, conn, hasGPU, hasSharedArrayBuffer,
modules: {
vad: tier !== 'LOW', // Silero needs WASM + 2+ cores
meyda: tier === 'HIGH', // AudioWorklet FFT --- HIGH only
vision: tier !== 'LOW' && hasGPU, // MediaPipe GPU delegate
sttCont: tier !== 'LOW', // continuous STT needs stable event loop
}
};
}
```

**2.3 VadModule**

> **Library: @ricky0123/vad-web v0.0.29+ | Model: Silero V5 ONNX | Thread: AudioWorklet**

**Trade-offs from official docs**

  --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  **Decision**              **Option A (chosen)**                           **Option B (not chosen)**        **Reason**
  ------------------------- ----------------------------------------------- -------------------------------- ---------------------------------------------------------------------------------------
  Model version             Silero V5 (model:'v5')                        Legacy model (default)           V5 is more accurate per official changelog; legacy kept as fallback only

  Asset hosting             Self-hosted /assets/vad/                        CDN (default cdn.jsdelivr.net)   Interview environment may have corporate firewall blocking CDN; self-host is reliable

  Processor type            AudioWorklet (processorType:'AudioWorklet')   ScriptProcessorNode              ScriptProcessor is deprecated in Web Audio API spec; causes audio glitches

  submitUserSpeechOnPause   true                                            false (default)                  When recruiter pauses interview, incomplete speech should still be transcribed

  redemptionMs              1200ms (tuned)                                  1400ms (default)                 Interview domain: candidates pause between clauses; 1400ms creates over-long segments

  minSpeechMs               500ms (tuned)                                   400ms (default)                  Filter breath intakes and clicks classified as speech on noisy microphones
  --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

**State Machine**

```
// VadModule states
// IDLE → LISTENING (start()) → SPEAKING (onSpeechStart)
// ↓ ↓
// PAUSED ←────────────────── SILENT (onSpeechEnd or onVADMisfire)

class VadModule extends EventEmitter {
#vad = null;
#state = 'IDLE';
#segmentTimer = null;

async init(stream, config) {
this.#vad = await MicVAD.new({
getStream: () => Promise.resolve(stream),
pauseStream: () => Promise.resolve(),
resumeStream: () => Promise.resolve(stream),
model: config.useV5 ? 'v5' : 'legacy',
baseAssetPath: config.assetPath,
onnxWASMBasePath: config.wasmPath,
processorType: 'AudioWorklet',
positiveSpeechThreshold: 0.4,
negativeSpeechThreshold: 0.3,
redemptionMs: 1200,
preSpeechPadMs: 600,
minSpeechMs: 500,
submitUserSpeechOnPause: true,
onSpeechStart: () => this.#onStart(),
onSpeechEnd: (a) => this.#onEnd(a),
onVADMisfire: () => this.#onMisfire(),
onFrameProcessed: (p) => this.emit('frame', p), // {isSpeech, notSpeech}
});
}
#onStart() { this.#state='SPEAKING'; this.emit('speechStart'); }
#onEnd(audio) { this.#state='SILENT'; this.emit('speechEnd', audio); }
#onMisfire() { this.#state='SILENT'; this.emit('misfire'); }
start() { this.#vad?.start(); this.#state = 'LISTENING'; }
pause() { this.#vad?.pause(); this.#state = 'PAUSED'; }
destroy(){ this.#vad?.destroy(); this.#state = 'IDLE'; }
}
```

**2.4 MeydaModule**

> **Library: meyda v5 | Thread: AudioWorklet (custom processor) | Buffer: 512 samples @ 44100Hz (~11.6ms/frame)**

**Feature selection rationale**

  -----------------------------------------------------------------------------------------------------------
  **Feature**         **Cost (relative)**    **Interview Signal**                        **Include?**
  ------------------- ---------------------- ------------------------------------------- --------------------
  rms                 Minimal                Vocal volume, fades on silence              YES --- always

  energy              Minimal                Raw power, complements rms                  YES --- always

  zcr                 Minimal                Consonant density / noisiness               YES --- always

  spectralCentroid    Low                    Voice brightness / articulation clarity     YES --- HIGH+MID

  spectralFlatness    Low                    0=tonal speech, 1=noise/nervousness proxy   YES --- HIGH+MID

  spectralSpread      Low                    Articulation bandwidth                      YES --- HIGH only

  mfcc (13 coeffs)    Medium                 Voice timbre fingerprint for ML             YES --- HIGH only

  loudness.specific   High (24 bark bands)   Not needed for interview                    NO --- skip

  chroma              High (12 bins)         Musical, no interview relevance             NO --- skip

  perceptualSpread    Medium                 Redundant with spectralSpread here          NO --- skip
  -----------------------------------------------------------------------------------------------------------

**Aggregation Strategy (critical for bandwidth)**

Meyda fires callbacks at ~86Hz. Sending each frame to the backend would be ~430KB/s. The correct strategy is a rolling window reducer in the AudioWorklet that computes a 5-second statistical summary before emitting to the main thread once.

```
// Inside AudioWorklet process() --- rolling 5s window
const WINDOW_FRAMES = Math.ceil((44100 / 512) * 5); // ~430 frames

class MeydaAggregator {
#frames = [];
push(f) {
this._frames.push(f);
if (this.#frames.length >= WINDOW_FRAMES) {
this.port.postMessage(this.#summarize());
this.#frames = [];
}
}
#summarize() {
const get = (key) => this.#frames.map(f => f[key]).filter(v => v != null);
const avg = (arr) => arr.reduce((a,b)=>a+b,0) / arr.length;
const rmsArr = get('rms');
return {
rms_avg: avg(rmsArr), rms_min: Math.min(...rmsArr), rms_max: Math.max(...rmsArr),
energy_avg: avg(get('energy')),
zcr_avg: avg(get('zcr')),
spectralFlatness_avg: avg(get('spectralFlatness')),
spectralCentroid_avg: avg(get('spectralCentroid')),
mfcc_mean: Array.from({length:13}, (_,i) =>
avg(this.#frames.map(f => f.mfcc?.[i] || 0))
),
silenceRatio: rmsArr.filter(v => v < 0.02).length / rmsArr.length,
frameCount: this.#frames.length
};
}
}
```

**2.5 VisionModule**

> **Library: @mediapipe/tasks-vision 0.10.3+ | Model: BlazeFace short-range + face mesh + blendshapes | Thread: Main (GPU) or OffscreenCanvas Worker**

**runningMode: VIDEO vs LIVE_STREAM --- critical distinction**

The official docs distinguish two modes. VIDEO mode (detectForVideo) blocks synchronously until inference completes, requiring the caller to ensure it's called from requestAnimationFrame at the right timestamp. LIVE_STREAM mode uses a callback pattern and is better for React. For Fineview's monitoring use case, VIDEO in an OffscreenCanvas Worker is the correct choice --- it gives deterministic timing without polluting the main thread.

```
// vision-worker.js --- runs in Web Worker with OffscreenCanvas
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

let landmarker = null;
let lastTs = -1;
const SAMPLE_INTERVAL = 200; // process at 5fps max --- sufficient for monitoring

self.onmessage = async (e) => {
if (e.data.type === 'INIT') {
const vision = await FilesetResolver.forVisionTasks('/assets/mediapipe/wasm');
landmarker = await FaceLandmarker.createFromOptions(vision, {
baseOptions: {
modelAssetPath: '/assets/mediapipe/face_landmarker.task',
delegate: 'GPU', // falls back to CPU if WebGL unavailable
},
runningMode: 'VIDEO',
numFaces: 3, // detect up to 3 (multiple face alert)
outputFaceBlendshapes: true, // 52 blendshapes per face
outputFacialTransformationMatrixes: true, // yaw/pitch/roll extraction
});
self.postMessage({ type: 'READY' });
}

if (e.data.type === 'FRAME') {
const now = e.data.timestamp;
if (now - lastTs < SAMPLE_INTERVAL) return; // throttle to 5fps
lastTs = now;
const result = landmarker.detectForVideo(e.data.bitmap, now);
const summary = extractSummary(result);
self.postMessage({ type: 'RESULT', summary });
}
};

function extractSummary(result) {
const faces = result.faceLandmarks?.length || 0;
const mat = result.facialTransformationMatrixes?.[0]?.data;
const bs = result.faceBlendshapes?.[0]?.[0];

let yaw = 0, pitch = 0, roll = 0;
if (mat) {
pitch = Math.asin(-mat[9]) * (180 / Math.PI);
yaw = Math.atan2(mat[8], mat[10]) * (180 / Math.PI);
roll = Math.atan2(mat[1], mat[5]) * (180 / Math.PI);
}

const findBS = (name) => bs?.categories.find(c => c.categoryName === name)?.score || 0;

return {
facesDetected: faces,
lookingAway: Math.abs(yaw) > 30 || Math.abs(pitch) > 20,
gazeDirection: { yaw, pitch, roll },
blendshapes: {
eyeLookOutLeft: findBS('eyeLookOutLeft'),
eyeLookOutRight: findBS('eyeLookOutRight'),
eyeLookUp: findBS('eyeLookUp'),
eyeBlinkLeft: findBS('eyeBlinkLeft'),
eyeBlinkRight: findBS('eyeBlinkRight'),
browDownLeft: findBS('browDownLeft'),
browDownRight: findBS('browDownRight'),
},
events: [
faces === 0 && 'NO_FACE',
faces > 1 && 'MULTIPLE_FACES',
Math.abs(yaw) > 30 && 'LOOKING_AWAY_H',
Math.abs(pitch) > 20 && 'LOOKING_AWAY_V',
].filter(Boolean)
};
}
```
>
> ⚠ Known MediaPipe issue (github #5152): detectForVideo throws INVALID_VALUE: texImage2D when called before the video element has loaded metadata. Always await videoEl.readyState >= 2 before the first call. The GPU delegate also requires WebGL2 on Firefox; fall back to delegate:'CPU' if WebGL2 unavailable.

**2.6 NlpModule**

> **Library: compromise v14 | Size: 180KB minified | Throughput: ~1MB text/second | Thread: Main (synchronous, very fast)**

**Why compromise over other NLP options**

  ----------------------------------------------------------------------------------------------------------------------------------------
  **Library**      **Size**               **Browser?**   **Speed**        **Accuracy**             **Verdict for Fineview**
  ---------------- ---------------------- -------------- ---------------- ------------------------ ---------------------------------------
  compromise       180KB                  YES            ~1MB/s          Good for basic tagging   CHOSEN --- fast, tiny, browser-native

  wink-nlp         ~350KB                YES            Fast             Better POS accuracy      Overkill for our use case

  natural.js       >1MB (Node focused)   Partial        Slower           Good tokenizer           Too large for client bundle

  spaCy (Python)   N/A                    NO             Fast server      Best accuracy            Server-side fallback only

  Browser LLM      >1GB                  Possible       Slow first run   Excellent                Way too heavy for per-transcript call
  ----------------------------------------------------------------------------------------------------------------------------------------

**Domain Extension --- Technical Term Lexicon**

compromise's default lexicon is general English. For interview domain, extend it with a custom tech lexicon so terms like 'microservices', 'kubernetes', 'REST', 'OAuth' are tagged as TechnicalTerm rather than misclassified as Noun/Adjective.

```
import nlp from 'compromise';

const TECH_LEXICON = {
// CS fundamentals
'api': 'TechnicalTerm', 'rest': 'TechnicalTerm', 'graphql': 'TechnicalTerm',
'microservice': 'TechnicalTerm', 'kubernetes': 'TechnicalTerm', 'docker': 'TechnicalTerm',
'ci/cd': 'TechnicalTerm', 'oauth': 'TechnicalTerm', 'jwt': 'TechnicalTerm',
'sql': 'TechnicalTerm', 'nosql': 'TechnicalTerm', 'redis': 'TechnicalTerm',
'websocket': 'TechnicalTerm', 'async': 'TechnicalTerm', 'callback': 'TechnicalTerm',
'recursion': 'TechnicalTerm', 'binary tree': 'TechnicalTerm',
};

nlp.extend({
tags: { TechnicalTerm: { isA: 'Noun' } },
words: TECH_LEXICON,
});

export function analyzeTranscript(text) {
const doc = nlp(text);
const wordCount = doc.wordCount();

// Filler detection (custom rule, faster than regex loop)
const fillerDoc = doc.match('(um|uh|like|basically|actually|sort of|you know)');
const fillerCount = fillerDoc.length;

return {
wordCount,
sentenceCount: doc.sentences().length,
technicalTerms: doc.match('#TechnicalTerm+').out('array'),
acronyms: doc.acronyms().out('array'),
fillerWordCount: fillerCount,
fillerRatio: wordCount > 0 ? fillerCount / wordCount : 0,
avgWordsPerSentence: wordCount / Math.max(1, doc.sentences().length),
verbDiversity: (() => {
const verbs = doc.verbs().out('array');
return verbs.length > 0 ? new Set(verbs).size / verbs.length : 0;
})(),
// compromise v14: doc.compute('penn') for full POS tags if needed
rawText: doc.contractions().expand().text(), // normalize: 'I've' → 'I have'
};
}
```

**3. Socket.IO Transport Layer Design**

This section defines the Socket.IO configuration, namespace structure, room strategy, and the exact scaling path from 20 to 100+ concurrent sessions --- drawn directly from Socket.IO v4 official docs and the Redis adapter specification.

**3.1 Client Configuration**

```
// socket-client.js
import { io } from 'socket.io-client';

export function createInterviewSocket(sessionId, token) {
return io('/interview', { // namespace --- NOT '/'
transports: ['websocket'], // SKIP long-polling: no sticky session needed
auth: { token }, // JWT verified in server middleware
reconnection: true,
reconnectionAttempts: 5,
reconnectionDelay: 1000,
reconnectionDelayMax: 5000,
timeout: 10000,
query: { sessionId }, // available on server as socket.handshake.query
});
}

// WHY transports: ['websocket'] only?
// Socket.IO v4 docs: if you disable HTTP long-polling, sticky sessions are NOT required.
// This massively simplifies horizontal scaling --- any server can handle any client.
// Trade-off: if WebSocket is blocked (some corporate proxies), connection fails.
// Mitigation: DeviceCapabilityProbe checks connectivity type; fall back to polling
// only for connection type '2g' or 'slow-2g'.
```

**3.2 Server Namespace Structure**

```
// server/socket/index.js
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const { createClient } = require('redis');

async function setupSocketServer(httpServer) {
const io = new Server(httpServer, {
cors: { origin: process.env.CLIENT_URL, credentials: true },
connectionStateRecovery: { // Socket.IO v4.6+ feature
maxDisconnectionDuration: 120_000, // 2min --- interview may have bad network
skipMiddlewares: false,
},
pingInterval: 25_000, // keep-alive every 25s
pingTimeout: 20_000, // disconnect if no pong within 20s
});

// Redis adapter for horizontal scaling
const pubClient = createClient({ url: process.env.REDIS_URL });
const subClient = pubClient.duplicate();
await Promise.all([pubClient.connect(), subClient.connect()]);
io.adapter(createAdapter(pubClient, subClient));

// Namespaces
const interview = io.of('/interview');
const recruiter = io.of('/recruiter');

interview.use(verifyInterviewToken); // JWT middleware
recruiter.use(verifyRecruiterToken);

interview.on('connection', handleCandidateSocket);
recruiter.on('connection', handleRecruiterSocket);

return io;
}
```

**3.3 Room Strategy**

Each interview session becomes a Socket.IO room. The session room enables three things: broadcast monitoring alerts to the recruiter in real-time, broadcast evaluation results back to the candidate, and scope all events so no candidate can see another's data.

```
// handleCandidateSocket.js
async function handleCandidateSocket(socket) {
const { sessionId, candidateId } = socket.handshake.auth;

// Validate session belongs to this candidate via DB lookup
const session = await SessionStore.findOne({ sessionId, candidateId });
if (!session) return socket.disconnect(true);

// Join the session room
socket.join(`session:${sessionId}`);

// Register handlers
socket.on('session:start', (d) => onSessionStart(socket, session, d));
socket.on('transcript:final', (d) => onTranscriptFinal(socket, session, d));
socket.on('vad:event', (d) => onVadEvent(socket, session, d));
socket.on('audio:features', (d) => onAudioFeatures(socket, session, d));
socket.on('monitoring:face', (d) => onFaceEvent(socket, session, d));
socket.on('monitoring:tabswitch', (d) => onTabSwitch(socket, session, d));
socket.on('monitoring:inactivity', (d) => onInactivity(socket, session, d));
socket.on('disconnect', () => onDisconnect(socket, session));
}

// Emit evaluation result to BOTH candidate and recruiter
// With Redis adapter, io.to() works across ALL server instances
function broadcastEvaluation(io, sessionId, result) {
io.of('/interview').to(`session:${sessionId}`).emit('evaluation:result', result);
io.of('/recruiter').to(`session:${sessionId}`).emit('evaluation:result', result);
}
```

**3.4 Horizontal Scaling Blueprint**

  ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  **Stage**    **Concurrent Sessions**   **Architecture**                                                     **Redis**                                              **Sticky Sessions?**
  ------------ ------------------------- -------------------------------------------------------------------- ------------------------------------------------------ ---------------------------------------------------------------------
  Dev / MVP    1--20                     Single Node.js process, 1 server                                     Not required                                           N/A

  Growth       20--100                   Node cluster (cluster module), 1 machine, N workers = N CPU cores    @socket.io/cluster-adapter (IPC, no Redis needed)     Required via @socket.io/sticky (least-connection LB)

  Scale        100--500                  2--4 Docker containers behind Nginx, WebSocket-only transport        @socket.io/redis-adapter + Redis 7 Pub/Sub            NOT required --- WebSocket-only bypasses sticky session requirement

  Production   500+                      Kubernetes pods, auto-scaling HPA, Redis Cluster (sharded Pub/Sub)   @socket.io/redis-adapter sharded adapter (Redis 7+)   NOT required --- same WebSocket-only strategy
  ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

> ⓘ Socket.IO official docs (v4): 'If you disable the HTTP long-polling transport, you won't need sticky sessions.' This is the key architectural insight. Always set transports: ['websocket'] on the client. Combined with the Redis adapter for cross-server room broadcasts, this gives full stateless horizontal scaling.

**3.5 Back-pressure & Rate Limiting**

The client emits up to ~11 Kbps of structured data. However, a candidate could exploit the protocol by flooding the server with fake events. The server must apply per-socket rate limits.

```
// socket rate-limit middleware
const RATE_LIMITS = {
'transcript:final': { max: 30, windowMs: 60_000 }, // 30/min
'audio:features': { max: 15, windowMs: 60_000 }, // 15/min (every 4s)
'monitoring:face': { max: 35, windowMs: 60_000 }, // ~30/min (every 2s)
'monitoring:tabswitch': { max: 20, windowMs: 60_000 }, // 20 tab switches/min max
'vad:event': { max: 120, windowMs: 60_000 }, // 2/sec speech events
};

function createRateLimiter(socket) {
const counts = {};
return (eventName, next) => {
const rule = RATE_LIMITS[eventName];
if (!rule) return next();
const key = `${socket.id}:${eventName}`;
counts[key] = (counts[key] || 0) + 1;
setTimeout(() => { counts[key] = Math.max(0, (counts[key]||0)-1); }, rule.windowMs);
if (counts[key] > rule.max) {
console.warn(`Rate limit hit: ${socket.id} on ${eventName}`);
return; // drop silently --- don't disconnect
}
next();
};
}
```

**4. Backend Evaluation Engine Design**

The backend is a stateless Node.js service with two asynchronous evaluation pipelines triggered by incoming Socket.IO events. Stateless means any server instance can evaluate any session --- MongoDB holds all session state, not in-memory objects.

**4.1 Session State Machine (server-side)**

```
// MongoDB document: sessions collection
{
_id: ObjectId,
sessionId: UUID,
candidateId: UUID,
status: 'WAITING' | 'ACTIVE' | 'PAUSED' | 'EVALUATING' | 'COMPLETE' | 'ABANDONED',
deviceTier: 'LOW' | 'MID' | 'HIGH',
currentQuestionIndex: number,
questions: [{ text, askedAt, answeredAt }],
transcriptBuffer: [], // accumulated segments per question
behaviourEvents: [], // monitoring events
evaluations: [], // per-question AI results
metadata: { startedAt, endedAt, totalDurationMs }
}

// State transitions (server socket handlers)
// session:start → ACTIVE → start question loop
// transcript:final → ACTIVE → enqueue evaluation job
// question:ready (sent by server) → candidate receives next Q
// disconnect → if status=ACTIVE → PAUSED (2min recovery window)
// reconnect → PAUSED→ACTIVE (Socket.IO connectionStateRecovery)
// session:end → COMPLETE → trigger final evaluation
```

**4.2 Evaluation Job Queue**

AI evaluation (LLM call) is async and can take 1-3 seconds. It must NOT block the socket event loop. The correct pattern is a lightweight in-process queue using Node.js EventEmitter or a Redis-backed queue for multi-server setups.

```
// evaluation-queue.js (single-server: in-memory; multi-server: BullMQ + Redis)
const Queue = require('bull'); // or BullMQ for Redis 7+

const evalQueue = new Queue('evaluation', { redis: process.env.REDIS_URL });

// Add job when transcript:final arrives
async function enqueueEvaluation(sessionId, questionIndex, transcript, nlp, acoustics) {
await evalQueue.add('evaluate', {
sessionId, questionIndex, transcript, nlp, acoustics
}, {
attempts: 3, // retry on LLM timeout
backoff: { type: 'exponential', delay: 2000 },
removeOnComplete: 10, // keep last 10 completed jobs for debugging
timeout: 15000, // LLM call budget: 15s hard timeout
});
}

// Worker (can run on separate process for isolation)
evalQueue.process('evaluate', async (job) => {
const result = await callLLM(job.data);
await SessionStore.appendEvaluation(job.data.sessionId, result);
io.of('/interview').to(`session:${job.data.sessionId}`)
.emit('evaluation:result', result);
return result;
});
```

**4.3 LLM Prompt --- Full Production Template**

```
function buildEvalPrompt(question, transcript, nlp, acoustics) {
return {
system: `You are a strict technical interviewer evaluating a software engineering candidate.
Return ONLY valid JSON. No prose, no markdown, no explanation outside the JSON object.`,

user: `
QUESTION [${question.index}]: ${question.text}

CANDIDATE ANSWER:
Text: "${transcript.text}"
Duration: ${transcript.durationMs}ms
STT Confidence: ${transcript.confidence.toFixed(2)}
Low Confidence Flag: ${transcript.lowConfidence}

NLP ANALYSIS:
Word count: ${nlp.wordCount}
Sentence count: ${nlp.sentenceCount}
Technical terms mentioned: ${nlp.technicalTerms.join(', ') || 'none'}
Filler word ratio: ${nlp.fillerRatio.toFixed(3)} (>0.12 is high)
Avg words per sentence: ${nlp.avgWordsPerSentence.toFixed(1)}
Verb diversity: ${nlp.verbDiversity.toFixed(2)} (1.0 = all unique verbs)

VOICE METRICS:
Avg RMS (volume): ${acoustics.rms_avg.toFixed(3)}
Speaking rate: ${acoustics.speakingRateWPM} WPM
Spectral flatness: ${acoustics.spectralFlatness_avg.toFixed(3)} (0=clear, 1=noisy)

Evaluate and return this exact JSON structure:
{
"conceptual": <0-10>,
"problemSolving": <0-10>,
"communication": <0-10>,
"completeness": <0-10>,
"feedback": "<2-3 sentence constructive feedback>",
"keyStrengths": ["<strength 1>", "<strength 2>"],
"improvements": ["<improvement 1>", "<improvement 2>"],
"technicalAccuracy": <0-10>,
"followUpQuestion": "<1 probing follow-up question if score < 7>"
}`,
};
}
```

**5. Global Trade-off Register**

Every significant architectural decision is logged here with the reasoning, alternatives considered, and the conditions under which the decision should be revisited.

  ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  **Decision**          **Chosen Approach**                        **Trade-off**                                                                                         **Revisit When**
  --------------------- ------------------------------------------ ----------------------------------------------------------------------------------------------------- -------------------------------------------------------------------------------------------------
  VAD threading         AudioWorklet (vad-web)                     Cannot use SharedArrayBuffer without COOP/COEP headers; requires server-side header config            If hosting on restrictive CDN with no header control → use ScriptProcessor fallback

  STT engine            Web Speech API (browser native)            Chrome sends audio to Google servers, no offline support, accuracy varies by accent                   If privacy requirements mandate on-premise → switch to OpenAI Whisper via server endpoint

  MediaPipe threading   OffscreenCanvas Worker                     +2s startup for model download; requires transferable ImageBitmap                                     If startup time > 3s on MID tier → lazy-init after session:start confirmation

  Socket transport      WebSocket only (no polling)                Fails on strict corporate proxies that block WebSocket; affects ~2% of corporate environments        If >5% session connection failures reported → re-enable polling fallback + add sticky sessions

  Redis for scaling     Redis Pub/Sub (@socket.io/redis-adapter)   Redis becomes SPOF; add Sentinel for HA. Pub/Sub has no persistence --- offline clients miss events   Use connectionStateRecovery for reconnects; add Redis Sentinel if uptime SLA > 99.9%

  LLM provider          Groq (low latency) / Gemini (quality)      Groq: fast but rate-limited; Gemini: slower but better reasoning on technical questions               Benchmark both on first 100 real interviews; pick based on p95 latency and score accuracy

  NLP enrichment        compromise.js client-side                  English only; limited accuracy on highly technical jargon; 180KB bundle addition                      If non-English interviews needed → run spaCy on backend; add language detection probe

  Meyda buffer size     512 samples (86Hz)                         Higher CPU on LOW devices; reduce to 2048 (21Hz) for MID tier                                         If battery drain reported on mobile MID devices → check DeviceCapabilityProbe CPU score
  ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

**6. Known Pitfalls from Official Documentation**

These are bugs and gotchas identified directly from official docs, GitHub issues, and changelogs --- not speculation.

**6.1 @ricky0123/vad-web**

-   frameSamples is no longer settable (v0.0.27+). It is hardcoded to Silero V5 recommended values. Do not attempt to override it.

-   In v0.0.27+, redemptionFrames/preSpeechPadFrames are REMOVED --- use redemptionMs / preSpeechPadMs instead. The old parameter names silently have no effect.

-   MicVAD.new() silently requests microphone even when startOnLoad: false was the old default. Since v0.0.29, mic is only requested on .start() --- always use the new package version.

-   pause() and start() now return Promise<void> in the React API (v0.0.35+). Do not call them synchronously in useEffect without await.

**6.2 MediaPipe FaceLandmarker**

-   detectForVideo() throws 'INVALID_VALUE: texImage2D: no video' if called before video metadata loads (issue #5152). Guard with: if (videoEl.readyState < 2) return;

-   LIVE_STREAM mode requires an onResults callback parameter --- it does NOT return results synchronously. VIDEO mode returns synchronously. Use VIDEO mode in the Worker.

-   GPU delegate: if the browser reports WebGL error 'context lost', the delegate silently falls back to CPU. Monitor via gl.isContextLost() for performance diagnostics.

-   facialTransformationMatrixes[0].data is a 16-element Float32Array in column-major order (OpenGL convention). Matrix indices [9], [8], [10] give pitch/yaw/roll correctly --- do not rearrange.

**6.3 Meyda.js**

-   Meyda.bufferSize is a global mutable field on the default export. If two Meyda analyzers run in the same scope, they share this buffer size. Use separate AudioWorklets to isolate.

-   mfcc requires powerSpectrum to be computed first. When using Meyda.extract() manually, always include 'powerSpectrum' in the features array if you need 'mfcc'. The MeydaAnalyzer handles this automatically.

-   Meyda applies a Hanning window before FFT by default. Spectral feature values from Meyda will NOT match values from other FFT libraries unless they also use Hanning windowing.

**6.4 Socket.IO v4**

-   If you use HTTP long-polling (the default), sticky sessions ARE required. If you force WebSocket-only, they are NOT required. There is no middle ground --- commit to one strategy.

-   connectionStateRecovery does NOT work with the Redis adapter if the server instance that held the session is gone. It only works within the same cluster/process group. Do not over-rely on it for critical session state --- persist state to MongoDB on every event.

-   io.to(room).emit() with the Redis adapter publishes to ALL server instances even if only one has a client in that room. This is correct behavior but adds minor overhead --- acceptable for Fineview's session scale.

**7. Recommended Project File Structure**

```
fineview/
├── client/
│ ├── src/
│ │ ├── modules/
│ │ │ ├── DeviceCapabilityProbe.js ← Section 2.2
│ │ │ ├── VadModule.js ← Section 2.3
│ │ │ ├── SttModule.js ← Web Speech API wrapper
│ │ │ ├── MeydaModule.js ← Section 2.4
│ │ │ ├── VisionModule.js ← Section 2.5 (main-thread coord.)
│ │ │ ├── NlpModule.js ← Section 2.6
│ │ │ └── EventAggregator.js ← merges all module outputs
│ │ ├── workers/
│ │ │ ├── vision-worker.js ← MediaPipe in OffscreenCanvas
│ │ │ └── fineview-audio-processor.js ← AudioWorklet (Meyda)
│ │ ├── socket/
│ │ │ ├── socket-client.js ← Section 3.1
│ │ │ └── payloads.js ← payload builders / validators
│ │ └── public/
│ │ ├── assets/vad/ ← silero_vad_v5.onnx + worklet
│ │ ├── assets/ort/ ← onnxruntime-web WASM files
│ │ └── assets/mediapipe/ ← face_landmarker.task + wasm/
├── server/
│ ├── socket/
│ │ ├── index.js ← Section 3.2 setup
│ │ ├── handlers/
│ │ │ ├── candidate.js ← Section 3.3
│ │ │ └── recruiter.js
│ │ └── middleware/
│ │ ├── auth.js ← JWT verification
│ │ └── rateLimiter.js ← Section 3.5
│ ├── evaluation/
│ │ ├── queue.js ← Section 4.2 Bull queue
│ │ ├── llm.js ← Section 4.3 prompt builder
│ │ └── behaviourScorer.js ← integrity score rule engine
│ └── db/
│ └── SessionStore.js ← MongoDB session CRUD
└── docker-compose.yml ← Node + Redis + MongoDB
```

Fineview LLD | JS Architecture, Trade-offs & Scaling Blueprint | Derived from official library documentation | Confidential
