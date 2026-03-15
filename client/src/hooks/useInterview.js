import { useState, useEffect, useRef, useCallback } from 'react';
import SpeechCapture from '../services/SpeechCapture';
import VoiceActivityDetection from '../services/VoiceActivityDetection';
import WebcamMonitor from '../services/WebcamMonitor';
import BrowserActivityTracker from '../services/BrowserActivityTracker';
import DeviceCapability from '../services/DeviceCapability';
import SocketService from '../services/SocketService';

/**
 * useInterview Hook
 * 
 * Orchestrates all client-side services for an interview session.
 * Manages the full lifecycle: device check → permissions → start → monitor → stop.
 */
export default function useInterview(serverUrl) {
  // State
  const [phase, setPhase] = useState('idle'); // idle | checking | ready | active | ended
  const [deviceInfo, setDeviceInfo] = useState(null);
  const [transcript, setTranscript] = useState('');
  const [interimText, setInterimText] = useState('');
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [energyLevel, setEnergyLevel] = useState(0);
  const [faceDetected, setFaceDetected] = useState(false);
  const [monitoringEvents, setMonitoringEvents] = useState([]);
  const [aiQuestion, setAiQuestion] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState(null);
  const [sessionStats, setSessionStats] = useState(null);
  const [speechSupported, setSpeechSupported] = useState(true);
  const [speechSupportReason, setSpeechSupportReason] = useState('');

  // Refs for service instances
  const speechRef = useRef(null);
  const vadRef = useRef(null);
  const webcamRef = useRef(null);
  const trackerRef = useRef(null);
  const socketRef = useRef(null);
  const deviceRef = useRef(null);
  const perfCheckRef = useRef(null);

  /**
   * Step 1: Check device capabilities.
   */
  const checkDevice = useCallback(async () => {
    setPhase('checking');
    setError(null);

    try {
      const device = new DeviceCapability();
      const results = await device.checkAll();
      deviceRef.current = device;
      setDeviceInfo(results);

      // Reflect speech support in hook state for UI
      if (!results.browser?.speechRecognition) {
        setSpeechSupported(false);
        setSpeechSupportReason(
          'Your browser does not support the Web Speech API required for voice responses.'
        );
      } else {
        setSpeechSupported(true);
        setSpeechSupportReason('');
      }

      if (results.overall === 'unsupported') {
        setError('Your device or browser does not meet the minimum requirements.');
        setPhase('idle');
        return false;
      }

      setPhase('ready');
      return true;
    } catch (err) {
      setError('Device check failed: ' + err.message);
      setPhase('idle');
      return false;
    }
  }, []);

  /**
   * Step 2: Start the interview session (initialize all services).
   */
  const startInterview = useCallback(async (videoEl, canvasEl) => {
    if (phase !== 'ready') return;
    setPhase('active');
    setError(null);

    try {
      const shouldDegrade = deviceRef.current?.shouldDegrade();

      // Guard: do not start if speech is not supported
      if (!speechSupported) {
        throw new Error(
          speechSupportReason ||
            'Speech recognition is not supported in this browser.'
        );
      }

      // --- WebSocket ---
      const socket = new SocketService(serverUrl);
      socketRef.current = socket;
      socket.onConnect = () => setIsConnected(true);
      socket.onDisconnect = () => setIsConnected(false);
      socket.on('ai_question', (payload) => {
        setAiQuestion(payload.question || '');
      });
      socket.connect();

      // Send start_interview message once socket is available
      socket.send('start_interview', {
        name: 'Candidate',
        role: 'General Interview',
        deviceInfo: deviceRef.current?.results || deviceInfo || {},
      });

      // --- Microphone stream ---
      const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // --- VAD (pass degraded flag for fftSize 256) ---
      const vad = new VoiceActivityDetection({
        threshold: shouldDegrade ? 0.025 : 0.015,
        silenceDelay: shouldDegrade ? 1200 : 800,
      });
      vadRef.current = vad;
      await vad.init(audioStream, shouldDegrade);
      vad.onSpeechStart = () => setIsSpeaking(true);
      vad.onSpeechEnd = () => setIsSpeaking(false);
      vad.onEnergyLevel = (energy) => setEnergyLevel(energy);
      vad.start();

      // --- Speech Capture ---
      const speech = new SpeechCapture();
      speechRef.current = speech;
      speech.onResult = (finalText, interim) => {
        setTranscript(finalText);
        setInterimText(interim);
        // Send final transcript segments to server
        if (finalText) {
          socket.sendTranscript(finalText, true);
        }
      };
      speech.start();

      // --- Webcam Monitor ---
      const webcam = new WebcamMonitor();
      webcamRef.current = webcam;
      if (shouldDegrade) {
        webcam.enableDegradedMode();
      }
      const camReady = await webcam.init(videoEl, canvasEl);
      if (camReady) {
        webcam.onFaceDetected = (count) => setFaceDetected(true);
        webcam.onFaceLost = () => setFaceDetected(false);
        webcam.onMultipleFaces = (count) => {
          const evt = { type: 'multiple_faces', count, timestamp: Date.now() };
          setMonitoringEvents((prev) => [...prev, evt]);
          socket.sendMonitoringEvent(evt);
        };
        webcam.onMonitoringEvent = (evt) => {
          socket.sendMonitoringEvent(evt);
        };
        webcam.start();
      }

      // --- Browser Activity Tracker ---
      const tracker = new BrowserActivityTracker({
        inactivityThreshold: shouldDegrade ? 45000 : 30000,
        maxEvents: shouldDegrade ? 300 : 500,
      });
      trackerRef.current = tracker;
      tracker.onEvent = (evt) => {
        // Cap React state events to last 50 (UI only needs recent)
        setMonitoringEvents((prev) => [...prev.slice(-49), evt]);
        socket.sendMonitoringEvent(evt); // Goes through batch buffer
      };
      tracker.start();

      // --- Mid-session performance check (every 30s) ---
      perfCheckRef.current = setInterval(() => {
        const webcamStats = webcamRef.current?.getStats();
        const vadStats = vadRef.current?.getStats();
        const trackerSummary = trackerRef.current?.getSummary();
        setSessionStats({ webcam: webcamStats, vad: vadStats, tracker: trackerSummary });
      }, 30000);

    } catch (err) {
      setError('Failed to start interview: ' + err.message);
      setPhase('ready');
    }
  }, [phase, serverUrl, speechSupported, speechSupportReason]);

  /**
   * Step 3: End the interview session (cleanup all services).
   */
  const endInterview = useCallback(() => {
    // Notify server that the client ended the interview (if socket still alive)
    if (socketRef.current) {
      socketRef.current.send('end_interview', {
        reason: 'candidate_ended',
      });
    }
    if (perfCheckRef.current) {
      clearInterval(perfCheckRef.current);
      perfCheckRef.current = null;
    }
    speechRef.current?.stop();
    vadRef.current?.destroy();
    webcamRef.current?.destroy();
    trackerRef.current?.stop();
    socketRef.current?.disconnect();

    // Capture final stats
    setSessionStats({
      vad: vadRef.current?.getStats?.(),
      tracker: trackerRef.current?.getSummary?.(),
    });

    setPhase('ended');
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (perfCheckRef.current) clearInterval(perfCheckRef.current);
      speechRef.current?.stop();
      vadRef.current?.destroy();
      webcamRef.current?.destroy();
      trackerRef.current?.stop();
      socketRef.current?.disconnect();
    };
  }, []);

  return {
    // State
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
    sessionStats,
    speechSupported,
    speechSupportReason,

    // Actions
    checkDevice,
    startInterview,
    endInterview,
  };
}
