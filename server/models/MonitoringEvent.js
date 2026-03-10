import mongoose from 'mongoose';

/**
 * MonitoringEvent Schema
 * 
 * Stores all client-sent tracking constraints (faces, tabs, inactivity, etc.)
 * Write Concern: { w: 1, j: false } — Optimized for high-frequency speed.
 * Minor dataloss during a node failure is acceptable.
 */
const MonitoringEventSchema = new mongoose.Schema(
  {
    sessionId: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: 'InterviewSession', 
      required: true,
      index: true
    },
    type: { 
      type: String, 
      required: true,
      // e.g., 'face_detected', 'face_lost', 'tab_switch', 'suspicious_action'
    },
    // Generic payload carrying details of the specific event type
    payload: { type: mongoose.Schema.Types.Mixed },
    clientTimestamp: { type: Number },
    serverTimestamp: { type: Date, default: Date.now }
  },
  { 
    timestamps: false,
    writeConcern: { w: 1, j: false } 
  }
);

export default mongoose.model('MonitoringEvent', MonitoringEventSchema);
