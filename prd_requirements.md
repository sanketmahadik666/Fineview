# Fineview – Product Requirements Document (PRD)

## 3. Requirements

---

# 3.1 Functional Requirements

Functional requirements describe the **core capabilities and features** of the Fineview platform from the perspective of users and system interactions.

---

## 3.1.1 Candidate Interview Session

The system must allow candidates to participate in AI-driven interview sessions.

**Features**

- Candidate authentication or session initiation
- Device capability verification
- Microphone and camera permission checks
- Guided interview start process

**Workflow**

Candidate joins interview  
→ System verifies device capability  
→ Candidate grants microphone and camera access  
→ Interview session begins

---

## 3.1.2 Speech Capture and Processing

The platform must capture candidate responses using voice input and convert them into structured text.

**Capabilities**

- Continuous speech capture
- Voice Activity Detection (VAD)
- Speech segmentation
- Speech-to-text transcription
- Transcript stabilization

**Processing Flow**

Speech Input  
→ Voice Activity Detection  
→ Speech Segmentation  
→ Speech-to-Text  
→ Structured Text Output

---

## 3.1.3 AI Interview Interaction

The system must conduct interviews using an AI-based interviewer.

**Capabilities**

- Dynamic question generation
- Context-aware follow-up questions
- Multi-round interview flow
- Domain-specific interview questions

**Interaction Flow**

AI asks question  
→ Candidate responds  
→ AI evaluates response  
→ AI generates next question

---

## 3.1.4 Candidate Monitoring

The platform must monitor candidate behavior during the interview session to ensure integrity.

**Monitoring Features**

- Webcam face detection
- Eye gaze estimation
- Multiple face detection
- Tab switching detection
- Inactivity detection

**Behavior Monitoring Flow**

Candidate action detected  
→ System records event  
→ Behavior score updated  
→ Warning or event log generated

---

## 3.1.5 Interview Evaluation

The system must evaluate candidate responses and generate structured performance scores.

**Evaluation Metrics**

- Conceptual understanding
- Problem solving approach
- Communication clarity
- Response completeness

**Example Output**

---

## 3.1.6 Interview Session Logging

The platform must store structured logs for each interview session.

**Stored Data**

- Interview questions
- Candidate responses
- Behavior monitoring events
- Evaluation scores
- Session timestamps

All session logs must be securely stored.

---

## 3.1.7 Recruiter Dashboard

Recruiters must be able to review interview results and candidate performance.

**Capabilities**

- Candidate performance reports
- Interview analytics dashboard
- Candidate ranking system
- Exportable reports

**Recruiter Workflow**

Recruiter login  
→ View interview sessions  
→ Analyze candidate reports  
→ Compare candidates

---

# 3.2 Technical Requirements

Technical requirements define the **system infrastructure, performance expectations, and architecture constraints** needed to support the Fineview platform.

---

## 3.2.1 Client-Side Processing Architecture

Fineview uses a **client-assisted architecture** where certain processing tasks run on the candidate’s device.

**Client Responsibilities**

- Speech capture
- Voice activity detection
- Speech-to-text processing
- Behavior monitoring
- Transcript filtering

**Client Processing Pipeline**

Microphone Input  
→ Voice Activity Detection  
→ Speech-to-Text  
→ Transcript Filtering  
→ Send Text to Server

**Trade-Offs & Adaptive Degradation Strategy**

To balance real-time responsiveness and avoid overloading inconsistent client hardware, Fineview utilizes an **Adaptive-Hybrid Processing Model**:

- **Lightweight Edge Processing:** Core filtering tasks like Voice Activity Detection (VAD) and preliminary gaze/tab-switch tracking run on the client.
- **Adaptive Degradation:** If the "Device capability verification" phase detects a low-end client device (or if high resource usage is detected mid-session), the system degrades monitoring frequency (e.g., polling webcam frames less often) and shifts intensive processing entirely to the server to prevent battery drain and browser crashes.

---

## 3.2.2 Backend Architecture

The backend must handle core system logic and AI evaluation.

**Backend Responsibilities**

- Interview orchestration
- AI evaluation
- Session management
- Data storage
- Recruiter analytics

**Architecture Flow**

Client Application  
→ API Gateway  
→ Interview Engine  
→ AI Evaluation Layer  
→ Database

The backend must support **stateless services** to enable horizontal scaling.

---

## 3.2.3 Performance Requirements

The platform must meet the following performance criteria:

**AI Response Latency**

- Target: less than **2 seconds**

**Speech Processing Delay**

- Target: less than **500 ms**

**Concurrent Sessions**

- Minimum support: **20 simultaneous interviews**

The architecture should scale to **100+ concurrent users**.

**Network & Bandwidth Trade-offs**

- Peak client upload bandwidth should not exceed **1.5 Mbps** to ensure accessibility on standard internet connections.
- During low-bandwidth scenarios, the client-side system will prioritize sending VAD text transcripts and discrete event flags to the server-side AI evaluation layer, pausing raw video uploads to guarantee the interview session remains actively stable.

---

## 3.2.4 Browser Compatibility

The system must support modern browsers with the following capabilities:

- WebRTC
- MediaDevices API
- WebGL
- WebSocket

**Supported Browsers**

- Google Chrome
- Microsoft Edge
- Mozilla Firefox
- Safari (limited compatibility)

---

## 3.2.5 Security Requirements

The system must ensure secure handling of all candidate data.

**Security Measures**

- HTTPS encrypted communication
- Secure session tokens
- Access control for recruiter dashboard
- Secure storage for interview logs

Sensitive information must be protected, including:

- candidate responses
- interview recordings
- evaluation data

---

## 3.2.6 Data Storage

The system must store structured interview data.

**Data Model Example**

# 4. Implementation

This section outlines how the Fineview platform will be built, including the system dependencies, development timeline, and required resources.

---

# 4.1 Dependencies

The Fineview platform relies on several software components, frameworks, and infrastructure tools to implement its functionality.

## Client-Side Dependencies

These tools run on the candidate’s device and handle interaction, monitoring, and speech processing.

**Speech Processing**

- Web Speech API – browser speech recognition
- Silero VAD – voice activity detection
- Meyda – audio feature extraction

**Computer Vision**

- MediaPipe – face detection and gaze tracking
- OpenCV.js – browser computer vision utilities

**Browser Utilities**

- WebRTC – microphone and camera capture
- WebSocket / Socket.IO – real-time communication
- Page Visibility API – tab switching detection

**Text Processing**

- compromise.js – lightweight NLP preprocessing
- Natural.js – tokenization and text classification

---

## Backend Dependencies

These technologies support interview orchestration, AI reasoning, and system operations.

**Application Framework**

- Node.js – backend runtime
- Express.js / Fastify – API server

**AI Integration**

- LLM APIs (e.g., Gemini, Groq, or equivalent)
- Prompt orchestration layer

**Data Storage**

- MongoDB – document storage for interview sessions
- Redis (optional) – caching and session management

**Real-Time Communication**

- WebSocket server
- Socket.IO

---

## Infrastructure Dependencies

**Deployment Environment**

- Linux-based cloud server
- Docker containerization
- Nginx reverse proxy

**Monitoring and Observability**

- Prometheus – metrics monitoring
- Grafana – visualization dashboards
- Log aggregation tools

---

# 4.2 Development Timeline

The implementation of Fineview will follow a phased development approach.

## Phase 1 – System Architecture Design (Week 1–2)

Objectives:

- Define system architecture
- Design data flow diagrams
- Establish development environment
- Select AI models and dependencies

Deliverables:

- Architecture documentation
- Technical stack confirmation

---

## Phase 2 – Client-Side Development (Week 3–5)

Objectives:

- Implement speech capture and STT
- Integrate VAD and segmentation
- Implement webcam monitoring
- Implement browser activity tracking

Deliverables:

- Speech capture module
- Candidate monitoring module
- Client communication layer

---

## Phase 3 – Backend Development (Week 6–8)

Objectives:

- Implement interview orchestration engine
- Integrate LLM evaluation system
- Build API endpoints
- Implement session storage

Deliverables:

- AI interview engine
- REST / WebSocket APIs
- Database schema

---

## Phase 4 – Evaluation System (Week 9–10)

Objectives:

- Implement candidate scoring model
- Generate evaluation reports
- Implement recruiter analytics dashboard

Deliverables:

- Evaluation pipeline
- Candidate scoring reports
- Interview analytics interface

---

## Phase 5 – Testing and Optimization (Week 11–12)

Objectives:

- Functional testing
- performance optimization
- browser compatibility testing
- security testing

Deliverables:

- production-ready system
- performance benchmarks
- security audit results

---

# 4.3 Resources Needed

The successful implementation of Fineview requires both human and technical resources.

## Development Team

Recommended team composition:

| Role              | Responsibility                |
| ----------------- | ----------------------------- |
| Product Manager   | Product planning and roadmap  |
| Frontend Engineer | Client-side application       |
| Backend Engineer  | API and system logic          |
| AI/ML Engineer    | AI evaluation pipeline        |
| DevOps Engineer   | Deployment and infrastructure |

For smaller teams, some roles can be combined.

---

## Infrastructure Resources

**Development Environment**

- developer workstations
- version control system (Git)

**Cloud Infrastructure**

- application server
- database server
- monitoring system

Typical configuration:

- 2–4 vCPU server
- 4–8 GB RAM
- scalable storage

---

## Third-Party Services

The platform may rely on external services for:

- AI model inference
- analytics
- monitoring tools

These services should be selected based on:

- reliability
- scalability
- cost efficiency

---

# Summary

The implementation plan ensures that the Fineview platform is built using a structured development process with clearly defined dependencies and milestones.

Key principles guiding implementation:

- modular architecture
- client-assisted processing
- scalable backend services
- secure data management

This approach enables the platform to support scalable AI-driven interview workflows while maintaining cost efficiency.
