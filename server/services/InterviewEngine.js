import InterviewSession from '../models/InterviewSession.js';
import Transcript from '../models/Transcript.js';
import llmService from './LLMService.js';

/**
 * AI Interview Engine
 *
 * Uses an LLM (when configured) to:
 *   - Generate context-aware interview questions
 *   - Produce structured evaluation scores at the end of the session
 *
 * Falls back to a static script and simulated scores if the LLM is not configured
 * or fails, so the system still works in offline/demo environments.
 */
class InterviewEngine {
  constructor() {
    this.defaultQuestions = [
      "Hello! Please introduce yourself and walk us through your background.",
      "Can you describe a challenging project you've worked on and how you overcame the obstacles?",
      "How do you handle disagreements with team members or stakeholders?",
      "What are your long-term career goals and how does this role fit into them?",
      "Thank you for your time. Do you have any questions for us?"
    ];
    
    // Track conversation state per session
    // In production, this lives in Redis to be cluster-safe
    this.sessionState = new Map();
  }

  async startSession(sessionId, ws) {
    const key = sessionId.toString();

    // Load role context once per session
    const session = await InterviewSession.findById(sessionId).lean().catch(() => null);
    const jobRole = session?.jobRole || 'Unspecified';

    this.sessionState.set(key, {
      questionIndex: 0,
      turnCount: 0,
      jobRole,
    });

    // Generate first question via LLM, with fallback to defaults
    let questionText = null;
    if (llmService.isConfigured) {
      try {
        questionText = await llmService.generateQuestion({
          jobRole,
          questionIndex: 0,
        });
      } catch (err) {
        console.warn('[InterviewEngine] LLM generateQuestion failed, using default script:', err.message);
      }
    }

    if (!questionText) {
      questionText = this.defaultQuestions[0];
    }

    this._sendQuestion(ws, questionText);
  }

  async handleCandidateResponse(sessionId, ws, transcriptText, isFinal) {
    if (!isFinal) return; // Only act on complete thoughts

    const key = sessionId.toString();
    const state = this.sessionState.get(key);
    if (!state) return;

    state.turnCount++;

    // Arbitrary simple logic: wait for 2 final transcript chunks per question
    if (state.turnCount >= 2) {
      state.questionIndex++;
      state.turnCount = 0;

      if (state.questionIndex < this.defaultQuestions.length) {
        // Send next question (LLM-backed when available) with a slight delay to simulate "thinking"
        setTimeout(async () => {
          const idx = state.questionIndex;
          const fallback = this.defaultQuestions[idx] || this.defaultQuestions[this.defaultQuestions.length - 1];

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
              console.warn('[InterviewEngine] LLM generateQuestion failed, using default script:', err.message);
            }
          }

          this._sendQuestion(ws, nextQuestion || fallback);
        }, 1500);
      } else {
        // End of questions -> evaluate
        this.triggerEvaluation(sessionId, ws);
      }
    }
  }

  _sendQuestion(ws, questionText) {
    ws.send(JSON.stringify({
      type: 'ai_question',
      payload: { question: questionText }
    }));
  }

  async triggerEvaluation(sessionId, ws) {
    const key = sessionId.toString();
    // If we've already cleaned up this session, avoid double evaluation
    if (!this.sessionState.has(key)) {
      console.log(`[InterviewEngine] triggerEvaluation called for unknown session: ${sessionId}`);
      return;
    }
    console.log(`[InterviewEngine] Triggering final evaluation for session: ${sessionId}`);
    
    ws.send(JSON.stringify({
      type: 'ai_question',
      payload: { question: 'Evaluating your interview...' }
    }));

    let scores = null;
    let feedback = '';

    const session = await InterviewSession.findById(sessionId).lean().catch(() => null);
    const jobRole = session?.jobRole || 'Unspecified';
    const candidateName = session?.candidateName || 'Candidate';

    // Gather all final transcript segments for holistic evaluation
    const finalSegments = await Transcript.find({ sessionId, isFinal: true })
      .sort({ timestamp: 1 })
      .lean()
      .catch(() => []);

    const transcriptText = finalSegments.map((seg) => seg.text).join('\n');

    const evalStart = Date.now();
    if (llmService.isConfigured) {
      try {
        const result = await llmService.evaluateInterview({
          jobRole,
          candidateName,
          transcript: transcriptText,
        });
        scores = result.scores || null;
        feedback = result.feedback || '';
        console.log(
          `[InterviewEngine] LLM evaluation completed in ${Date.now() - evalStart}ms for session ${sessionId}`
        );
      } catch (err) {
        console.error('[InterviewEngine] LLM evaluation failed, falling back to simulated scores:', err.message);
      }
    }

    // Fallback to simulated scores if LLM is not configured or failed
    if (!scores) {
      const simulated = {
        conceptualUnderstanding: Math.floor(Math.random() * 20) + 80,
        problemSolving: Math.floor(Math.random() * 20) + 75,
        communication: Math.floor(Math.random() * 20) + 85,
        responseCompleteness: Math.floor(Math.random() * 20) + 80,
      };
      simulated.overallScore = Math.floor(
        (simulated.conceptualUnderstanding +
          simulated.problemSolving +
          simulated.communication +
          simulated.responseCompleteness) /
          4
      );
      scores = simulated;
      feedback =
        'Simulated evaluation: strong communication and overall understanding; real AI evaluation not configured.';
    }

    // Update DB with high durability Write Concern (w: "majority")
    await InterviewSession.findByIdAndUpdate(
      sessionId,
      {
        status: 'completed',
        endTime: new Date(),
        evaluationScores: scores,
        aiFeedback: feedback,
      },
      { writeConcern: { w: 'majority', wtimeout: 5000 } }
    );

    // Notify client with structured scores
    ws.send(
      JSON.stringify({
        type: 'interview_completed',
        payload: {
          message: 'Interview concluded and evaluated successfully.',
          scores,
        },
      })
    );

    // Clean up local tracking state
    this.sessionState.delete(key);
  }
}

export default new InterviewEngine();
