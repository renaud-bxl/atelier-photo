import test from 'node:test';
import assert from 'node:assert/strict';
import { PHI, goldenGeometry } from '../src/golden-geometry.js';

const EPSILON = 2e-12;
function near(actual, expected, message, tolerance = EPSILON) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} versus ${expected}`);
}

function parsePath(path) {
  if (!path) return [];
  const values = path.match(/[MA]|[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi);
  assert.equal(values.shift(), 'M');
  let start = { x: Number(values.shift()), y: Number(values.shift()) };
  const arcs = [];
  while (values.length) {
    assert.equal(values.shift(), 'A', 'Only true circular SVG arcs may join the squares');
    const radius = Number(values.shift());
    near(Number(values.shift()), radius, 'The arc must be circular');
    assert.equal(Number(values.shift()), 0);
    assert.equal(Number(values.shift()), 0, 'Every arc must use the short sweep');
    const sweep = Number(values.shift());
    const end = { x: Number(values.shift()), y: Number(values.shift()) };
    arcs.push({ start, end, radius, sweep });
    start = end;
  }
  return arcs;
}

function arcCenter(arc) {
  const dx = arc.end.x - arc.start.x, dy = arc.end.y - arc.start.y;
  const chord = Math.hypot(dx, dy);
  const offset = Math.sqrt(Math.max(0, arc.radius ** 2 - chord ** 2 / 4));
  const middle = { x: (arc.start.x + arc.end.x) / 2, y: (arc.start.y + arc.end.y) / 2 };
  for (const sign of [1, -1]) {
    const center = { x: middle.x - sign * dy / chord * offset, y: middle.y + sign * dx / chord * offset };
    const cross = (arc.start.x - center.x) * (arc.end.y - center.y) - (arc.start.y - center.y) * (arc.end.x - center.x);
    if ((cross > 0) === (arc.sweep === 1)) return center;
  }
  throw new Error('Arc has no valid center');
}

function within(point, square, message) {
  assert.ok(point.x >= square.x - EPSILON && point.x <= square.x + square.size + EPSILON, `${message}: x is outside its square`);
  assert.ok(point.y >= square.y - EPSILON && point.y <= square.y + square.size + EPSILON, `${message}: y is outside its square`);
}

test('le rectangle d’or est exact et les carrés décroissent selon 1/φ', () => {
  near(PHI ** 2, PHI + 1, 'Golden ratio identity');
  const geometry = goldenGeometry({ turns: 24 });
  near(geometry.width, PHI, 'Landscape width');
  near(geometry.height, 1, 'Landscape height');
  assert.equal(geometry.squares.length, 24);
  for (let index = 0; index < geometry.squares.length; index++) {
    const square = geometry.squares[index];
    near(square.size, PHI ** -index, 'Square size');
    if (index) near(square.size / geometry.squares[index - 1].size, 1 / PHI, 'Successive square ratio');
  }
  const area = geometry.squares.reduce((sum, square) => sum + square.size ** 2, 0);
  const remaining = PHI * PHI ** (-2 * geometry.squares.length);
  near(area + remaining, PHI, 'Squares and remaining golden rectangle must tile the original');
});

for (const orientation of [0, 90, 180, 270]) {
  for (const mirror of [false, true]) {
    test(`orientation ${orientation}°, miroir ${mirror} : bornes, continuité et tangentes`, () => {
      const geometry = goldenGeometry({ orientation, mirror, turns: 20 });
      near(geometry.width, orientation % 180 === 0 ? PHI : 1, 'Rotated width');
      near(geometry.height, orientation % 180 === 0 ? 1 : PHI, 'Rotated height');
      const arcs = parsePath(geometry.path);
      assert.equal(arcs.length, geometry.squares.length);
      let previousTangent;
      for (let index = 0; index < arcs.length; index++) {
        const square = geometry.squares[index], arc = arcs[index];
        assert.ok([square.x, square.y, square.size, arc.start.x, arc.start.y, arc.end.x, arc.end.y, arc.radius].every(Number.isFinite));
        assert.ok(square.x >= -EPSILON && square.y >= -EPSILON);
        assert.ok(square.x + square.size <= geometry.width + EPSILON);
        assert.ok(square.y + square.size <= geometry.height + EPSILON);
        near(arc.radius, square.size, 'Radius equals the corresponding square side');
        assert.equal(arc.sweep, mirror ? 0 : 1, 'Mirroring reverses winding');
        within(arc.start, square, 'Arc start');
        within(arc.end, square, 'Arc end');
        const center = arcCenter(arc);
        const v0 = { x: (arc.start.x - center.x) / arc.radius, y: (arc.start.y - center.y) / arc.radius };
        const v1 = { x: (arc.end.x - center.x) / arc.radius, y: (arc.end.y - center.y) / arc.radius };
        near(v0.x * v1.x + v0.y * v1.y, 0, 'Every arc spans exactly a quarter circle', 1e-8);
        near(Math.hypot(v0.x, v0.y), 1, 'Start radius', 1e-8);
        near(Math.hypot(v1.x, v1.y), 1, 'End radius', 1e-8);
        within({ x: center.x + (v0.x + v1.x) * arc.radius / Math.SQRT2, y: center.y + (v0.y + v1.y) * arc.radius / Math.SQRT2 }, square, 'Arc midpoint');
        const sign = arc.sweep === 1 ? 1 : -1;
        const tangent = { x: -sign * v0.y, y: sign * v0.x };
        if (previousTangent) near(tangent.x * previousTangent.x + tangent.y * previousTangent.y, 1, 'Neighboring arcs share their tangent', 1e-8);
        previousTangent = { x: -sign * v1.y, y: sign * v1.x };
        for (let other = 0; other < index; other++) {
          const prior = geometry.squares[other];
          const overlapX = Math.min(square.x + square.size, prior.x + prior.size) - Math.max(square.x, prior.x);
          const overlapY = Math.min(square.y + square.size, prior.y + prior.size) - Math.max(square.y, prior.y);
          assert.ok(overlapX <= EPSILON || overlapY <= EPSILON, 'Square interiors must not overlap');
        }
      }
    });
  }
}

test('les entrées limites restent finies et la quantité de géométrie est bornée', () => {
  for (const turns of [0, -10, 0.75]) {
    const geometry = goldenGeometry({ turns });
    assert.deepEqual(geometry.squares, []);
    assert.equal(geometry.path, '');
  }
  for (const turns of [NaN, Infinity, -Infinity]) {
    const geometry = goldenGeometry({ turns, orientation: NaN });
    assert.equal(geometry.squares.length, 10);
    assert.ok(!/NaN|Infinity/.test(geometry.path));
  }
  assert.equal(goldenGeometry({ turns: 1e9 }).squares.length, 32);
  assert.deepEqual(goldenGeometry({ orientation: -90 }), goldenGeometry({ orientation: 270 }));
  assert.deepEqual(goldenGeometry({ orientation: 450 }), goldenGeometry({ orientation: 90 }));
  assert.deepEqual(goldenGeometry({ orientation: 44 }), goldenGeometry({ orientation: 0 }));
  assert.deepEqual(goldenGeometry({ orientation: 46 }), goldenGeometry({ orientation: 90 }));
});
