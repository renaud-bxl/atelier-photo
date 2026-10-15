import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

// Execute the shipped main-process functions without importing Electron or
// touching a real credential store. A store access here represents the OS call
// that can display a Keychain prompt and block a newly signed macOS package.
const source = await fs.readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
const start = source.indexOf('function encryptionAvailable()');
const end = source.indexOf('const localOptions =', start);
assert.ok(start >= 0 && end > start, 'Credential function boundaries must exist.');
const credentialFunctions = source.slice(start, end);
const initializer = source.match(/\bencryptedCapability\s*=\s*([^;\n]+)/)?.[1];
assert.ok(initializer, 'Read the actual initial encryption capability from main.');
const saveStart = source.indexOf("handle('saveKey',");
const saveEnd = source.indexOf("handle('deleteKey',", saveStart);
assert.ok(saveStart >= 0 && saveEnd > saveStart, 'The actual save-key handler must exist.');
const saveHandler = source.slice(saveStart, saveEnd);

function credentials({ platform = 'darwin', vault = {}, session = [], available = true,
  backend = 'gnome_libsecret', decryptError = false, forbidStore = false } = {}) {
  const calls = [], writes = [], handlers = new Map();
  const record = (name, result) => (...args) => {
    calls.push({ name, args });
    if (forbidStore) throw new Error('Credential store must not be contacted: ' + name);
    return typeof result === 'function' ? result(...args) : result;
  };
  const safeStorage = {
    isEncryptionAvailable: record('available', available),
    getSelectedStorageBackend: record('backend', backend),
    decryptString: record('decrypt', bytes => {
      assert.equal(bytes.toString('utf8'), 'synthetic-ciphertext');
      if (decryptError) throw new Error('Synthetic unavailable credential.');
      return 'synthetic-decrypted-key';
    }),
    encryptString: record('encrypt', value => {
      assert.equal(value, 'synthetic-key-for-qa');
      return Buffer.from('synthetic-ciphertext');
    })
  };
  const context = {
    settings: { provider: 'local', language: 'fr', models: { openai: 'synthetic-model' } },
    vault: { ...vault }, sessionKeys: new Map(session), providers: new Set(['openai', 'gemini', 'claude']),
    process: { platform }, app: { getVersion: () => '0.1.0-qa' }, Buffer, safeStorage,
    cloudProvider: value => assert.ok(['openai', 'gemini', 'claude'].includes(value)),
    fail: value => { throw new Error(value); },
    dataPath: name => '/synthetic-profile/' + name,
    atomicJSON: async (path, value) => { writes.push({ path, value: JSON.parse(JSON.stringify(value)) }); },
    handle: (name, callback) => handlers.set(name, callback)
  };
  const api = vm.runInNewContext(`let encryptedCapability = ${initializer};\n${credentialFunctions}\n${saveHandler}\n({ settingsPublic, keyFor })`, context);
  return { ...api, calls, writes, saveKey: handlers.get('saveKey') };
}
const plain = value => JSON.parse(JSON.stringify(value));
const cipher = Buffer.from('synthetic-ciphertext').toString('base64');

test('displaying initial settings never opens an OS credential store on any platform', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const api = credentials({ platform, forbidStore: true });
    for (let count = 0; count < 3; count++) {
      const result = api.settingsPublic();
      assert.deepEqual(plain(result.keys), { openai: false, gemini: false, claude: false });
      assert.equal(result.encryptedStorage, null, 'Availability remains unknown before a real key operation.');
      assert.equal(result.platform, platform);
      assert.equal(result.provider, 'local');
      assert.equal(result.version, '0.1.0-qa');
    }
    assert.deepEqual(api.calls, []);
  }
});

test('stored and session key flags need neither decryption nor an availability probe', () => {
  const api = credentials({ vault: { openai: cipher, claude: cipher },
    session: [['gemini', 'synthetic-session-key']], forbidStore: true });
  const result = api.settingsPublic();
  assert.deepEqual(plain(result.keys), { openai: true, gemini: true, claude: true });
  assert.equal(result.encryptedStorage, null);
  const serialized = JSON.stringify(result);
  for (const secret of [cipher, 'synthetic-session-key', 'synthetic-ciphertext']) {
    assert.equal(serialized.includes(secret), false, 'Renderer status must contain flags only.');
  }
  assert.deepEqual(api.calls, []);
});

test('retrieving an absent local or cloud key never opens the credential store', () => {
  const api = credentials({ forbidStore: true });
  for (const provider of ['local', 'openai', 'gemini', 'claude']) assert.equal(api.keyFor(provider), '');
  assert.deepEqual(api.calls, []);
  assert.equal(api.settingsPublic().encryptedStorage, null);
});

test('a session credential is returned without examining an encrypted duplicate', () => {
  const api = credentials({ vault: { openai: cipher }, session: [['openai', 'synthetic-session-key']], forbidStore: true });
  assert.equal(api.keyFor('openai'), 'synthetic-session-key');
  assert.deepEqual(api.calls, []);
});

test('a real cloud key action still probes availability and decrypts its stored credential', () => {
  const api = credentials({ vault: { openai: cipher } });
  assert.equal(api.keyFor('openai'), 'synthetic-decrypted-key');
  assert.deepEqual(api.calls.map(call => call.name), ['available', 'decrypt']);
  assert.equal(api.settingsPublic().encryptedStorage, true);
  assert.deepEqual(api.calls.map(call => call.name), ['available', 'decrypt'], 'Later metadata reads do not repeat a store operation.');
  assert.equal(JSON.stringify(api.settingsPublic()).includes('synthetic-decrypted-key'), false);
});

test('failed or unavailable encrypted reads return no key without inventing successful decryption', () => {
  const unavailable = credentials({ vault: { openai: cipher }, available: false });
  assert.equal(unavailable.keyFor('openai'), '');
  assert.deepEqual(unavailable.calls.map(call => call.name), ['available']);
  assert.equal(unavailable.settingsPublic().encryptedStorage, false);
  const failed = credentials({ vault: { openai: cipher }, decryptError: true });
  assert.equal(failed.keyFor('openai'), '');
  assert.deepEqual(failed.calls.map(call => call.name), ['available', 'decrypt']);
  // Presence is a cheap flag, not a claim that a corrupted credential works.
  assert.equal(failed.settingsPublic().keys.openai, true);
});

test('Linux basic_text never counts as encrypted storage or decrypts a saved credential', () => {
  const api = credentials({ platform: 'linux', vault: { openai: cipher }, backend: 'basic_text' });
  assert.equal(api.keyFor('openai'), '');
  assert.deepEqual(api.calls.map(call => call.name), ['available', 'backend']);
  assert.equal(api.settingsPublic().encryptedStorage, false);
});

test('adding a cloud key still encrypts and persists through the normal credential path', async () => {
  const api = credentials();
  const result = await api.saveKey('openai', '  synthetic-key-for-qa  ');
  assert.deepEqual(api.calls.map(call => call.name), ['available', 'encrypt']);
  assert.deepEqual(api.writes, [{ path: '/synthetic-profile/keys.encrypted.json', value: { openai: cipher } }]);
  assert.equal(result.keys.openai, true);
  assert.equal(result.encryptedStorage, true);
  assert.equal(api.keyFor('openai'), 'synthetic-key-for-qa');
  assert.deepEqual(api.calls.map(call => call.name), ['available', 'encrypt']);
  assert.equal(JSON.stringify(result).includes('synthetic-key-for-qa'), false);
});

test('an unavailable credential store keeps a new key in session and writes no plaintext', async () => {
  const api = credentials({ available: false, vault: { openai: cipher } });
  const result = await api.saveKey('openai', 'synthetic-key-for-qa');
  assert.deepEqual(api.calls.map(call => call.name), ['available']);
  assert.deepEqual(api.writes, [{ path: '/synthetic-profile/keys.encrypted.json', value: {} }]);
  assert.equal(api.keyFor('openai'), 'synthetic-key-for-qa');
  assert.equal(result.keys.openai, true);
  assert.equal(result.encryptedStorage, false);
});
