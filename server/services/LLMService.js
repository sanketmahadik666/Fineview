import dotenv from 'dotenv';

dotenv.config();

/**
 * LLMService
 *
 * Thin wrapper around an LLM HTTP API used for:
 *  - Dynamic interview question generation
 *  - Structured JSON evaluation of candidate responses
 *
 * This implementation assumes an OpenAI-style chat-completions endpoint:
 *   POST ${LLM_API_URL}
 *   Authorization: Bearer ${LLM_API_KEY}
 *   { model, messages: [...], temperature, max_tokens }
 *
 * You can point LLM_API_URL at any provider that supports the same shape.
 */
class LLMService {
  constructor() {
    this.apiKey = process.env.LLM_API_KEY || '';
    this.apiUrl = process.env.LLM_API_URL || '';
    this.model = process.env.LLM_MODEL || 'gpt-4.1-mini';
  }

  get isConfigured() {
    return Boolean(this.apiKey && this.apiUrl);
  }

  async _postJson(body) {
    if (!this.isConfigured) {
      throw new Error('LLMService is not configured (missing LLM_API_URL or LLM_API_KEY).');
    }

    const res = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM HTTP ${res.status}: ${text}`);
    }

    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content;
    if (!content || typeof content !== 'string') {
      throw new Error('LLM response missing message content');
    }
    return content.trim();
  }

  /**
   * Generate the next interview question.
   * Returns null if LLM is not configured (caller should fall back to defaults).
   */
  async generateQuestion({ jobRole, questionIndex, previousQuestion, lastAnswer }) {
    if (!this.isConfigured) return null;

    const role = jobRole || 'General Software Engineer';
    const idx = typeof questionIndex === 'number' ? questionIndex : 0;

    const systemPrompt =
      'You are an AI interviewer conducting structured, behavioral and technical interviews. ' +
      'Ask clear, concise questions one at a time. Avoid preambles and meta commentary.';

    const userPrompt = [
      `Role: ${role}`,
      `Question index (0-based): ${idx}`,
      previousQuestion ? `Previous question: "${previousQuestion}"` : 'This is the first question.',
      lastAnswer ? `Last answer from candidate: "${lastAnswer}"` : 'No previous answer yet.',
      '',
      'Respond with ONLY the next interview question as plain text. Do not include numbering or extra explanation.',
    ].join('\n');

    return this._postJson({
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: 256,
    });
  }

  /**
   * Evaluate the full interview and return structured scores + feedback.
   *
   * Returns:
   * {
   *   scores: {
   *     conceptualUnderstanding,
   *     problemSolving,
   *     communication,
   *     responseCompleteness,
   *     overallScore
   *   },
   *   feedback: string
   * }
   */
  async evaluateInterview({ jobRole, candidateName, transcript }) {
    if (!this.isConfigured) {
      throw new Error('LLMService is not configured');
    }

    const role = jobRole || 'General Software Engineer';
    const name = candidateName || 'Candidate';

    const systemPrompt =
      'You are an expert technical interviewer. ' +
      'You must output a strict JSON object with numeric scores (0-100) and a short feedback string. ' +
      'Do not include any text outside the JSON.';

    const userPrompt = [
      `Role: ${role}`,
      `Candidate: ${name}`,
      '',
      'Full transcript of candidate responses (chronological):',
      transcript || '(no transcript)',
      '',
      'Evaluate the candidate using these metrics (0-100):',
      '- conceptualUnderstanding',
      '- problemSolving',
      '- communication',
      '- responseCompleteness',
      '- overallScore (not a simple average; your holistic judgment)',
      '',
      'Return ONLY valid JSON in this shape:',
      '{',
      '  "scores": {',
      '    "conceptualUnderstanding": 0,',
      '    "problemSolving": 0,',
      '    "communication": 0,',
      '    "responseCompleteness": 0,',
      '    "overallScore": 0',
      '  },',
      '  "feedback": "Short paragraph of feedback"',
      '}',
    ].join('\n');

    const raw = await this._postJson({
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
      max_tokens: 512,
    });

    // Attempt to parse JSON; if the model wrapped it in text, extract the first {...} block.
    let jsonText = raw;
    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      jsonText = raw.slice(firstBrace, lastBrace + 1);
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      throw new Error(`Failed to parse LLM JSON: ${err.message}`);
    }

    return {
      scores: parsed.scores || {},
      feedback: parsed.feedback || '',
    };
  }
}

export default new LLMService();

