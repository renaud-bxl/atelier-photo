import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { recommend, edit, parseRecommendation } from '../desktop/ai-service.mjs';

const imageData = await sharp({ create: { width: 1800, height: 1000, channels: 3, background: '#c0a080' } })
  .withMetadata({ exif: { IFD0: { Artist: 'Private metadata' } } }).jpeg().toBuffer();
const config = { imageData, instruction: 'Éclaircir naturellement.', provider: 'openai', model: 'gpt-6-luna', apiKey: 'offline-key-private-value' };
const jsonResponse = value => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('partial fenced JSON preserves neutral values and clamps model output', () => {
  const result = parseRecommendation('Voici :\n```json\n{"adjustments":{"exposure":9,"contrast":0.1,"saturation":"1.2","flipHorizontal":true},"explanation":"Lumière {douce}."}\n```');
  assert.equal(result.adjustments.exposure, 3);
  assert.equal(result.adjustments.contrast, 0.5);
  assert.equal(result.adjustments.saturation, 1.2);
  assert.equal(result.adjustments.shadows, 0);
  assert.equal(result.adjustments.flipHorizontal, true);
  assert.equal(result.explanation, 'Lumière {douce}.');
  assert.equal(Object.keys(result.adjustments).length, 26);
  assert.equal(result.adjustments.cropX, 0.5);
  assert.equal(result.adjustments.cropY, 0.5);
  for (const name of ['blemishReduction', 'skinEvenness', 'underEyeLight', 'eyeContrast', 'lipSaturation']) {
    assert.equal(result.adjustments[name], 0);
  }
});

test('parser rejects invalid types, nonfinite values and unknown-only output', () => {
  for (const input of ['not JSON', '{}', '{"adjustments":null}', '{"exposure":true}', '{"flipHorizontal":1}', '{"exposure":"NaN"}', '{"exposure":" "}', '{"unknown":1}']) {
    assert.throws(() => parseRecommendation(input));
  }
  assert.equal(parseRecommendation('Example: {x} Actual: {"temperature":-120}').adjustments.temperature, -100);
  const value = parseRecommendation('{"adjustments":{"exposure":0,"__proto__":{"polluted":true}}}');
  assert.equal(value.adjustments.exposure, 0);
  assert.equal({}.polluted, undefined);
});

test('OpenAI uses the fixed endpoint and cleaned 1400px image; explanation cannot echo the key', async t => {
  let request;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return jsonResponse({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ adjustments: { exposure: 0.25 }, explanation: `Clé ${config.apiKey}` }) }] }] });
  });
  const result = await recommend(config);
  assert.equal(result.adjustments.exposure, 0.25);
  assert.equal(result.explanation, 'Clé [clé masquée]');
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.headers.Authorization, `Bearer ${config.apiKey}`);
  assert.equal(request.body.store, false);
  const bytes = Buffer.from(request.body.input[0].content[0].image_url.split(',')[1], 'base64');
  const metadata = await sharp(bytes).metadata();
  assert.equal(metadata.width, 1400);
  assert.equal(metadata.format, 'jpeg');
  assert.equal(metadata.exif, undefined);
});

test('Gemini and Claude vision envelopes map text to the same adjustments contract', async t => {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    seen.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    const text = '{"adjustments":{"shadows":0.2},"explanation":"Ombres ouvertes."}';
    return url.includes('googleapis')
      ? jsonResponse({ candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'ignored' }, { text }] } }] })
      : jsonResponse({ content: [{ type: 'text', text }] });
  });
  assert.equal((await recommend({ ...config, provider: 'gemini', model: 'gemini-3.8-flash' })).adjustments.shadows, 0.2);
  assert.equal((await recommend({ ...config, provider: 'claude', model: 'claude-sonnet-5-5' })).adjustments.shadows, 0.2);
  assert.equal(seen[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  assert.equal(seen[0].headers['x-goog-api-key'], config.apiKey);
  assert.equal(seen[0].body.contents[0].parts[0].inlineData.mimeType, 'image/jpeg');
  assert.equal(seen[1].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen[1].headers['anthropic-version'], '2023-06-01');
  assert.equal(seen[1].body.messages[0].content[0].source.type, 'base64');
});

test('OpenAI and Gemini image editing return decodable PNGs and ignore thought images', async t => {
  const edited = await sharp({ create: { width: 20, height: 10, channels: 3, background: '#ffcbaa' } }).png().toBuffer();
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    seen.push(JSON.parse(options.body));
    return url.includes('openai') ? jsonResponse({ data: [{ b64_json: edited.toString('base64') }] })
      : jsonResponse({ candidates: [{ finishReason: 'STOP', content: { parts: [
        { thought: true, inlineData: { mimeType: 'image/png', data: 'invalid-thought' } },
        { inlineData: { mimeType: 'image/png', data: edited.toString('base64') } },
      ] } }] });
  });
  const first = await edit({ ...config, model: 'gpt-image-2.5-sunburst' });
  const second = await edit({ ...config, provider: 'gemini', model: 'gemini-3.1-flash-image' });
  assert.equal((await sharp(first).metadata()).width, 20);
  assert.equal((await sharp(second).metadata()).format, 'png');
  assert.ok(seen[0].images[0].image_url.startsWith('data:image/png;base64,'));
  assert.deepEqual(seen[1].generationConfig.responseModalities, ['TEXT', 'IMAGE']);
});

test('validation and cancellation prevent any provider request', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network'); });
  await assert.rejects(edit({ ...config, provider: 'claude' }), /Claude/);
  await assert.rejects(recommend({ ...config, apiKey: '' }), /clé/);
  await assert.rejects(recommend({ ...config, model: '../other-host' }), /modèle/);
  await assert.rejects(recommend({ ...config, imageData: Buffer.from('invalid') }), /photo/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(recommend({ ...config, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(mock.mock.callCount(), 0);
});

test('provider and network failures do not expose body, key or underlying exception', async t => {
  const secret = config.apiKey;
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: { message: secret } }), { status: 401 }));
  await assert.rejects(recommend(config), error => error.message.includes('HTTP 401') && !error.message.includes(secret));
  mock.mock.mockImplementation(async () => { throw new Error(`Request headers: ${secret}`); });
  await assert.rejects(recommend(config), error => error.message.includes('connexion') && !error.message.includes(secret));
  mock.mock.mockImplementation(async () => jsonResponse({ data: [{ b64_json: Buffer.from('<script>invalid</script>').toString('base64') }] }));
  await assert.rejects(edit({ ...config, model: 'gpt-image-2.5-sunburst' }), /image invalide/);
});
