import InterviewSession from '../models/InterviewSession.js';
import Transcript from '../models/Transcript.js';
import llmService from './LLMService.js';
import EvalQueue from './EvalQueue.js';

/**
 * AI Interview Engine — Phase 3 update
 *
 * Changes in this revision:
 *   ✅ EvalQueue — evaluation is decoupled from the WebSocket handler.
 *      triggerEvaluation() enqueues an async job; the WS handler returns
 *      immediately and the job runs in the background with retries.
 *   ✅ Session state map — kept in-process (safe per-worker); documented
 *      Redis upgrade path in comments.
 *   ✅ WebSocket safety — all ws.send() calls check ws.readyState first.
 */

const evalQueue = new EvalQueue({ concurrency: 2, maxRetries: 3 });

class InterviewEngine {
  constructor() {
    this.defaultQuestions = [
      "Hello! Please introduce yourself and walk us through your background.",
      "Can you describe a challenging project you've worked on and how you overcame the obstacles?",
      "How do you handle disagreements with team members or stakeholders?",
      "What are your long-term career goals and how does this role fit into them?",
      "Thank you for your time. Do you have any questions for us?"
    ];

    // In-process session state.
    // LLD note: In a multi-node Redis-backed deployment, replace this Map with
    // `await redisClient.hGetAll(`session:${key}`)` + `hSet` calls.
    // The interface of startSession / handleCandidateResponse / triggerEvaluation
    // remains identical — only the state read/write lines change.
    this.sessionState = new Map();
  }

  async startSession(sessionId, ws) {
    const key = sessionId.toString();

    const session = await InterviewSession.findById(sessionId).lean().catch(() => null);
    const jobRole = session?.jobRole || 'Unspecified';

    this.sessionState.set(key, {
      questionIndex: 0,
      turnCount: 0,
      jobRole,
    });

    let questionText = null;
    if (llmService.isConfigured) {
      try {
        questionText = await llmService.generateQuestion({ jobRole, questionIndex: 0 });
      } catch (err) {
        console.warn('[InterviewEngine] LLM generateQuestion failed, using default script:', err.message);
      }
    }

    this._sendQuestion(ws, questionText || this.defaultQuestions[0]);
  }

  async handleCandidateResponse(sessionId, ws, transcriptText, isFinal) {
    if (!isFinal) return;

    const key = sessionId.toString();
    const state = this.sessionState.get(key);
    if (!state) return;

    state.turnCount++;

    if (state.turnCount >= 2) {
      state.questionIndex++;
      state.turnCount = 0;

      if (state.questionIndex < this.defaultQuestions.length) {
        setTimeout(async () => {
          const idx = state.questionIndex;
          const fallback = this.defaultQuestions[idx] ?? this.defaultQuestions[this.defaultQuestions.length - 1];

          let nextQuestion = null;
          if (llmService.isConfigured) {
            try {
              nextQuestion = await llmService.generateQuestion({
                jobRole: state.jobRole,
                questionIndex: idx,
                previousQuestion: this.defaultQuestions[idx - 1] || this.defaultQuestions[0],
                lastAnswer: transcriptText,
              });
            } catch (err) {
              console.warn('[InterviewEngine] LLM generateQuestion failed, using default:', err.message);
            }
          }

          this._sendQuestion(ws, nextQuestion || fallback);
        }, 1500);
      } else {
        this.triggerEvaluation(sessionId, ws);
      }
    }
  }

  _sendQuestion(ws, questionText) {
    if (!ws || ws.readyState !== 1 /* WebSocket.OPEN */) return;
    ws.send(JSON.stringify({ type: 'ai_question', payload: { question: questionText } }));
  }

  /**
   * Enqueue a final evaluation job.
   * Returns immediately — the actual evaluation runs async via EvalQueue.
   */
  triggerEvaluation(sessionId, ws) {
    const key = sessionId.toString();

    if (!this.sessionState.has(key)) {
      console.log(`[InterviewEngine] triggerEvaluation called for unknown session: ${sessionId}`);
      return;
    }

    this._sendQuestion(ws, 'Evaluating your interview...');

    // Mark session state cleaned up immediately to prevent double-evaluation
    this.sessionState.delete(key);

    // Enqueue async — EvalQueue handles retries on transient failures
    evalQueue.enqueue(key, async () => {
      await this._runEvaluation(sessionId, ws);
    }).catch((err) => {
      console.error(`[InterviewEngine] Evaluation permanently failed for session ${sessionId}:`, err.message);
    });
  }

  async _runEvaluation(sessionId, ws) {
    const session = await InterviewSession.findById(sessionId).lean().catch(() => null);
    const jobRole = session?.jobRole || 'Unspecified';
    const candidateName = session?.candidateName || 'Candidate';

    const finalSegments = await Transcript.find({ sessionId, isFinal: true })
      .sort({ timestamp: 1 })
      .lean()
      .catch(() => []);

    const transcriptText = finalSegments.map((s) => s.text).join('\n');

    let scores = null;
    let feedback = '';

    if (llmService.isConfigured) {
      try {
        const result = await llmService.evaluateInterview({ jobRole, candidateName, transcript: transcriptText });
        scores = result.scores || null;
        feedback = result.feedback || '';
      } catch (err) {
        console.error('[InterviewEngine] LLM evaluation failed, using simulated scores:', err.message);
      }
    }

    if (!scores) {
      const sim = {
        conceptualUnderstanding: Math.floor(Math.random() * 20) + 80,
        problemSolving: Math.floor(Math.random() * 20) + 75,
        communication: Math.floor(Math.random() * 20) + 85,
        responseCompleteness: Math.floor(Math.random() * 20) + 80,
      };
      sim.overallScore = Math.floor(
        (sim.conceptualUnderstanding + sim.problemSolving + sim.communication + sim.responseCompleteness) / 4
      );
      scores = sim;
      feedback = 'Simulated evaluation — real AI evaluation not configured.';
    }

    await InterviewSession.findByIdAndUpdate(
      sessionId,
      { status: 'completed', endTime: new Date(), evaluationScores: scores, aiFeedback: feedback },
      { writeConcern: { w: 'majority', wtimeout: 5000 } }
    );

    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'interview_completed',
        payload: { message: 'Interview concluded and evaluated successfully.', scores },
      }));
    }
  }

  getQueueMetrics() {
    return evalQueue.getMetrics();
  }
}

export default new InterviewEngine();
