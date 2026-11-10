// Writing an Excellon drill file: metric, 3.3 coordinates with leading zeros suppressed, tools
// numbered from the largest drill down, as Eagle writes it. Plated and unplated holes are merged.

import type { Point } from '../geom/transform';

export interface Drill {
  at: Point;
  /** Diameter (mm). */
  d: number;
  plated: boolean;
}

const coord = (v: number) => String(Math.round(v * 1000));

export function writeExcellon(drills: Drill[]): string {
  const bySize = new Map<string, Drill[]>();
  for (const h of drills) {
    const key = h.d.toFixed(3);
    let list = bySize.get(key);
    if (!list) bySize.set(key, (list = []));
    list.push(h);
  }
  const sizes = [...bySize.keys()].sort((a, b) => Number(b) - Number(a));
  const out = ['M48', ';GenerationSoftware,Osprey,Osprey,0.1', 'FMAT,2', 'ICI,OFF', 'METRIC,TZ,000.000'];
  for (let i = sizes.length - 1; i >= 0; i--) out.push(`T${i + 1}C${sizes[i]}`);
  out.push('%', 'G90', 'M71');
  sizes.forEach((s, i) => {
    out.push(`T${i + 1}`);
    for (const h of bySize.get(s)!) out.push(`X${coord(h.at.x)}Y${coord(h.at.y)}`);
  });
  out.push('M30', '');
  return out.join('\n');
}
