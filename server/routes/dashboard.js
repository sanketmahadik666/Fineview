import express from 'express';
import InterviewSession from '../models/InterviewSession.js';
import MonitoringEvent from '../models/MonitoringEvent.js';
import Transcript from '../models/Transcript.js';

const router = express.Router();

// Optional API key auth for recruiter dashboard
router.use((req, res, next) => {
  const expected = process.env.DASHBOARD_API_KEY;
  if (!expected) return next(); // No key configured → allow all (dev mode)

  const provided = req.header('x-api-key');
  if (!provided || provided !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
});

// Get all interview sessions
router.get('/sessions', async (req, res) => {
  try {
    const sessions = await InterviewSession.find()
      .sort({ createdAt: -1 })
      .lean();
    res.json(sessions);
  } catch (error) {
    console.error('[Dashboard API] Error fetching sessions:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get detailed session data
router.get('/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Run queries concurrently for fast dashboard loading
    const [session, events, transcripts] = await Promise.all([
      InterviewSession.findById(id).lean(),
      MonitoringEvent.find({ sessionId: id }).sort({ clientTimestamp: 1 }).lean(),
      Transcript.find({ sessionId: id }).sort({ timestamp: 1 }).lean(),
    ]);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.json({
      session,
      monitoringEvents: events,
      transcripts,
    });
  } catch (error) {
    console.error(`[Dashboard API] Error fetching session ${req.params.id}:`, error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

