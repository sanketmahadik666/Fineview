/**
 * NlpModule — Phase 2
 *
 * Lightweight client-side NLP preprocessing for interview transcripts.
 * Uses compromise.js for part-of-speech tagging, tokenization, and
 * keyword extraction.
 *
 * Capabilities:
 *   - Filler word detection (um, uh, like, you know …)
 *   - Keyword / noun-phrase extraction
 *   - Sentence segmentation
 *   - Readability metrics (word count, avg word length, unique word ratio)
 *   - Confidence signal: low filler ratio + diverse vocabulary → higher score
 *
 * Processing: Edge (client-side, synchronous, zero server cost)
 * Thread: Main thread (compromise.js is synchronous, very fast < 5ms/call)
 */

import nlp from 'compromise';

const FILLER_WORDS = new Set([
  'um', 'uh', 'er', 'ah', 'like', 'basically', 'literally',
  'actually', 'you know', 'kind of', 'sort of', 'i mean',
  'right', 'okay', 'so', 'well',
]);

export default class NlpModule {
  constructor() {
    this._processedSegments = [];
    this._cumulativeStats = {
      totalWords: 0,
      fillerCount: 0,
      uniqueWords: new Set(),
      sentenceCount: 0,
      keyTerms: new Map(),
    };
  }

  /**
   * Process a new transcript segment.
   * Accumulates stats across the full session.
   *
   * @param {string} text  Final transcript segment
   * @returns {object}     Per-segment analysis
   */
  processSegment(text) {
    if (!text || typeof text !== 'string') return null;

    const doc = nlp(text);

    const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const sentences = doc.sentences().out('array');

    const fillers = this._countFillers(words);
    const nouns = doc.nouns().out('array');
    const verbs = doc.verbs().out('array');
    const topics = doc.topics().out('array');

    const segment = {
      text,
      wordCount: words.length,
      sentenceCount: sentences.length,
      fillerCount: fillers.count,
      fillerWords: fillers.found,
      nouns,
      verbs,
      topics,
      fillerRatio: words.length > 0 ? fillers.count / words.length : 0,
    };

    this._processedSegments.push(segment);
    this._updateCumulative(words, fillers, topics, sentences.length);

    return segment;
  }

  /**
   * Get session-level NLP summary.
   * Used by InterviewPage and (via final transcript) by the recruiter dashboard.
   */
  getSummary() {
    const stats = this._cumulativeStats;
    const totalWords = stats.totalWords;
    const fillerRatio = totalWords > 0 ? stats.fillerCount / totalWords : 0;
    const vocabularyRichness =
      totalWords > 0 ? stats.uniqueWords.size / totalWords : 0;

    const topKeyTerms = [...stats.keyTerms.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([term, count]) => ({ term, count }));

    const communicationScore = this._computeCommunicationScore(
      fillerRatio,
      vocabularyRichness,
      totalWords
    );

    return {
      totalWords,
      sentenceCount: stats.sentenceCount,
      fillerCount: stats.fillerCount,
      fillerRatio: parseFloat(fillerRatio.toFixed(3)),
      uniqueWords: stats.uniqueWords.size,
      vocabularyRichness: parseFloat(vocabularyRichness.toFixed(3)),
      topKeyTerms,
      communicationScore,
      segmentCount: this._processedSegments.length,
    };
  }

  /**
   * Extract keywords from arbitrary text (static utility).
   * @param {string} text
   * @returns {string[]}
   */
  static extractKeywords(text) {
    if (!text) return [];
    const doc = nlp(text);
    const nouns = doc.nouns().out('array');
    const topics = doc.topics().out('array');
    return [...new Set([...topics, ...nouns])].slice(0, 15);
  }

  /**
   * Sentence-tokenize arbitrary text (static utility).
   * @param {string} text
   * @returns {string[]}
   */
  static tokenizeSentences(text) {
    if (!text) return [];
    return nlp(text).sentences().out('array');
  }

  reset() {
    this._processedSegments = [];
    this._cumulativeStats = {
      totalWords: 0,
      fillerCount: 0,
      uniqueWords: new Set(),
      sentenceCount: 0,
      keyTerms: new Map(),
    };
  }

  // --- Internal ---

  _countFillers(words) {
    const found = [];
    let count = 0;

    for (const word of words) {
      const clean = word.replace(/[^a-z]/g, '');
      if (FILLER_WORDS.has(clean)) {
        found.push(clean);
        count++;
      }
    }

    for (const phrase of ['you know', 'kind of', 'sort of', 'i mean']) {
      const re = new RegExp(`\\b${phrase}\\b`, 'gi');
      const matches = words.join(' ').match(re);
      if (matches) count += matches.length;
    }

    return { count, found };
  }

  _updateCumulative(words, fillers, topics, sentenceCount) {
    const stats = this._cumulativeStats;
    stats.totalWords += words.length;
    stats.fillerCount += fillers.count;
    stats.sentenceCount += sentenceCount;

    for (const w of words) {
      stats.uniqueWords.add(w.replace(/[^a-z]/g, ''));
    }

    for (const topic of topics) {
      const key = topic.toLowerCase();
      stats.keyTerms.set(key, (stats.keyTerms.get(key) || 0) + 1);
    }
  }

  /**
   * Heuristic communication score (0–100) based on:
   *   - Low filler ratio  → good
   *   - High vocabulary richness → good
   *   - Sufficient word count → ensures it's meaningful
   */
  _computeCommunicationScore(fillerRatio, vocabRichness, totalWords) {
    if (totalWords < 10) return null;

    const fillerPenalty = Math.min(fillerRatio * 200, 40);
    const vocabBonus = Math.min(vocabRichness * 60, 40);
    const base = 60;

    return Math.max(0, Math.min(100, Math.round(base + vocabBonus - fillerPenalty)));
  }
}
