/**
 * Voice Activity Detection (VAD) AudioWorkletProcessor
 * 
 * Runs entirely on the audio thread, independent of the main UI thread.
 * Calculates RMS (Root Mean Square) energy of the audio buffer and determines
 * if speech is active based on a threshold.
 */
class VADProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    // Default config, can be overridden by main thread
    this.threshold = options.processorOptions?.threshold || 0.05;
    this.smoothingFactor = options.processorOptions?.smoothingFactor || 0.8;
    this.silenceDelay = options.processorOptions?.silenceDelay || 500;
    
    this.isSpeaking = false;
    this.smoothedEnergy = 0;
    this.lastSpeechTime = 0;

    // Listen for config updates from the main thread
    this.port.onmessage = (event) => {
      if (event.data.type === 'config') {
        if (event.data.threshold) this.threshold = event.data.threshold;
        if (event.data.smoothingFactor) this.smoothingFactor = event.data.smoothingFactor;
        if (event.data.silenceDelay) this.silenceDelay = event.data.silenceDelay;
      }
    };
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || !input[0]) return true; // Keep processor alive

    const channelData = input[0];
    let sumSquares = 0;

    for (let i = 0; i < channelData.length; i++) {
      sumSquares += channelData[i] * channelData[i];
    }

    const rms = Math.sqrt(sumSquares / channelData.length);
    
    // Apply exponential moving average (EMA) smoothing
    this.smoothedEnergy = (this.smoothingFactor * this.smoothedEnergy) + ((1 - this.smoothingFactor) * rms);

    const now = currentTime * 1000; // currentTime is in seconds in AudioWorklet

    if (this.smoothedEnergy > this.threshold) {
      this.lastSpeechTime = now;
      if (!this.isSpeaking) {
        this.isSpeaking = true;
        this.port.postMessage({ type: 'speech_start', energy: this.smoothedEnergy, timestamp: now });
      }
    } else {
      if (this.isSpeaking && (now - this.lastSpeechTime > this.silenceDelay)) {
        this.isSpeaking = false;
        this.port.postMessage({ type: 'speech_end', timestamp: now });
      }
    }

    // Optional: send periodic energy updates for UI meters (metering at a lower frequency to save messages)
    // AudioWorklets process in chunks of 128 frames. 
    // At 48kHz, this is ~2.6ms per block. We shouldn't send messages every block.
    // However, since we only need simple VAD, we'll send a low-rate energy update if needed.
    // For now, only send state changes to minimize main-thread bridge overhead.
    // If the UI absolutely needs a meter, we can throttle energy updates here.
    if (Math.random() < 0.05) { // roughly every 20 blocks (~50ms)
       this.port.postMessage({ type: 'energy', energy: this.smoothedEnergy });
    }

    return true; // Keep processor alive
  }
}

registerProcessor('vad-processor', VADProcessor);
