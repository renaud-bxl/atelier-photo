import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';

const mainSource = await fs.readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
function imageQueue() {
  const source = mainSource.slice(mainSource.indexOf('let imageActive = 0;'), mainSource.indexOf('async function preview('));
  return vm.runInNewContext(`${source}\n({boundedImage, sharedImage, waiting:()=>imageWaiting.length, active:()=>imageActive})`, { AbortController, Promise, Error });
}
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

test('image queue never exceeds two active operations or 128 waiting previews', async () => {
  const queue = imageQueue();
  let active = 0, maximum = 0;
  const calls = Array.from({ length: 180 }, (_, i) => queue.boundedImage(async () => {
    maximum = Math.max(maximum, ++active); await pause(1); active--; return i;
  }, { kind: 'thumbnail' }));
  assert.ok(queue.waiting() <= 128);
  const results = await Promise.allSettled(calls);
  assert.ok(maximum <= 2);
  assert.equal(queue.active(), 0); assert.equal(queue.waiting(), 0);
  assert.ok(results.some(item => item.status === 'rejected'));
  assert.ok(results.some(item => item.status === 'fulfilled' && item.value === 179), 'Recent previews must survive the bound');
});

test('cancelling queued previews releases their slots', async () => {
  const queue = imageQueue();
  let release;
  const first = queue.boundedImage(() => new Promise(resolve => { release = resolve; }));
  let releaseSecond;
  const second = queue.boundedImage(() => new Promise(resolve => { releaseSecond = resolve; }));
  await pause(0);
  const controller = new AbortController();
  const obsolete = queue.boundedImage(() => assert.fail('Cancelled action must not execute'), { signal: controller.signal, kind: 'preview' });
  const rejected = assert.rejects(obsolete, /annulé/);
  controller.abort(); await rejected;
  assert.equal(queue.waiting(), 0);
  release(); releaseSecond(); await Promise.all([first, second]);
});

test('shared images deduplicate consumers and cancellation preserves remaining consumers', async () => {
  const queue = imageQueue(), requests = new Map();
  let calls = 0, cancelled = false;
  const create = async signal => { calls++; signal.addEventListener('abort', () => { cancelled = true; }); await pause(5); return 42; };
  const a = new AbortController(), b = new AbortController();
  const first = queue.sharedImage(requests, 'photo', create, a.signal);
  const second = queue.sharedImage(requests, 'photo', create, b.signal);
  const rejected = assert.rejects(first, /annulé/);
  a.abort(); await rejected;
  assert.equal(await second, 42); assert.equal(calls, 1); assert.equal(cancelled, false);
  assert.equal(requests.size, 0);
});

test('model asset boundaries reject traversal on Windows and POSIX', () => {
  const body = mainSource.match(/function within\(base, candidate\) \{([^\n]+)\}/)?.[1];
  assert.ok(body);
  for (const implementation of [path.win32, path.posix]) {
    const context = { relative: implementation.relative, isAbsolute: implementation.isAbsolute, sep: implementation.sep };
    const within = vm.runInNewContext(`(function(base,candidate){${body}})`, context);
    const base = implementation === path.win32 ? 'C:\\Atelier\\models' : '/Atelier/models';
    assert.equal(within(base, implementation.join(base, 'wasm', 'vision.wasm')), true);
    assert.equal(within(base, implementation.join(base, '..', 'secret')), false);
    assert.equal(within(base, `${base}-outside${implementation.sep}secret`), false);
    assert.equal(within(base, base), false);
    if (implementation === path.win32) assert.equal(within(base, 'D:\\Other\\secret'), false);
  }
});

test('preload subscription hides Electron event and returns an idempotent unsubscribe', async () => {
  const listeners = new Map(); let api, removals = 0;
  const electron = {
    contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
    ipcRenderer: { invoke: async channel => channel, on: (channel, handler) => listeners.set(channel, handler),
      removeListener: channel => { listeners.delete(channel); removals++; } },
    webUtils: { getPathForFile: () => { throw new TypeError('Not a File'); } }
  };
  const source = await fs.readFile(new URL('../desktop/preload.cjs', import.meta.url), 'utf8');
  vm.runInNewContext(source, { require: name => { assert.equal(name, 'electron'); return electron; } });
  let args;
  const unsubscribe = api.onProgress((...received) => { args = received; });
  const payload = { current: 5 };
  listeners.get('atelier:progress')({ sender: 'private Electron object' }, payload);
  assert.equal(args.length, 1); assert.equal(args[0], payload);
  unsubscribe(); unsubscribe(); assert.equal(removals, 1);
  assert.equal(api.filePath({}), '');
  assert.equal(await api.metadata('photo'), 'atelier:metadata');
});
