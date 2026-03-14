import mongoose from 'mongoose';

/**
 * InterviewSession Schema
 * 
 * Tracks the overall interview session.
 * Durability First: Uses write concern { w: "majority", j: true }
 * to ensure that critical final evaluations and metadata are never lost
 * due to a primary node crash.
 */
const InterviewSessionSchema = new mongoose.Schema(
  {
    candidateName: { type: String, required: true },
    jobRole: { type: String, required: true },
    status: { 
      type: String, 
      enum: ['pending', 'in-progress', 'completed', 'aborted'], 
      default: 'pending' 
    },
    startTime: { type: Date },
    endTime: { type: Date },

    // Device and monitoring context
    deviceInfo: { type: mongoose.Schema.Types.Mixed }, // e.g., low-end flag
    
    // Final evaluation scores from AI
    evaluationScores: {
      conceptualUnderstanding: { type: Number, min: 0, max: 100 },
      problemSolving: { type: Number, min: 0, max: 100 },
      communication: { type: Number, min: 0, max: 100 },
      responseCompleteness: { type: Number, min: 0, max: 100 },
      overallScore: { type: Number, min: 0, max: 100 },
    },
    aiFeedback: { type: String }
  },
  { 
    timestamps: true,
    writeConcern: { w: 'majority', j: true, wtimeout: 5000 } 
  }
);

export default mongoose.model('InterviewSession', InterviewSessionSchema);
