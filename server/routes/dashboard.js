import express from 'express';
import InterviewSession from '../models/InterviewSession.js';
import MonitoringEvent from '../models/MonitoringEvent.js';
import Transcript from '../models/Transcript.js';

const router = express.Router();

// Get all interview sessions
router.get('/sessions', async (req, res) => {
  try {
    const sessions = await InterviewSession.find().sort({ createdAt: -1 });
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
      InterviewSession.findById(id),
      MonitoringEvent.find({ sessionId: id }).sort({ clientTimestamp: 1 }),
      Transcript.find({ sessionId: id }).sort({ timestamp: 1 })
    ]);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.json({
      session,
      monitoringEvents: events,
      transcripts
    });
  } catch (error) {
    console.error(`[Dashboard API] Error fetching session ${req.params.id}:`, error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
