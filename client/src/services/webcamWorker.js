import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

/**
 * Webcam Analysis Worker — Advanced MediaPipe Version
 * 
 * Runs FaceLandmarker off the main thread.
 * Receives raw pixel data via Transferable ArrayBuffer (zero-copy).
 * Detects face presence, multiple faces, and estimates gaze (looking away).
 */

let faceLandmarker = null;
let isInitializing = false;

// Initialize MediaPipe FaceLandmarker
async function initModel() {
  if (faceLandmarker || isInitializing) return;
  isInitializing = true;
  
  try {
    // Load WASM from reliable CDN to avoid Vite worker asset bundling complexity
    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
    );
    
    faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
        delegate: "GPU" // Try GPU, fallback to CPU automatically
      },
      runningMode: "IMAGE",
      numFaces: 5,
    });
    
    self.postMessage({ type: 'init_success' });
  } catch (err) {
    console.error('[WebcamWorker] MediaPipe initialization failed:', err);
    self.postMessage({ type: 'init_error', error: err.message });
  } finally {
    isInitializing = false;
  }
}

// Start initialization immediately
initModel();

self.onmessage = async (e) => {
  if (!faceLandmarker) {
    // Drop frames while loading model (prevents queue buildup)
    return;
  }

  const { buffer, width, height, timestamp } = e.data;
  
  // Reconstruct ImageData object format required by canvas APIs/MediaPipe (conceptually)
  // MediaPipe expects an image source (HTMLImageElement, ImageData, etc.)
  // We reconstruct an ImageData purely to pass the pixels.
  const data = new Uint8ClampedArray(buffer);
  const imageData = new ImageData(data, width, height);

  try {
    const results = faceLandmarker.detect(imageData);
    
    let faceDetected = false;
    let faceCount = 0;
    let isLookingAway = false;

    if (results.faceLandmarks && results.faceLandmarks.length > 0) {
      faceDetected = true;
      faceCount = results.faceLandmarks.length;

      // Simple heuristic for "Looking Away" using the primary face
      // Compare nose tip (1) x-coordinate to the edges of the face contour
      if (faceCount === 1) {
        const landmarks = results.faceLandmarks[0];
        const noseTipX = landmarks[1].x; // Normalized 0.0 to 1.0
        const leftEarX = landmarks[234].x;
        const rightEarX = landmarks[454].x;

        // If nose is too close to left or right ear, head is turned significantly
        // Normal state: nose is roughly in the middle
        const distanceToLeft = Math.abs(noseTipX - leftEarX);
        const distanceToRight = Math.abs(rightEarX - noseTipX);
        const ratio = distanceToLeft / (distanceToRight || 0.001);

        // Ratio heavily skewed means looking away
        if (ratio < 0.25 || ratio > 4.0) {
          isLookingAway = true;
        }
      }
    }

    self.postMessage({
      type: 'analysis_result',
      faceDetected,
      faceCount,
      isLookingAway,
      timestamp: Date.now(),
    });

  } catch (err) {
    console.warn('[WebcamWorker] Analysis error:', err.message);
  }
};
