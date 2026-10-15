import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'rolldown/utils';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const languages = ['fr', 'nl', 'en', 'es', 'zh', 'ja', 'ar', 'de', 'pt', 'it', 'hi', 'ko'];
const sourceFiles = ['src/main.jsx', 'src/Dialogs.jsx', 'src/PresetBrowser.jsx', 'src/VirtualLibrary.jsx', 'src/SpatialPhotoModal.jsx'];
const visibleAttributes = new Set(['title', 'subtitle', 'placeholder', 'aria-label', 'alt', 'label']);
const technicalLabels = new Set(['EV', 'JPEG', 'PNG', 'TIFF', 'WebP', 'AVIF', 'HEIF', 'XMP', 'LUT', 'sRGB', 'OpenAI', 'Gemini', 'Claude', 'RGB']);
const normalize = value => value.replace(/\s+/gu, ' ').trim();
const required = new Map();

function message(value, origin) {
  const normalized = normalize(value);
  if (!normalized || !/\p{L}/u.test(normalized) || technicalLabels.has(normalized)) return;
  if (!required.has(normalized)) required.set(normalized, new Set());
  required.get(normalized).add(origin);
}

/** Trace rendered literal branches, not conditions, CSS classes, model IDs or user text. */
function rendered(expression, origin) {
  if (!expression) return;
  switch (expression.type) {
    case 'Literal':
      if (typeof expression.value === 'string') message(expression.value, origin);
      break;
    case 'TemplateLiteral': {
      let value = '';
      expression.quasis.forEach((quasi, index) => { value += quasi.value.cooked ?? quasi.value.raw; if (index < expression.expressions.length) value += `{${index}}`; });
      message(value, origin);
      break;
    }
    case 'ConditionalExpression': rendered(expression.consequent, origin); rendered(expression.alternate, origin); break;
    case 'LogicalExpression': rendered(expression.right, origin); break;
    case 'BinaryExpression':
      if (expression.operator === '+') { rendered(expression.left, origin); rendered(expression.right, origin); }
      break;
    case 'CallExpression':
      if (expression.callee?.type === 'MemberExpression' && expression.callee.property?.name === 'map') {
        const items = expression.callee.object;
        if (items?.type === 'ArrayExpression') {
          for (const item of items.elements) {
            if (item?.type === 'ArrayExpression') {
              const labels = item.elements.filter(value => value?.type === 'Literal' && typeof value.value === 'string');
              rendered(labels.at(-1), origin);
            } else if (item?.type === 'Literal' && !['jpeg', 'png', 'tiff'].includes(item.value)) rendered(item, origin);
          }
        }
      }
      break;
  }
}

function walk(node, visit, parent = null) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(child => walk(child, visit, parent)); return; }
  if (node.type) visit(node, parent);
  for (const [key, value] of Object.entries(node)) if (!['start', 'end', 'raw', 'loc'].includes(key) && value && typeof value === 'object') walk(value, visit, node);
}

for (const file of sourceFiles) {
  const source = readFileSync(join(root, file), 'utf8');
  const parsed = parseSync(file, source);
  assert.deepEqual(parsed.errors, [], `Unable to parse ${file}`);
  const origin = node => `${file}:${source.slice(0, node.start).split('\n').length}`;
  walk(parsed.program, (node, parent) => {
    if (node.type === 'JSXText') message(node.value, origin(node));
    if (node.type === 'JSXAttribute') {
      if (visibleAttributes.has(node.name?.name)) rendered(node.value?.type === 'JSXExpressionContainer' ? node.value.expression : node.value, origin(node));
      if (node.name?.name === 'field' && node.value?.expression?.type === 'ArrayExpression') rendered(node.value.expression.elements[1], origin(node));
    }
    if (node.type === 'JSXExpressionContainer' && parent?.type !== 'JSXAttribute') rendered(node.expression, origin(node));
    if (node.type === 'CallExpression' && ['notify', 'translate'].includes(node.callee?.name)) rendered(node.arguments[0], origin(node));
    if (node.type === 'VariableDeclarator' && node.id?.name === 'fields') {
      walk(node.init, candidate => {
        if (candidate.type === 'ArrayExpression' && candidate.elements[0]?.type === 'Literal' && candidate.elements[1]?.type === 'Literal') rendered(candidate.elements[1], origin(candidate));
      });
    }
  });
}

const fixture = JSON.parse(readFileSync(join(root, 'Tests/fixtures/ui-messages.json'), 'utf8'));
for (const [flow, messages] of Object.entries(fixture)) for (const value of messages) message(value, `flow:${flow}`);

// Optional diagnostic output helps a translator review new literals without changing any catalog.
if (process.env.ATELIER_UI_MESSAGES_OUTPUT) writeFileSync(process.env.ATELIER_UI_MESSAGES_OUTPUT, JSON.stringify([...required].map(([key, origins]) => ({ key, origins: [...origins] })), null, 2));

test('les messages rendus et les nouveaux parcours sont couverts dans les douze langues', () => {
  const failures = [];
  for (const code of languages) {
    const dictionary = JSON.parse(readFileSync(join(root, 'locales', `${code}.json`), 'utf8'));
    for (const [key, origins] of required) {
      if (!Object.hasOwn(dictionary, key) || !String(dictionary[key]).trim()) failures.push(`${code}: ${key} (${[...origins].join(', ')})`);
    }
  }
  assert.equal(failures.length, 0, `Missing UI translations (${failures.length}):\n${failures.slice(0, 110).join('\n')}`);
});
