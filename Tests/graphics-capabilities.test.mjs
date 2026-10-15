import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectLocalGraphics } from '../src/graphics-capabilities.js';

function fixture({ supported = ['webgl', 'webgl2'], lost = [], failContext = [], failCleanup = false } = {}) {
  const canvases = [], released = [], extensions = [];
  const createCanvas = () => {
    const canvas = { width: 300, height: 150, removed: false,
      getContext(type) {
        this.type = type;
        if (failContext.includes(type)) throw new Error('Driver initialization failed');
        if (!supported.includes(type)) return null;
        return {
          isContextLost: () => lost.includes(type),
          getExtension(name) {
            extensions.push({ type, name });
            if (failCleanup) throw new Error('Driver cleanup failed');
            return { loseContext: () => released.push(type) };
          },
        };
      },
      remove() { this.removed = true; },
    };
    canvases.push(canvas);
    return canvas;
  };
  return { createCanvas, canvases, released, extensions };
}

test('local graphics probe reports both versions and releases only its own new contexts', () => {
  const fake = fixture();
  assert.deepEqual(inspectLocalGraphics(fake), { webgl: true, webgl2: true });
  assert.equal(fake.canvases.length, 2);
  assert.notEqual(fake.canvases[0], fake.canvases[1]);
  assert.deepEqual(fake.released, ['webgl2', 'webgl']);
  assert.ok(fake.extensions.every(entry => entry.name === 'WEBGL_lose_context'));
  assert.ok(fake.canvases.every(canvas => canvas.width === 0 && canvas.height === 0 && canvas.removed));
});

test('WebGL 1 fallback and WebGL 2-only drivers are both usable for the vision SDK', () => {
  assert.deepEqual(inspectLocalGraphics(fixture({ supported: ['webgl'] })), { webgl: true, webgl2: false });
  assert.deepEqual(inspectLocalGraphics(fixture({ supported: ['webgl2'] })), { webgl: true, webgl2: true });
});

test('blocked WebGL returns false instead of treating a present canvas as acceleration', () => {
  const fake = fixture({ supported: [] });
  assert.deepEqual(inspectLocalGraphics(fake), { webgl: false, webgl2: false });
  assert.deepEqual(fake.released, []);
  assert.ok(fake.canvases.every(canvas => canvas.removed));
});

test('a failed driver context does not prevent checking the other WebGL version', () => {
  assert.deepEqual(inspectLocalGraphics(fixture({ failContext: ['webgl2'] })), { webgl: true, webgl2: false });
  assert.deepEqual(inspectLocalGraphics(fixture({ failContext: ['webgl2', 'webgl'] })), { webgl: false, webgl2: false });
});

test('an already lost context is unavailable and still receives cleanup', () => {
  const fake = fixture({ lost: ['webgl2', 'webgl'] });
  assert.deepEqual(inspectLocalGraphics(fake), { webgl: false, webgl2: false });
  assert.deepEqual(fake.released, ['webgl2', 'webgl']);
});

test('canvas creation and malformed canvas failures stay contained', () => {
  for (const createCanvas of [() => { throw new Error('No document'); }, () => null, () => ({})]) {
    assert.deepEqual(inspectLocalGraphics({ createCanvas }), { webgl: false, webgl2: false });
  }
});

test('optional cleanup failures do not discard an otherwise usable driver', () => {
  const fake = fixture({ failCleanup: true });
  assert.deepEqual(inspectLocalGraphics(fake), { webgl: true, webgl2: true });
  assert.ok(fake.canvases.every(canvas => canvas.removed && canvas.width === 0 && canvas.height === 0));
});

test('context loss inspection errors are contained and the context is released', () => {
  const released = [];
  const createCanvas = () => ({
    getContext: () => ({ isContextLost() { throw new Error('Device removed'); }, getExtension: () => ({ loseContext: () => released.push(true) }) }),
    remove() {},
  });
  assert.deepEqual(inspectLocalGraphics({ createCanvas }), { webgl: false, webgl2: false });
  assert.equal(released.length, 2);
});

test('graphics results contain only immutable capability booleans and import needs no DOM', () => {
  const result = inspectLocalGraphics(fixture());
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(Object.keys(result).sort(), ['webgl', 'webgl2']);
  assert.throws(() => { result.webgl = false; }, TypeError);
  assert.deepEqual(inspectLocalGraphics(), { webgl: false, webgl2: false });
});
