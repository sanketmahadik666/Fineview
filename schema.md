## WebSocket Message Schemas

This document defines the **client–server contract** for all WebSocket messages used by the Fineview interview runtime.

All messages share a common envelope:

```json
{
  "type": "<message_type>",
  "payload": { /* message-specific fields */ },
  "timestamp": 1731628800000
}
```

- **type**: string discriminator (see list below).
- **payload**: message body (schema per type).
- **timestamp**: client-side Unix epoch in milliseconds when the message was created.

---

### `start_interview` (client → server)

Sent once when the candidate begins the interview, **before** any transcript or monitoring messages.

```json
{
  "type": "start_interview",
  "payload": {
    "name": "Jane Doe",
    "role": "Frontend Engineer",
    "deviceInfo": {
      "browser": {
        "webRTC": true,
        "mediaDevices": true,
        "webGL": true,
        "webSocket": true,
        "speechRecognition": true,
        "audioContext": true
      },
      "permissions": {
        "microphone": true,
        "camera": true
      },
      "performance": {
        "benchmarkTime": 87,
        "tier": "medium",
        "hardwareConcurrency": 8,
        "deviceMemory": 8
      },
      "overall": "medium"
    }
  },
  "timestamp": 1731628800000
}
```

**Notes**
- `name` and `role` are free-form strings used in recruiter dashboards.
- `deviceInfo` mirrors the object produced by `DeviceCapability.checkAll()`.

---

### `transcript` (client → server)

Carries speech-to-text segments produced on the client.

```json
{
  "type": "transcript",
  "payload": {
    "text": "I led a team of five engineers...",
    "isFinal": true
  },
  "timestamp": 1731628800500
}
```

**Fields**
- `text` (string, required): accumulated transcript text.
- `isFinal` (boolean, required): whether this segment is final and should be evaluated.

The server **only runs AI evaluation logic on `isFinal === true`**.

---

### `monitoring_batch` (client → server)

Batch of monitoring events (webcam, tab switches, inactivity, suspicious actions, etc.).

```json
{
  "type": "monitoring_batch",
  "payload": {
    "events": [
      {
        "type": "face_detected",
        "timestamp": 1731628801000,
        "count": 1
      },
      {
        "type": "tab_switch",
        "timestamp": 1731628805000,
        "direction": "away",
        "count": 1
      }
    ],
    "count": 2
  },
  "timestamp": 1731628806000
}
```

**Event object**

Each element in `payload.events` must be an object with:
- `type` (string, required): e.g. `face_detected`, `face_lost`, `multiple_faces`, `looking_away`, `tab_switch`, `inactivity`, `suspicious_action`, etc.
- `timestamp` (number, required): client-side Unix epoch in ms.
- Any additional fields are stored in `MonitoringEvent.payload`.

---

### `monitoring_event` (client → server) – legacy / low-volume

For low-volume monitoring events that are not batched. Prefer `monitoring_batch` for high-frequency events.

```json
{
  "type": "monitoring_event",
  "payload": {
    "type": "multiple_faces",
    "timestamp": 1731628807000,
    "count": 2
  },
  "timestamp": 1731628807000
}
```

The inner `payload` has the same shape as a single element of `monitoring_batch.payload.events`.

---

### `end_interview` (client → server)

Explicit signal that the candidate has ended the interview from the client UI.

```json
{
  "type": "end_interview",
  "payload": {
    "reason": "candidate_ended"
  },
  "timestamp": 1731628810000
}
```

**Fields**
- `reason` (string, optional): e.g. `candidate_ended`, `network_error`, `timeout`.

On receipt, the server should:
- Mark the `InterviewSession` as `completed` or `aborted` (implementation-specific).
- Set `endTime` if not already set.

---

### `ai_question` (server → client)

AI interviewer question pushed from the server.

```json
{
  "type": "ai_question",
  "payload": {
    "question": "Can you describe a challenging project you've worked on?"
  }
}
```

**Fields**
- `question` (string, required): the current question text to display.

---

### `interview_completed` (server → client)

Sent once when the interview is fully evaluated.

```json
{
  "type": "interview_completed",
  "payload": {
    "message": "Interview concluded and evaluated successfully.",
    "scores": {
      "conceptualUnderstanding": 88,
      "problemSolving": 82,
      "communication": 91,
      "responseCompleteness": 87,
      "overallScore": 87
    }
  }
}
```

**Fields**
- `message` (string, required): human-readable status for the UI.
- `scores` (object, optional for now but recommended):
  - `conceptualUnderstanding` (0–100)
  - `problemSolving` (0–100)
  - `communication` (0–100)
  - `responseCompleteness` (0–100)
  - `overallScore` (0–100)

These scores map directly to the evaluation metrics defined in the PRD (3.1.5).

---

### `ping` / `pong` (heartbeat)

Used by the client to detect silent disconnections and by the server to acknowledge.

```json
{ "type": "ping", "payload": {}, "timestamp": 1731628800000 }
{ "type": "pong", "payload": {}, "timestamp": 1731628800001 }
```

No additional fields are required; payload is reserved for future use.

