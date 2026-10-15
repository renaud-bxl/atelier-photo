import React, { useMemo } from 'react';
import { goldenGeometry } from './golden-geometry.js';

/** Mount inside the visible photo bounds. This guide never enters the image pipeline. */
export function GoldenComposition({ orientation = 0, mirror = false, showSquares = true }) {
  const geometry = useMemo(() => goldenGeometry({ orientation, mirror }), [orientation, mirror]);
  return <svg className="golden-composition" data-testid="golden-composition" aria-hidden="true"
    viewBox={`0 0 ${geometry.width} ${geometry.height}`} preserveAspectRatio="xMidYMid meet"
    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 3, overflow: 'hidden' }}>
    {showSquares && <g fill="none" stroke="#7db7ff" opacity={0.4}>
      <rect x={0} y={0} width={geometry.width} height={geometry.height} vectorEffect="non-scaling-stroke" strokeWidth={1} />
      {geometry.squares.map((square, index) => <rect key={index} x={square.x} y={square.y} width={square.size} height={square.size} vectorEffect="non-scaling-stroke" strokeWidth={0.9} />)}
    </g>}
    <path d={geometry.path} fill="none" stroke="#7db7ff" strokeWidth={1.65} opacity={0.92} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
  </svg>;
}

export default GoldenComposition;
