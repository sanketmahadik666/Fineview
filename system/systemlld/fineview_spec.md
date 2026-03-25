**FINEVIEW**

Frontend Tools & Backend Payload Specification

Technical Reference for Data Flow, Library APIs, and Evaluation Pipeline

**1. Overview**

This document specifies every frontend library used in Fineview, the exact data each one outputs, how that data is packaged into unified Socket.IO payloads, and how the backend consumes it for AI evaluation. This is the binding contract between client and server.

The system uses a Client-Assisted Architecture: intensive ML tasks (VAD, face detection, NLP) run on the candidate's device to reduce server load, then emit structured JSON events via Socket.IO to the backend evaluation engine.

**2. Frontend Library API Reference**

Each subsection below documents the exact output data structure produced by each library. These outputs form the raw materials that are packaged into backend payloads.

**2.1 @ricky0123/vad --- Voice Activity Detection**

> **NPM: @ricky0123/vad | Engine: Silero ONNX via onnxruntime-web | License: MIT**

**Purpose**

Detects whether a candidate is speaking. Triggers speech segments for transcription and measures silence/speech ratio for behavioural scoring.

**Installation**

```
npm install @ricky0123/vad
// Also copy ONNX + worklet files to public/ (see webpack config in docs)
```

**Initialization Pattern**

```
const myvad = await vad.MicVAD.new({
positiveSpeechThreshold: 0.5, // 0-1: frame classified as speech above this
negativeSpeechThreshold: 0.35, // 0-1: frame classified as silence below this
redemptionFrames: 8, // consecutive silence frames before SPEECH_END
preSpeechPadFrames: 1,
minSpeechFrames: 3, // min speech frames to fire onSpeechEnd
frameSamples: 1536, // 16kHz samples per frame (~96ms)

onSpeechStart: () => { /* emit SPEECH_START */ },
onSpeechEnd: (audio) => { /* audio = Float32Array at 16kHz */ },
onVADMisfire: () => { /* too short, discard */ }
});
myvad.start();
```

**Output Data Structure**

  --------------------------------------------------------------------------------------------------------------
  **Event / Field**               **Type**       **Range / Values**         **Use in Fineview**
  ------------------------------- -------------- -------------------------- ------------------------------------
  onSpeechStart callback          void           ---                        Start transcription, start timer

  onSpeechEnd → audio             Float32Array   16kHz PCM, 16-bit equiv.   Pass to Web Speech API or STT

  onVADMisfire callback           void           ---                        Discard pending transcript

  speechProbability (per frame)   number         0.0 -- 1.0                 Confidence a frame contains speech

  SPEECH_START msg                string         'SPEECH_START'           Begin segment log

  SPEECH_CONTINUE msg             string         'SPEECH_CONTINUE'        Mid-speech indicator

  SPEECH_END msg                  string         'SPEECH_END'             Close segment, send transcript
  --------------------------------------------------------------------------------------------------------------

**Backend Payload Emitted**

```
socket.emit('vad:event', {
sessionId: string,
questionIndex: number,
type: 'SPEECH_START' | 'SPEECH_END' | 'MISFIRE',
timestamp: number, // Date.now()
durationMs?: number, // duration of speech segment (on END)
speechRatio?: number // speech_frames / total_frames in segment
});
```

**2.2 Web Speech API --- Speech to Text**

> **Browser Native API | Chrome/Edge: server-based STT | Firefox: limited | Safari: limited**

**Purpose**

Converts candidate speech (triggered by VAD) into text transcripts. Produces interim (unstable) and final (stable) results with confidence scores.

**Initialization Pattern**

```
const recognition = new (window.SpeechRecognition
|| window.webkitSpeechRecognition)();

recognition.lang = 'en-US'; // BCP-47 language tag
recognition.continuous = true; // keep listening
recognition.interimResults = true; // stream interim results
recognition.maxAlternatives = 1; // single best hypothesis

recognition.onresult = (event) => {
for (let i = event.resultIndex; i < event.results.length; i++) {
const result = event.results[i];
const transcript = result[0].transcript; // string
const confidence = result[0].confidence; // 0-1
const isFinal = result.isFinal; // boolean
// emit to backend...
}
};
```

**SpeechRecognitionResult Object --- Full Schema**

  ----------------------------------------------------------------------------------------------------------------------------------
  **Property**                   **Type**                      **Description**
  ------------------------------ ----------------------------- ---------------------------------------------------------------------
  event.results                  SpeechRecognitionResultList   All results in the session (array-like)

  results[i].isFinal           boolean                       true = stable final result; false = interim, may change

  results[i][j].transcript   string                        Raw text of recognized speech (j=0 is best hypothesis)

  results[i][j].confidence   number 0-1                    How confident the engine is (Chrome: real value; Firefox: always 1)

  results[i].length            number                        Number of n-best alternatives (= maxAlternatives)
  ----------------------------------------------------------------------------------------------------------------------------------

**Backend Payload Emitted**

```
// Interim --- fired frequently, used for real-time display only
socket.emit('transcript:interim', {
sessionId: string,
questionIndex: number,
text: string,
confidence: number,
timestamp: number
});

// Final --- stable, used for evaluation
socket.emit('transcript:final', {
sessionId: string,
questionIndex: number,
text: string,
confidence: number,
timestamp: number,
durationMs: number
});
```

**Transcript Stabilization Strategy**

Interim results are buffered and discarded. Only isFinal === true transcripts are sent for evaluation. If confidence < 0.6, the transcript is flagged with lowConfidence: true and the AI evaluator is instructed to weight it accordingly.

**2.3 Meyda.js --- Audio Feature Extraction**

> **NPM: meyda | Web Audio API wrapper | ~3.34x faster than real-time | MIT License**

**Purpose**

Extracts acoustic features from the candidate's speech --- primarily RMS (loudness), energy, spectral spread, and MFCC --- to build a paralinguistic profile. These signal patterns like nervousness, hesitation, and low vocal energy.

**Initialization Pattern**

```
const audioCtx = new AudioContext();
const source = audioCtx.createMediaStreamSource(stream);

const analyzer = Meyda.createMeydaAnalyzer({
audioContext: audioCtx,
source: source,
bufferSize: 512, // ~11ms per analysis frame at 44.1kHz
featureExtractors: [
'rms', // loudness
'energy', // signal energy
'zcr', // zero crossing rate (noisiness)
'spectralCentroid', // 'brightness'
'spectralFlatness', // 0=pitched, 1=noise
'spectralSpread', // frequency bandwidth
'mfcc', // 13 mel cepstral coefficients
'loudness', // perceptual loudness object
],
callback: (features) => { /* aggregate, then batch-emit */ }
});
analyzer.start();
```

**Feature Output Schema**

  ----------------------------------------------------------------------------------------------------------------------
  **Feature Key**     **Output Type**      **Range**                **Interview Relevance**
  ------------------- -------------------- ------------------------ ----------------------------------------------------
  rms                 number               0.0 -- 1.0               Overall vocal volume

  energy              number               ≥ 0.0                    Raw signal power

  zcr                 number               0 -- bufferSize/2        Noisiness / consonant density

  spectralCentroid    number               0 -- sampleRate/2 (Hz)   Voice brightness / clarity

  spectralFlatness    number               0.0 -- 1.0               0=pure tone, 1=white noise (nervousness indicator)

  spectralSpread      number               0 -- FFT_size/2          Frequency bandwidth (articulation width)

  mfcc                Float32Array[13]   Unconstrained float      Voice timbre fingerprint for ML model

  loudness.total      number               ≥ 0                      Perceptual loudness (human-weighted)

  loudness.specific   Float32Array[24]   Per bark band            Bark-scale loudness (optional, heavy)
  ----------------------------------------------------------------------------------------------------------------------

**Backend Payload Emitted (Batched every 5s)**

```
// Meyda emits ~86 frames/second --- NEVER send per-frame.
// Aggregate across 5-second windows, send summary stats.
socket.emit('audio:features', {
sessionId: string,
questionIndex: number,
windowStart: number, // timestamp ms
windowEnd: number,
rms_avg: number, // mean RMS across window
rms_min: number,
rms_max: number,
energy_avg: number,
spectralFlatness_avg: number,
spectralCentroid_avg: number,
zcr_avg: number,
mfcc_mean: number[13], // averaged MFCC vector
silenceRatio: number, // frames with rms < 0.02 / total frames
speakingRate: number // derived: words per minute (from VAD + STT)
});
```

**2.4 MediaPipe FaceLandmarker --- Face Detection & Gaze Estimation**

> **NPM: @mediapipe/tasks-vision | BlazeFace model | GPU delegate (WebGL) | Apache 2.0**

**Purpose**

Monitors candidate presence, detects multiple faces, and estimates gaze direction from eye landmarks. Feeds the behavioural integrity score.

**Initialization Pattern**

```
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

const vision = await FilesetResolver.forVisionTasks(
'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
);
const faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
baseOptions: {
modelAssetPath: 'face_landmarker.task',
delegate: 'GPU' // falls back to CPU automatically
},
runningMode: 'VIDEO', // live webcam stream
numFaces: 3, // detect up to 3 faces
outputFaceBlendshapes: true,
outputFacialTransformationMatrixes: true
});

// Call in requestAnimationFrame loop:
const result = faceLandmarker.detectForVideo(videoEl, performance.now());
```

**FaceLandmarkerResult Schema**

  ----------------------------------------------------------------------------------------------------------------------------------------
  **Field**                                **Type**                     **Description**
  ---------------------------------------- ---------------------------- ------------------------------------------------------------------
  faceLandmarks                            NormalizedLandmark[][]   Outer array = faces; inner = 478 {x,y,z} points (0-1 normalized)

  faceLandmarks[i][j].x                number 0-1                   Normalized x coordinate

  faceLandmarks[i][j].y                number 0-1                   Normalized y coordinate

  faceLandmarks[i][j].z                number                       Relative depth (negative = closer to camera)

  faceBlendshapes                          Classifications[][]      52 expression coefficients per face

  faceBlendshapes[i][j].categoryName   string                       e.g. 'eyeLookOutLeft', 'browDownRight'

  faceBlendshapes[i][j].score          number 0-1                   Coefficient value for that expression

  facialTransformationMatrixes             Matrix4x4[]                Rotation + translation matrix per face
  ----------------------------------------------------------------------------------------------------------------------------------------

**Key Blendshapes for Gaze Estimation**

  -------------------------------------------------------------------------------------------------
  **Blendshape Name**            **Gaze Meaning**                         **Threshold for Alert**
  ------------------------------ ---------------------------------------- -------------------------
  eyeLookOutLeft                 Left eye looking left (off-screen)       > 0.6

  eyeLookOutRight                Right eye looking right (off-screen)     > 0.6

  eyeLookUp                      Looking upward (away from screen)        > 0.5

  eyeLookDown                    Looking downward                         > 0.5

  eyeBlinkLeft / eyeBlinkRight   Eye closure / blink                      > 0.85 sustained

  browDownLeft / browDownRight   Furrowed brow (concentration / stress)   > 0.7
  -------------------------------------------------------------------------------------------------

**Derived Gaze Direction from Head Pose Matrix**

```
// Extract Euler angles from facialTransformationMatrixes[0].data
const mat = result.facialTransformationMatrixes[0].data; // 16-element Float32Array

// Pitch (up/down), Yaw (left/right), Roll (tilt)
const pitch = Math.asin(-mat[9]) * (180 / Math.PI);
const yaw = Math.atan2(mat[8], mat[10]) * (180 / Math.PI);
const roll = Math.atan2(mat[1], mat[5]) * (180 / Math.PI);

// Thresholds for 'looking away':
// |yaw| > 30° → looking left/right
// |pitch| > 20° → looking up/down
```

**Backend Payload Emitted (every 2s aggregate)**

```
socket.emit('monitoring:face', {
sessionId: string,
questionIndex: number,
timestamp: number,
facesDetected: number, // 0 = absent, 2+ = multiple people
lookingAway: boolean, // true if |yaw|>30 or |pitch|>20
gazeDirection: {
yaw: number, // degrees: + = right, - = left
pitch: number, // degrees: + = up, - = down
roll: number
},
blendshapes: { // only key blendshapes
eyeLookOutLeft: number,
eyeLookOutRight: number,
eyeLookUp: number,
eyeBlinkLeft: number,
eyeBlinkRight: number
},
events: string[] // ['MULTIPLE_FACES','NO_FACE','LOOKING_AWAY']
});
```

**2.5 Page Visibility API --- Tab Switching Detection**

> **Browser Native API | All modern browsers | Zero dependencies**

**Purpose**

Detects when the candidate switches to another tab or minimizes the browser window during an interview, contributing to the integrity/honesty score.

**Implementation Pattern**

```
let tabSwitchCount = 0;
let lastHiddenAt = null;
let totalHiddenMs = 0;

document.addEventListener('visibilitychange', () => {
if (document.visibilityState === 'hidden') {
tabSwitchCount++;
lastHiddenAt = Date.now();
socket.emit('monitoring:tabswitch', {
type: 'HIDDEN',
tabSwitchCount,
timestamp: lastHiddenAt,
sessionId,
questionIndex
});
} else if (document.visibilityState === 'visible' && lastHiddenAt) {
const duration = Date.now() - lastHiddenAt;
totalHiddenMs += duration;
socket.emit('monitoring:tabswitch', {
type: 'VISIBLE',
hiddenDurationMs: duration,
totalHiddenMs,
tabSwitchCount,
timestamp: Date.now(),
sessionId,
questionIndex
});
lastHiddenAt = null;
}
});
```

**Payload Fields**

  --------------------------------------------------------------------------------
  **Field**          **Type**     **Description**
  ------------------ ------------ ------------------------------------------------
  type               string       'HIDDEN' | 'VISIBLE'

  tabSwitchCount     number       Running total of switches (session-wide)

  hiddenDurationMs   number       How long the tab was hidden (only on VISIBLE)

  totalHiddenMs      number       Running total of hidden time

  timestamp          number       Date.now() in ms

  questionIndex      number       Which question was active when switch occurred
  --------------------------------------------------------------------------------

**2.6 compromise.js --- Client-Side NLP Preprocessing**

> **NPM: compromise | ~250KB | Zero dependencies | MIT License**

**Purpose**

Lightweight NLP on the final transcript before sending to backend. Extracts technical terms, detects filler words, measures sentence structure. Reduces AI evaluation load by pre-tagging data.

**Key Extraction Pattern**

```
import nlp from 'compromise';

function analyzeTranscript(text) {
const doc = nlp(text);

return {
// Word-level stats
wordCount: doc.wordCount(),
sentenceCount: doc.sentences().length,

// Entity detection
nouns: doc.nouns().out('array'),
verbs: doc.verbs().out('array'),
acronyms: doc.acronyms().out('array'), // e.g. ['API', 'REST', 'JWT']

// Filler word detection (custom list)
fillerCount: countFillers(text),
fillerRatio: countFillers(text) / doc.wordCount(),

// Temporal awareness
hasPastTense: doc.verbs().toPastTense().length > 0,
hasFutureTense: doc.verbs().toFutureTense().length > 0,
};
}

const FILLERS = ['um','uh','like','basically','actually','you know','sort of'];
function countFillers(text) {
return FILLERS.reduce((c, f) => c + (text.toLowerCase().match(
new RegExp('\\\b' + f + '\\\b','g')) || []).length, 0);
}
```

**NLP Enrichment Added to Final Transcript Payload**

```
socket.emit('transcript:final', {
...baseTranscriptPayload,
nlp: {
wordCount: number,
sentenceCount: number,
technicalTerms: string[], // acronyms + domain nouns
fillerWordCount: number,
fillerRatio: number, // 0-1 (>0.12 = high filler)
avgWordsPerSentence: number,
verbDiversity: number // unique verbs / total verbs
}
});
```

**3. Unified Backend Payload Contract**

All Socket.IO payloads share a common envelope structure. The backend validates every incoming event against this schema before passing it to the AI evaluation layer.

**3.1 Common Envelope Schema**

```
// Every payload MUST include these root fields
{
sessionId: string, // UUID: unique interview session
candidateId: string, // UUID: candidate identity
questionIndex: number, // 0-based index of active question
timestamp: number, // Date.now() at time of emission
eventType: string // discriminator (see Section 3.2)
}
```

**3.2 Socket.IO Event Map**

  --------------------------------------------------------------------------------------------------------------
  **Event Name**          **Direction**   **Emitted By**   **Purpose**
  ----------------------- --------------- ---------------- -----------------------------------------------------
  session:start           C → S           Client           Candidate joins, includes device capability report

  session:end             C → S           Client           Interview completed or abandoned

  question:ready          S → C           Server           AI sends next question text + questionIndex

  transcript:interim      C → S           Client           Real-time STT for live display only (not evaluated)

  transcript:final        C → S           Client           Stable transcript + NLP metadata

  vad:event               C → S           Client           Speech start/end/misfire with timing

  audio:features          C → S           Client           Batched Meyda acoustic features (every 5s)

  monitoring:face         C → S           Client           MediaPipe face + gaze aggregate (every 2s)

  monitoring:tabswitch    C → S           Client           Page Visibility event (immediate)

  monitoring:inactivity   C → S           Client           No voice input for > 30s (from VAD timer)

  evaluation:result       S → C           Server           AI scores per question + behavioural events

  interview:complete      S → C           Server           Full session evaluation report
  --------------------------------------------------------------------------------------------------------------

**3.3 Full Session Payload (session:start)**

```
socket.emit('session:start', {
sessionId: string,
candidateId: string,
timestamp: number,
device: {
userAgent: string,
cpuCores: number, // navigator.hardwareConcurrency
memoryGB: number, // navigator.deviceMemory
connectionType: string, // navigator.connection.effectiveType
tier: 'LOW' | 'MID' | 'HIGH' // computed from above
},
config: {
vadEnabled: boolean,
meydaEnabled: boolean,
mediapipeEnabled: boolean,
sttEngine: 'webSpeechApi' | 'whisperCloud'
}
});
```

**3.4 Full Transcript Payload (transcript:final)**

```
socket.emit('transcript:final', {
// Envelope
sessionId: string,
candidateId: string,
questionIndex: number,
timestamp: number,
eventType: 'transcript:final',

// Speech content
text: string, // raw STT transcript
confidence: number, // 0-1 from Web Speech API
lowConfidence: boolean, // true if confidence < 0.6
durationMs: number, // VAD segment duration
segmentIndex: number, // which speech segment within the answer

// NLP enrichment (from compromise.js)
nlp: {
wordCount: number,
sentenceCount: number,
technicalTerms: string[],
fillerWordCount: number,
fillerRatio: number,
avgWordsPerSentence: number,
verbDiversity: number
},

// Acoustic snapshot (from Meyda, covering same segment)
acoustics: {
rms_avg: number,
spectralFlatness: number,
speakingRateWPM: number
}
});
```

**3.5 Full Monitoring Payload (monitoring:face)**

```
socket.emit('monitoring:face', {
sessionId: string,
candidateId: string,
questionIndex: number,
timestamp: number,
eventType: 'monitoring:face',

windowMs: 2000, // aggregation window
facesDetected: number, // 0 | 1 | 2+
lookingAway: boolean,
awayDurationMs: number, // how long in this window

gazeDirection: {
yaw: number, // degrees
pitch: number,
roll: number
},

blendshapes: {
eyeLookOutLeft: number,
eyeLookOutRight: number,
eyeLookUp: number,
eyeBlinkLeft: number,
eyeBlinkRight: number,
browDownLeft: number,
browDownRight: number
},

events: ('MULTIPLE_FACES' | 'NO_FACE' | 'LOOKING_AWAY' | 'EYES_CLOSED')[]
});
```

**4. Backend Evaluation Pipeline**

The backend receives all socket events and feeds them through two parallel pipelines: the AI Transcript Evaluator and the Behavioural Integrity Scorer. Results are merged into a per-question evaluation object.

**4.1 AI Transcript Evaluator**

On receiving transcript:final, the Interview Engine assembles a structured LLM prompt combining the question, transcript, NLP metadata, and acoustic features.

**LLM Prompt Structure (sent to Gemini/Groq)**

```
SYSTEM:
You are an expert technical interviewer evaluating a candidate response.
Analyze the provided data and return ONLY valid JSON matching the schema.

USER:
Question [${questionIndex}]: ${questionText}

Candidate Response:
Transcript: ${transcript.text}
Duration: ${transcript.durationMs}ms
Confidence: ${transcript.confidence}

NLP Analysis:
- Words: ${nlp.wordCount}, Sentences: ${nlp.sentenceCount}
- Technical terms: ${nlp.technicalTerms.join(', ')}
- Filler ratio: ${nlp.fillerRatio}
- Avg sentence length: ${nlp.avgWordsPerSentence}

Voice Quality:
- RMS avg: ${acoustics.rms_avg} (volume)
- Speaking rate: ${acoustics.speakingRateWPM} WPM
- Spectral flatness: ${acoustics.spectralFlatness} (0=clear, 1=noise)

Return JSON: { conceptual: 0-10, problemSolving: 0-10,
communication: 0-10, completeness: 0-10,
feedback: string, keyStrengths: string[], improvements: string[] }
```

**4.2 Behavioural Integrity Scorer**

Runs independently of the AI evaluator. Computes a 0-100 integrity score based on monitoring events using a weighted rule engine.

  -----------------------------------------------------------------------------------------------------
  **Signal**                  **Source**        **Deduction**        **Rule**
  --------------------------- ----------------- -------------------- ----------------------------------
  Tab switch                  Page Visibility   -5 per switch        Max -25 total

  No face detected            MediaPipe         -8 per 10s window    Only during speech

  Multiple faces              MediaPipe         -15 per detection    Immediate alert generated

  Consistently looking away   MediaPipe gaze    -3 per window        |yaw|>30° for >50% of window

  High filler ratio           compromise.js     -2 per answer        fillerRatio > 0.12

  VAD misfire rate            Silero VAD        -1 per 5 misfires    Indicates rambling/mumbling

  Long inactivity             VAD timer         -5 per 30s silence   During question time

  Low STT confidence          Web Speech API    -2 per answer        confidence < 0.5
  -----------------------------------------------------------------------------------------------------

**4.3 Per-Question Evaluation Object (stored in MongoDB)**

```
{
sessionId: string,
candidateId: string,
questionIndex: number,
questionText: string,

// AI Scores (0-10 each)
scores: {
conceptual: number,
problemSolving: number,
communication: number,
completeness: number,
composite: number // weighted average
},

// AI Feedback
feedback: {
summary: string,
keyStrengths: string[],
improvements: string[]
},

// Transcript chain (all final segments concatenated)
fullTranscript: string,
transcriptSegments: TranscriptPayload[],

// Acoustic summary
acousticProfile: {
avgRMS: number,
avgSpeakingRateWPM: number,
totalSpeechMs: number,
silenceRatio: number,
avgSpectralFlatness: number
},

// Behaviour events
behaviourEvents: BehaviourEvent[],
integrityScore: number, // 0-100

timestamps: {
questionAskedAt: number,
firstResponseAt: number,
lastResponseAt: number,
evaluatedAt: number
}
}
```

**4.4 Session-Level Summary (interview:complete payload)**

```
socket.emit('interview:complete', {
sessionId: string,
candidateId: string,
completedAt: number,

overallScores: {
conceptual: number, // mean across questions
problemSolving: number,
communication: number,
completeness: number,
composite: number,
integrityScore: number
},

questionEvaluations: PerQuestionEvaluation[],

candidateRanking: {
percentile: number, // vs all candidates in same role
recommendation: 'STRONG_HIRE' | 'HIRE' | 'MAYBE' | 'NO_HIRE'
},

behaviourSummary: {
tabSwitches: number,
totalHiddenMs: number,
multipleFaceEvents: number,
noFaceEvents: number,
lookingAwayPct: number // % of interview time looking away
}
});
```

**5. Adaptive Degradation Strategy**

When device capability is LOW (detected via session:start.device.tier), the client disables or reduces specific feature pipelines. This prevents battery drain and browser crashes on low-end hardware.

  ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  **Device Tier**               **VAD**                                  **Meyda**                        **MediaPipe**                          **STT**
  ----------------------------- ---------------------------------------- -------------------------------- -------------------------------------- -------------------------------
  HIGH (4+ cores, 4+ GB RAM)    Full Silero VAD                          All 8 features, 512 buffer       478 landmarks + blendshapes + matrix   Web Speech API continuous

  MID (2-3 cores, 2-4 GB RAM)   Full Silero VAD                          Reduced: rms, energy, zcr only   Face detect only, no blendshapes       Web Speech API continuous

  LOW (1-2 cores, <2 GB RAM)   WebRTC basic VAD (amplitude threshold)   Disabled --- no Meyda            Disabled --- no MediaPipe              Web Speech API non-continuous
  ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

The backend evaluation layer is notified of the device tier and adjusts scoring weights accordingly --- low-quality acoustic or gaze data is excluded from composite scores rather than penalizing the candidate for hardware limitations.

**6. Bandwidth Management**

Per the PRD, peak client upload bandwidth must not exceed 1.5 Mbps. The following payload frequency budget ensures compliance.

  --------------------------------------------------------------------------------------------------
  **Event**              **Frequency**               **Avg Payload Size**   **Bandwidth**
  ---------------------- --------------------------- ---------------------- ------------------------
  transcript:final       ~0.3/s (per speech end)    ~800 bytes            ~1.9 Kbps

  transcript:interim     ~2/s                       ~300 bytes            ~4.8 Kbps

  vad:event              ~0.6/s (start+end pairs)   ~200 bytes            ~1 Kbps

  audio:features         0.2/s (every 5s)            ~600 bytes            ~1 Kbps

  monitoring:face        0.5/s (every 2s)            ~500 bytes            ~2 Kbps

  monitoring:tabswitch   Rare (<0.01/s)             ~200 bytes            Negligible

  Total (all channels)   ---                         ---                    ~11 Kbps (0.011 Mbps)
  --------------------------------------------------------------------------------------------------

This is well below the 1.5 Mbps budget. Raw webcam video is NOT streamed in this architecture --- only structured feature data is sent. Video recording (if required) should be stored locally as a Blob and uploaded post-session as a separate background upload.

Fineview Technical Specification | Frontend Tools & Backend Payload Contract | Confidential
