import WebSocket from 'ws';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const ws = new WebSocket('ws://localhost:3001');

ws.on('open', () => {
  console.log('[E2E Test] Connected to server!');
  
  // 1. Start Interview
  ws.send(JSON.stringify({
    type: 'start_interview',
    payload: { name: 'Test User', role: 'Software Engineer', deviceInfo: { tier: 'high' } }
  }));

  // 2. Simulate transcript after 1s
  setTimeout(() => {
    ws.send(JSON.stringify({
      type: 'transcript',
      payload: { text: 'Hello, this is a test transcript.', isFinal: true },
      timestamp: Date.now()
    }));
  }, 1000);

  // 3. Simulate monitoring batch after 2s
  setTimeout(() => {
    ws.send(JSON.stringify({
      type: 'monitoring_batch',
      payload: {
        count: 2,
        events: [
          { type: 'face_detected', timestamp: Date.now() },
          { type: 'tab_switch', direction: 'away', timestamp: Date.now() }
        ]
      }
    }));
  }, 2000);

  // Close connection after 3s and query DB to verify
  setTimeout(async () => {
    console.log('[E2E Test] WebSocket flow complete. Checking Database...');
    ws.close();
    
    try {
      await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/fineview');
      
      const session = await mongoose.connection.db.collection('interviewsessions').findOne({ candidateName: 'Test User' });
      const transcripts = await mongoose.connection.db.collection('transcripts').find({ sessionId: session._id }).toArray();
      const events = await mongoose.connection.db.collection('monitoringevents').find({ sessionId: session._id }).toArray();
      
      console.log(`[DB Verify] Session found: ${!!session}`);
      console.log(`[DB Verify] Transcripts found: ${transcripts.length}`);
      console.log(`[DB Verify] Monitoring events found: ${events.length}`);
      
      if (session && transcripts.length > 0 && events.length > 0) {
        console.log('[E2E Test] SUCCESS: All data recorded correctly.');
      } else {
        console.error('[E2E Test] FAILED: Data missing.');
      }
      
      process.exit(0);
    } catch (err) {
      console.error('[E2E Test] DB Error:', err);
      process.exit(1);
    }
  }, 4000);
});

ws.on('message', (data) => {
  console.log('[E2E Test] Received from server:', data.toString());
});

ws.on('error', (err) => console.error('WS Error:', err));
