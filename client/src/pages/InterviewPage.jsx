import { useState, useRef } from 'react';
import useInterview from '../hooks/useInterview';
import './InterviewPage.css';

/**
 * InterviewPage Component
 * 
 * Main interview interface tying together all client-side services.
 * Follows the PRD workflow:
 *   Candidate joins → Device check → Permissions → Interview begins
 */
export default function InterviewPage() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:3001';

  const {
    phase,
    deviceInfo,
    transcript,
    interimText,
    isSpeaking,
    energyLevel,
    faceDetected,
    monitoringEvents,
    aiQuestion,
    isConnected,
    error,
    speechSupported,
    speechSupportReason,
    checkDevice,
    startInterview,
    endInterview,
  } = useInterview(WS_URL);

  const handleStart = async () => {
    if (phase === 'idle') {
      await checkDevice();
    }
  };

  const handleBeginInterview = async () => {
    if (phase === 'ready' && videoRef.current && canvasRef.current) {
      await startInterview(videoRef.current, canvasRef.current);
    }
  };

  return (
    <div className="interview-page">
      {/* Hidden canvas for frame analysis */}
      <canvas
        ref={canvasRef}
        width={320}
        height={240}
        style={{ display: 'none' }}
      />

      {/* Header */}
      <header className="interview-header">
        <div className="header-left">
          <h1 className="logo">Fineview</h1>
          <span className="subtitle">AI Interview Platform</span>
        </div>
        <div className="header-right">
          <span className={`connection-badge ${isConnected ? 'connected' : 'disconnected'}`}>
            {isConnected ? '● Connected' : '○ Disconnected'}
          </span>
        </div>
      </header>

      {/* Main Content */}
      <main className="interview-main">

        {/* IDLE Phase */}
        {phase === 'idle' && (
          <div className="phase-card phase-idle">
            <div className="phase-icon">🎯</div>
            <h2>Welcome to Your Interview</h2>
            <p>We'll verify your device capabilities and then begin.</p>
            {error && <div className="error-banner">{error}</div>}
            <button className="btn-primary" onClick={handleStart}>
              Start Device Check
            </button>
          </div>
        )}

        {/* CHECKING Phase */}
        {phase === 'checking' && (
          <div className="phase-card phase-checking">
            <div className="spinner" />
            <h2>Checking Your Device...</h2>
            <p>Verifying browser, camera, and microphone capabilities.</p>
          </div>
        )}

        {/* READY Phase */}
        {phase === 'ready' && deviceInfo && (
          <div className="phase-card phase-ready">
            <div className="phase-icon">✅</div>
            <h2>Device Verified</h2>

            <div className="device-summary">
              <div className="device-row">
                <span>Performance Tier</span>
                <span className={`tier-badge tier-${deviceInfo.performance.tier}`}>
                  {deviceInfo.performance.tier.toUpperCase()}
                </span>
              </div>
              <div className="device-row">
                <span>Camera</span>
                <span>{deviceInfo.permissions.camera ? '✅' : '❌'}</span>
              </div>
              <div className="device-row">
                <span>Microphone</span>
                <span>{deviceInfo.permissions.microphone ? '✅' : '❌'}</span>
              </div>
              <div className="device-row">
                <span>WebRTC</span>
                <span>{deviceInfo.browser.webRTC ? '✅' : '❌'}</span>
              </div>
              <div className="device-row">
                <span>Speech API</span>
                <span>{deviceInfo.browser.speechRecognition ? '✅' : '❌'}</span>
              </div>
            </div>

            {deviceInfo.overall === 'low' && (
              <div className="warning-banner">
                ⚠️ Your device has limited performance. Monitoring will run in degraded mode.
              </div>
            )}

            {!speechSupported && (
              <div className="error-banner">
                {speechSupportReason ||
                  'Your browser does not support the required speech recognition features. Please try a modern Chromium-based browser.'}
              </div>
            )}

            <button
              className="btn-primary"
              onClick={!speechSupported ? undefined : handleBeginInterview}
              disabled={!speechSupported}
            >
              Begin Interview
            </button>
          </div>
        )}

        {/* ACTIVE Phase */}
        {phase === 'active' && (
          <div className="phase-active-layout">
            {/* Left: Video + Monitoring */}
            <div className="panel-left">
              <div className="video-container">
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className="webcam-video"
                />
                <div className="video-overlay">
                  <span className={`face-indicator ${faceDetected ? 'detected' : 'lost'}`}>
                    {faceDetected ? '👤 Face Detected' : '⚠ No Face'}
                  </span>
                </div>
              </div>

              {/* Voice Activity Meter */}
              <div className="vad-meter">
                <div className="vad-label">
                  {isSpeaking ? '🎙️ Speaking' : '🔇 Silent'}
                </div>
                <div className="vad-bar-track">
                  <div
                    className="vad-bar-fill"
                    style={{ width: `${Math.min(energyLevel * 3000, 100)}%` }}
                  />
                </div>
              </div>

              {/* Monitoring Events */}
              <div className="monitoring-panel">
                <h4>Activity Log</h4>
                <div className="event-list">
                  {monitoringEvents.slice(-5).map((evt, i) => (
                    <div key={i} className={`event-item event-${evt.type}`}>
                      <span className="event-time">
                        {new Date(evt.timestamp).toLocaleTimeString()}
                      </span>
                      <span className="event-type">{evt.type}</span>
                    </div>
                  ))}
                  {monitoringEvents.length === 0 && (
                    <div className="event-item event-empty">No events yet</div>
                  )}
                </div>
              </div>
            </div>

            {/* Right: AI Question + Transcript */}
            <div className="panel-right">
              <div className="ai-question-card">
                <h3>Interview Question</h3>
                <p className="question-text">
                  {aiQuestion || 'Waiting for the AI interviewer to ask a question...'}
                </p>
              </div>

              <div className="transcript-card">
                <h3>Your Response</h3>
                <div className="transcript-content">
                  {transcript && <p className="final-text">{transcript}</p>}
                  {interimText && <p className="interim-text">{interimText}</p>}
                  {!transcript && !interimText && (
                    <p className="placeholder-text">Start speaking to respond...</p>
                  )}
                </div>
              </div>

              <button className="btn-danger" onClick={endInterview}>
                End Interview
              </button>
            </div>
          </div>
        )}

        {/* ENDED Phase */}
        {phase === 'ended' && (
          <div className="phase-card phase-ended">
            <div className="phase-icon">🏁</div>
            <h2>Interview Complete</h2>
            <p>Thank you for participating. Your responses have been recorded.</p>
            <div className="session-summary">
              <p><strong>Events Logged:</strong> {monitoringEvents.length}</p>
              <p><strong>Transcript Length:</strong> {transcript.length} characters</p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
