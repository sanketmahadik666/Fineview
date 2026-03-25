import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

let landmarker = null;
let lastTs = -1;
const SAMPLE_INTERVAL = 200; // ms, ~5fps

self.onmessage = async (e) => {
  const { type, data } = e.data || {};

  if (type === 'INIT') {
    const vision = await FilesetResolver.forVisionTasks('/assets/mediapipe/wasm');
    landmarker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: '/assets/mediapipe/face_landmarker.task',
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numFaces: 3,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    });
    self.postMessage({ type: 'READY' });
  }

  if (type === 'FRAME' && landmarker) {
    const now = data.timestamp;
    if (now - lastTs < SAMPLE_INTERVAL) return;
    lastTs = now;

    const result = landmarker.detectForVideo(data.bitmap, now);
    const summary = extractSummary(result);
    self.postMessage({ type: 'RESULT', summary });
  }
};

function extractSummary(result) {
  const faces = result.faceLandmarks?.length || 0;
  const mat = result.facialTransformationMatrixes?.[0]?.data;
  const bsList = result.faceBlendshapes?.[0] || [];

  let yaw = 0;
  let pitch = 0;
  let roll = 0;

  if (mat) {
    pitch = Math.asin(-mat[9]) * (180 / Math.PI);
    yaw = Math.atan2(mat[8], mat[10]) * (180 / Math.PI);
    roll = Math.atan2(mat[1], mat[5]) * (180 / Math.PI);
  }

  const findBS = (name) =>
    bsList.find((b) => b.categories?.[0]?.categoryName === name)?.categories[0]?.score || 0;

  const lookingAway = Math.abs(yaw) > 30 || Math.abs(pitch) > 20;
  const events = [];
  if (faces === 0) events.push('NO_FACE');
  if (faces > 1) events.push('MULTIPLE_FACES');
  if (lookingAway) events.push('LOOKING_AWAY');

  return {
    facesDetected: faces,
    lookingAway,
    gazeDirection: { yaw, pitch, roll },
    blendshapes: {
      eyeLookOutLeft: findBS('eyeLookOutLeft'),
      eyeLookOutRight: findBS('eyeLookOutRight'),
      eyeLookUp: findBS('eyeLookUp'),
      eyeBlinkLeft: findBS('eyeBlinkLeft'),
      eyeBlinkRight: findBS('eyeBlinkRight'),
    },
    events,
  };
}

