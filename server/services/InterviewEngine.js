import InterviewSession from '../models/InterviewSession.js';
import Transcript from '../models/Transcript.js';

/**
 * Simulated AI Interview Engine
 * 
 * In Phase 4, this will be replaced with actual LLM calls (OpenAI/Anthropic).
 * For now, this service provides the orchestration back to the WebSocket client
 * to simulate the conversational flow.
 */
class InterviewEngine {
  constructor() {
    this.questions = [
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

  startSession(sessionId, ws) {
    this.sessionState.set(sessionId.toString(), {
      questionIndex: 0,
      turnCount: 0
    });
    
    // Send first question
    this._sendQuestion(ws, this.questions[0]);
  }

  async handleCandidateResponse(sessionId, ws, transcriptText, isFinal) {
    if (!isFinal) return; // Only act on complete thoughts

    const state = this.sessionState.get(sessionId.toString());
    if (!state) return;

    state.turnCount++;

    // Arbitrary simulated logic: wait for 3 final transcript chunks per question
    if (state.turnCount >= 2) {
      state.questionIndex++;
      state.turnCount = 0;

      if (state.questionIndex < this.questions.length) {
        // Send next question with a slight delay to simulate "thinking"
        setTimeout(() => {
          this._sendQuestion(ws, this.questions[state.questionIndex]);
        }, 1500);
      } else {
        // End of questions -> evaluate
        this._triggerEvaluation(sessionId, ws);
      }
    }
  }

  _sendQuestion(ws, questionText) {
    ws.send(JSON.stringify({
      type: 'ai_question',
      payload: { question: questionText }
    }));
  }

  async _triggerEvaluation(sessionId, ws) {
    console.log(`[InterviewEngine] Triggering final evaluation for session: ${sessionId}`);
    
    ws.send(JSON.stringify({
      type: 'ai_question',
      payload: { question: 'Evaluating your interview...' }
    }));

    // Simulated evaluation logic (mock scores)
    const simulatedScores = {
      conceptualUnderstanding: Math.floor(Math.random() * 20) + 80,
      problemSolving: Math.floor(Math.random() * 20) + 75,
      communication: Math.floor(Math.random() * 20) + 85,
    };
    simulatedScores.overallScore = Math.floor(
      (simulatedScores.conceptualUnderstanding + simulatedScores.problemSolving + simulatedScores.communication) / 3
    );

    // Update DB with high durability Write Concern (w: "majority")
    await InterviewSession.findByIdAndUpdate(
      sessionId,
      {
        status: 'completed',
        endTime: new Date(),
        evaluationScores: simulatedScores,
        aiFeedback: "This is a simulated feedback response. Candidate showed strong communication skills but could improve technical depth in problem-solving scenarios."
      },
      { writeConcern: { w: 'majority', wtimeout: 5000 } }
    );

    // Notify client
    ws.send(JSON.stringify({
      type: 'interview_completed',
      payload: { message: 'Interview concluded and evaluated successfully.' }
    }));

    // Clean up local tracking state
    this.sessionState.delete(sessionId.toString());
  }
}

export default new InterviewEngine();
