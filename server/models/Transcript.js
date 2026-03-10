import mongoose from 'mongoose';

/**
 * Transcript Schema
 * 
 * Stores candidate audio transcript segments matched to a specific session.
 * Write Concern: { w: 1, j: true } — We need fast writes but some durability
 * is preferred for text content.
 */
const TranscriptSchema = new mongoose.Schema(
  {
    sessionId: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: 'InterviewSession', 
      required: true,
      index: true
    },
    text: { type: String, required: true },
    isFinal: { type: Boolean, default: false },
    timestamp: { type: Date, default: Date.now },
  },
  { 
    // Do not manage updated_at to save DB operations
    timestamps: { createdAt: true, updatedAt: false },
    writeConcern: { w: 1, j: true } 
  }
);

export default mongoose.model('Transcript', TranscriptSchema);
