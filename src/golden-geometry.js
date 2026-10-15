export const PHI = (1 + Math.sqrt(5)) / 2;

const DEFAULT_TURNS = 10;
const MAX_TURNS = 32;

function quarterTurns(value) {
  const angle = Number(value);
  if (!Number.isFinite(angle)) return 0;
  return Math.round((((angle % 360) + 360) % 360) / 90) % 4;
}

function arcCount(value) {
  const count = Number(value);
  return Number.isFinite(count) ? Math.min(MAX_TURNS, Math.max(0, Math.trunc(count))) : DEFAULT_TURNS;
}

function coordinate(value) {
  // Fifteen significant figures preserve the small tail without noisy SVG coordinates.
  return Math.abs(value) < 1e-15 ? '0' : Number(value.toPrecision(15)).toString();
}

/**
 * Tile an exact golden rectangle with squares of side phi^-n. Each square holds
 * one quarter-circle, tangent to the next; `turns` counts these quarter-turns.
 * Rotation is clockwise, followed by a horizontal mirror in the resulting frame.
 * Odd quarter-turns swap the returned width and height.
 */
export function goldenGeometry({ orientation = 0, mirror = false, turns = DEFAULT_TURNS } = {}) {
  const rotation = quarterTurns(orientation);
  const count = arcCount(turns);
  const width = rotation % 2 === 0 ? PHI : 1;
  const height = rotation % 2 === 0 ? 1 : PHI;
  const reflect = mirror === true;
  const transform = ({ x, y }) => {
    let point;
    switch (rotation) {
      case 1: point = { x: 1 - y, y: x }; break;
      case 2: point = { x: PHI - x, y: 1 - y }; break;
      case 3: point = { x: y, y: PHI - x }; break;
      default: point = { x, y };
    }
    if (reflect) point.x = width - point.x;
    return point;
  };

  const squares = [];
  const commands = [];
  let start = { x: 0, y: 1 };
  for (let index = 0; index < count; index++) {
    const size = PHI ** -index;
    let square, end;
    // The incoming endpoint determines the next square exactly. This avoids
    // accumulating gaps while repeatedly subtracting shrinking rectangles.
    switch (index % 4) {
      case 0:
        square = { x: start.x, y: start.y - size, size };
        end = { x: start.x + size, y: start.y - size };
        break;
      case 1:
        square = { x: start.x, y: start.y, size };
        end = { x: start.x + size, y: start.y + size };
        break;
      case 2:
        square = { x: start.x - size, y: start.y, size };
        end = { x: start.x - size, y: start.y + size };
        break;
      default:
        square = { x: start.x - size, y: start.y - size, size };
        end = { x: start.x - size, y: start.y - size };
    }

    const corners = [
      transform({ x: square.x, y: square.y }),
      transform({ x: square.x + size, y: square.y }),
      transform({ x: square.x, y: square.y + size }),
      transform({ x: square.x + size, y: square.y + size }),
    ];
    squares.push({ x: Math.min(...corners.map(point => point.x)), y: Math.min(...corners.map(point => point.y)), size });
    if (index === 0) {
      const point = transform(start);
      commands.push(`M ${coordinate(point.x)} ${coordinate(point.y)}`);
    }
    const endpoint = transform(end);
    const radius = coordinate(size);
    commands.push(`A ${radius} ${radius} 0 0 ${reflect ? 0 : 1} ${coordinate(endpoint.x)} ${coordinate(endpoint.y)}`);
    start = end;
  }
  return { width, height, squares, path: commands.join(' ') };
}
