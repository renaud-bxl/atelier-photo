/** Probe only newly created canvases; never reuse or change an application canvas.
 * `webgl` means WebGL 1 or 2 is usable, matching the vision SDK's fallback.
 * No probe runs at import time, and no GPU identity or renderer string is read.
 */
export function inspectLocalGraphics({ createCanvas = () => document.createElement('canvas') } = {}) {
  function probe(type) {
    let canvas, context;
    try {
      canvas = createCanvas();
      canvas.width = 1;
      canvas.height = 1;
      context = canvas.getContext(type);
      return Boolean(context) && (typeof context.isContextLost !== 'function' || !context.isContextLost());
    } catch { return false; }
    finally {
      // Context loss releases this probe's GPU resources without changing the
      // browser's security policy or any renderer used by the photo editor.
      try { context?.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* Optional cleanup extension. */ }
      try { if (canvas) { canvas.width = 0; canvas.height = 0; } } catch { /* A failed canvas cannot be resized. */ }
      try { canvas?.remove(); } catch { /* The normal probe canvas is detached. */ }
    }
  }
  const webgl2 = probe('webgl2');
  const webgl1 = probe('webgl');
  return Object.freeze({ webgl: webgl1 || webgl2, webgl2 });
}
