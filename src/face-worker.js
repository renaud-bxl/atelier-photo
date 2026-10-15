import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { inspectLocalGraphics } from './graphics-capabilities.js';

// The runtime and model are bundled locally. No photo or model request leaves
// the application's private atelier: protocol.
const LEFT_EYE = [33, 160, 158, 133, 153, 144];
const RIGHT_EYE = [362, 385, 387, 263, 373, 380];
const LEFT_IRIS=[469,470,471,472];
const RIGHT_IRIS=[474,475,476,477];
const OUTER_LIPS=[61,146,91,181,84,17,314,405,321,375,291,409,270,269,267,0,37,39,40,185];
const INNER_MOUTH = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95];
const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378,
  400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];

const normalized = value => Math.max(0, Math.min(1, value));
function selectPoints(points, indexes) {
  return indexes.map(index => points[index])
    .filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y))
    .map(point => ({ x: normalized(point.x), y: normalized(point.y) }));
}

/** Top-left normalized coordinates in the auto-oriented, uncropped photograph. */
export function toFaceRegions(result) {
  const faces = [];
  for (const points of (result?.faceLandmarks ?? []).slice(0, 10)) {
    if (!Array.isArray(points)) continue;
    const oval = selectPoints(points, FACE_OVAL);
    if (oval.length < 12) continue;
    const x = Math.min(...oval.map(point => point.x));
    const y = Math.min(...oval.map(point => point.y));
    const right = Math.max(...oval.map(point => point.x));
    const bottom = Math.max(...oval.map(point => point.y));
    if (right - x < 0.002 || bottom - y < 0.002) continue;
    faces.push({ box: { x, y, width: right - x, height: bottom - y },
      leftEye: selectPoints(points, LEFT_EYE),
      rightEye: selectPoints(points, RIGHT_EYE),
      leftIris:selectPoints(points,LEFT_IRIS),rightIris:selectPoints(points,RIGHT_IRIS),
      outerLips:selectPoints(points,OUTER_LIPS),
      mouth: selectPoints(points, INNER_MOUTH) });
  }
  return { faces };
}

function message(error) {
  return error instanceof Error ? error.message : String(error || 'La détection locale a échoué.');
}

function loadPhoto(id) {
  return new Promise((resolve, reject) => {
    const photo = new Image();
    photo.crossOrigin = 'anonymous';
    photo.decoding = 'async';
    const timeout = setTimeout(() => {
      cleanup();
      photo.removeAttribute('src');
      reject(new Error('Le chargement de l’aperçu pour la détection a expiré.'));
    }, 45_000);
    function cleanup() {
      clearTimeout(timeout);
      photo.onload = null;
      photo.onerror = null;
    }
    photo.onload = () => {
      cleanup();
      if (!photo.naturalWidth || !photo.naturalHeight) {
        photo.removeAttribute('src');
        reject(new Error('L’aperçu de cette photo est vide.'));
      } else resolve(photo);
    };
    photo.onerror = () => {
      cleanup();
      photo.removeAttribute('src');
      reject(new Error('Impossible de charger cette photo pour la détection locale.'));
    };
    photo.src = `atelier://preview/${encodeURIComponent(id)}?original=1`;
  });
}

function startWorker(api) {
  let detector = null;
  let initializationError = null;
  let initialized = false;
  let closed = false;
  let processing = false;
  const tasks = [];

  async function complete(requestId, landmarks, error) {
    try { await api.completeFaceTask(requestId, landmarks, error); }
    catch (failure) { console.error('Réponse du moteur de détection indisponible :', message(failure)); }
  }

  async function drain() {
    if (!initialized || processing || closed) return;
    processing = true;
    try {
      while (tasks.length && !closed) {
        const task = tasks.shift();
        if (initializationError) {
          await complete(task.requestId, { faces: [] }, initializationError);
          continue;
        }
        let photo;
        try {
          if (typeof task.id !== 'string' || !task.id || task.id.length > 500) {
            throw new Error('Identifiant de photo non valide.');
          }
          photo = await loadPhoto(task.id);
          if (closed) break;
          const result = detector.detect(photo);
          await complete(task.requestId, toFaceRegions(result));
        } catch (failure) {
          await complete(task.requestId, { faces: [] }, message(failure));
        } finally {
          photo?.removeAttribute('src');
        }
      }
    } finally { processing = false; }
  }

  const unsubscribe = api.onFaceTask(task => {
    if (closed || !task || !['string', 'number'].includes(typeof task.requestId)) return;
    tasks.push({ requestId: task.requestId, id: task.id });
    void drain();
  });

  async function initialize() {
    try {
      // The CPU inference delegate still uploads browser images through WebGL.
      if (!inspectLocalGraphics().webgl) throw new Error('Le pilote graphique actuel ne permet pas la détection des visages.');
      const fileset = await FilesetResolver.forVisionTasks('atelier://assets/wasm');
      detector = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: 'atelier://assets/face_landmarker.task', delegate: 'CPU' },
        runningMode: 'IMAGE', numFaces: 10,
        minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
        outputFaceBlendshapes: false, outputFacialTransformationMatrixes: false
      });
    } catch (failure) { initializationError = message(failure); }
    if (closed) { detector?.close(); detector = null; return; }
    initialized = true;
    try { await api.faceReady(initializationError ?? undefined); }
    catch (failure) { console.error('Initialisation de la détection non signalée :', message(failure)); }
    void drain();
  }

  window.addEventListener('beforeunload', () => {
    closed = true;
    if (typeof unsubscribe === 'function') unsubscribe();
    tasks.length = 0;
    detector?.close();
    detector = null;
  }, { once: true });
  void initialize();
}

if (typeof window !== 'undefined') {
  const api = window.atelier;
  if (api?.onFaceTask && api?.completeFaceTask && api?.faceReady) startWorker(api);
  else console.error('Le moteur de détection doit être lancé dans la fenêtre privée d’Atelier Photo.');
}
