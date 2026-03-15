import express from 'express';
import InterviewSession from '../models/InterviewSession.js';
import MonitoringEvent from '../models/MonitoringEvent.js';
import Transcript from '../models/Transcript.js';
import { scoreBehaviour, getBehaviourFlags } from '../services/BehaviourScorer.js';
import interviewEngine from '../services/InterviewEngine.js';

const router = express.Router();

// Optional API key auth for recruiter dashboard
router.use((req, res, next) => {
  const expected = process.env.DASHBOARD_API_KEY;
  if (!expected) return next();

  const provided = req.header('x-api-key');
  if (!provided || provided !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
});

/**
 * GET /api/dashboard/sessions
 * List all sessions, sorted by creation date desc.
 * Includes pre-computed behaviour score from the MonitoringEvent collection.
 */
router.get('/sessions', async (req, res) => {
  try {
    const sessions = await InterviewSession.find().sort({ createdAt: -1 }).lean();
    res.json(sessions);
  } catch (error) {
    console.error('[Dashboard API] Error fetching sessions:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/dashboard/sessions/:id
 * Full session detail including transcript, events, and behaviour score.
 */
router.get('/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const [session, events, transcripts] = await Promise.all([
      InterviewSession.findById(id).lean(),
      MonitoringEvent.find({ sessionId: id }).sort({ clientTimestamp: 1 }).lean(),
      Transcript.find({ sessionId: id }).sort({ timestamp: 1 }).lean(),
    ]);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const behaviour = scoreBehaviour(events, session);
    const behaviourFlags = getBehaviourFlags(behaviour);

    res.json({ session, monitoringEvents: events, transcripts, behaviour, behaviourFlags });
  } catch (error) {
    console.error(`[Dashboard API] Error fetching session ${req.params.id}:`, error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/dashboard/analytics
 * Aggregate summary stats across all sessions.
 * Used by the recruiter dashboard summary cards.
 */
router.get('/analytics', async (req, res) => {
  try {
    const sessions = await InterviewSession.find().lean();
    const total = sessions.length;
    const completed = sessions.filter((s) => s.status === 'completed').length;
    const aborted = sessions.filter((s) => s.status === 'aborted').length;
    const inProgress = sessions.filter((s) => s.status === 'in-progress').length;

    const scoredSessions = sessions.filter((s) => s.evaluationScores?.overallScore != null);
    const avgOverall = scoredSessions.length > 0
      ? scoredSessions.reduce((sum, s) => sum + s.evaluationScores.overallScore, 0) / scoredSessions.length
      : null;

    const avgByMetric = scoredSessions.length > 0
      ? {
          conceptualUnderstanding: _avg(scoredSessions, 'conceptualUnderstanding'),
          problemSolving: _avg(scoredSessions, 'problemSolving'),
          communication: _avg(scoredSessions, 'communication'),
          responseCompleteness: _avg(scoredSessions, 'responseCompleteness'),
        }
      : null;

    const roleBreakdown = {};
    for (const s of sessions) {
      const role = s.jobRole || 'Unspecified';
      if (!roleBreakdown[role]) roleBreakdown[role] = { count: 0, avgScore: null, scores: [] };
      roleBreakdown[role].count++;
      if (s.evaluationScores?.overallScore != null) {
        roleBreakdown[role].scores.push(s.evaluationScores.overallScore);
      }
    }
    for (const role of Object.keys(roleBreakdown)) {
      const scores = roleBreakdown[role].scores;
      roleBreakdown[role].avgScore = scores.length > 0
        ? parseFloat((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1))
        : null;
      delete roleBreakdown[role].scores;
    }

    res.json({
      total,
      completed,
      aborted,
      inProgress,
      avgOverall: avgOverall != null ? parseFloat(avgOverall.toFixed(1)) : null,
      avgByMetric,
      roleBreakdown,
      evalQueueMetrics: interviewEngine.getQueueMetrics(),
    });
  } catch (error) {
    console.error('[Dashboard API] Error fetching analytics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/dashboard/sessions/:id/behaviour
 * On-demand behaviour score for a specific session.
 */
router.get('/sessions/:id/behaviour', async (req, res) => {
  try {
    const { id } = req.params;
    const [session, events] = await Promise.all([
      InterviewSession.findById(id).lean(),
      MonitoringEvent.find({ sessionId: id }).lean(),
    ]);

    if (!session) return res.status(404).json({ error: 'Session not found' });

    const behaviour = scoreBehaviour(events, session);
    const flags = getBehaviourFlags(behaviour);

    res.json({ sessionId: id, behaviour, flags });
  } catch (error) {
    console.error(`[Dashboard API] Error computing behaviour for ${req.params.id}:`, error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function _avg(sessions, metric) {
  const vals = sessions
    .map((s) => s.evaluationScores?.[metric])
    .filter((v) => v != null);
  return vals.length > 0 ? parseFloat((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1)) : null;
}

export default router;
