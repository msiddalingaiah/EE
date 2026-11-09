// Eagle layer fill styles (0 = empty, 1 = solid, 2..15 = hatches/dots), as canvas patterns.

const TILE = 8;
const cache = new Map<string, CanvasPattern | null>();

/**
 * A pattern for an Eagle fill style in the given colour, in device pixels.
 * Returns 'solid' for style 1, 'none' for style 0, or the pattern for the rest.
 */
export function fillPattern(
  ctx: CanvasRenderingContext2D, style: number, color: string,
): CanvasPattern | 'solid' | 'none' {
  if (style === 1) return 'solid';
  if (style === 0) return 'none';
  const key = `${style}:${color}`;
  let pat = cache.get(key);
  if (pat === undefined) {
    pat = makePattern(ctx, style, color);
    cache.set(key, pat);
  }
  return pat ?? 'solid';
}

function makePattern(ctx: CanvasRenderingContext2D, style: number, color: string): CanvasPattern | null {
  const c = document.createElement('canvas');
  c.width = c.height = TILE;
  const g = c.getContext('2d');
  if (!g) return null;
  g.strokeStyle = g.fillStyle = color;
  g.lineWidth = 1;
  const line = (x1: number, y1: number, x2: number, y2: number, w = 1) => {
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
    g.stroke();
  };
  const slash = (w: number) => {
    line(0, TILE, TILE, 0, w);
    line(-TILE / 2, TILE / 2, TILE / 2, -TILE / 2, w);
    line(TILE / 2, TILE * 1.5, TILE * 1.5, TILE / 2, w);
  };
  const backslash = (w: number) => {
    line(0, 0, TILE, TILE, w);
    line(-TILE / 2, TILE / 2, TILE / 2, TILE * 1.5, w);
    line(TILE / 2, -TILE / 2, TILE * 1.5, TILE / 2, w);
  };
  const dots = (step: number, size: number) => {
    for (let y = 0; y < TILE; y += step) for (let x = 0; x < TILE; x += step) g.fillRect(x, y, size, size);
  };

  switch (style) {
    case 2: line(0, 0.5, TILE, 0.5); break; // line
    case 3: slash(1); break; // light slash
    case 4: slash(2); break; // slash
    case 5: backslash(2); break; // backslash
    case 6: backslash(1); break; // light backslash
    case 7: line(0, 0.5, TILE, 0.5); line(0.5, 0, 0.5, TILE); break; // hatch
    case 8: slash(1); backslash(1); break; // cross-hatch
    case 9: line(0, 0.5, TILE, 0.5); line(0.5, 0, 0.5, TILE / 2); line(TILE / 2 + 0.5, TILE / 2, TILE / 2 + 0.5, TILE); break; // interleave
    case 10: dots(4, 1); break; // wide dot
    case 11: dots(2, 1); break; // close dot
    default: dots(Math.max(2, style - 10), 1); break; // stipples 12..15
  }
  return ctx.createPattern(c, 'repeat');
}
