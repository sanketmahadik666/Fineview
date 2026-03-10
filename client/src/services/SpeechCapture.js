/**
 * SpeechCapture Service
 *
 * Handles continuous speech capture and Speech-to-Text (STT) using
 * the Web Speech API (SpeechRecognition). Provides real-time transcription
 * with interim and final results.
 *
 * Processing Flow (PRD 3.1.2):
 *   Speech Input → VAD → Speech Segmentation → STT → Structured Text
 */

class SpeechCapture {
  constructor() {
    this.recognition = null;
    this.isListening = false;
    this.transcript = "";
    this.interimTranscript = "";
    this.onResult = null; // callback: (finalText, interimText) => {}
    this.onError = null; // callback: (error) => {}
    this.onStatusChange = null; // callback: (isListening) => {}
    this._supported = false;

    this._init();
  }

  _init() {
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      console.warn(
        "[SpeechCapture] Web Speech API not supported in this browser.",
      );
      this._supported = false;
      return;
    }

    this._supported = true;
    this.recognition = new SpeechRecognition();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = "en-US";

    this.recognition.onresult = (event) => {
      let interim = "";
      let finalText = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalText += result[0].transcript;
        } else {
          interim += result[0].transcript;
        }
      }

      if (finalText) {
        this.transcript += finalText + " ";
      }
      this.interimTranscript = interim;

      if (this.onResult) {
        this.onResult(this.transcript.trim(), this.interimTranscript);
      }
    };

    this.recognition.onerror = (event) => {
      console.error("[SpeechCapture] Error:", event.error);
      if (this.onError) {
        this.onError(event.error);
      }
      // Auto-restart on non-fatal errors
      if (event.error === "no-speech" || event.error === "aborted") {
        this._restartIfListening();
      }
    };

    this.recognition.onend = () => {
      // Auto-restart for continuous listening
      this._restartIfListening();
    };
  }

  get isSupported() {
    return this._supported;
  }

  start() {
    if (!this._supported || this.isListening) return;
    try {
      this.recognition.start();
      this.isListening = true;
      if (this.onStatusChange) this.onStatusChange(true);
    } catch (err) {
      console.error("[SpeechCapture] Failed to start:", err);
    }
  }

  stop() {
    if (!this._supported || !this.isListening) return;
    this.isListening = false;
    this.recognition.stop();
    if (this.onStatusChange) this.onStatusChange(false);
  }

  reset() {
    this.stop();
    this.transcript = "";
    this.interimTranscript = "";
  }

  getFullTranscript() {
    return this.transcript.trim();
  }

  _restartIfListening() {
    if (this.isListening && this._supported) {
      try {
        this.recognition.start();
      } catch (err) {
        // Already running, ignore
      }
    }
  }
}

export default SpeechCapture;
