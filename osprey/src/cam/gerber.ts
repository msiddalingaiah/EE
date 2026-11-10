// Writing Gerber files (RS-274X, with X2 file attributes): millimetres, 3.4 coordinates, as
// Eagle writes them. Apertures are collected while plotting and declared in the header.

import type { Point } from '../geom/transform';

/** Standard apertures: circle, rectangle, obround, and octagon (Eagle's OC8 macro, across flats). */
export type Aperture =
  | { t: 'C'; d: number }
  | { t: 'R'; w: number; h: number }
  | { t: 'O'; w: number; h: number }
  | { t: 'OC8'; d: number };

const num = (v: number) => (Math.round(v * 1e6) / 1e6).toFixed(6);
/** A coordinate in the file's units: 1/10 000 mm. */
const coord = (v: number) => String(Math.round(v * 10_000));
const xy = (p: Point) => `X${coord(p.x)}Y${coord(p.y)}`;

export class GerberWriter {
  private readonly apertures = new Map<string, number>();
  private readonly body: string[] = [];
  private current = -1;
  private dark = true;
  private at: Point | undefined;

  /** `attributes`: X2 file attributes, e.g. ["FileFunction,Copper,L1,Top", "FilePolarity,Positive"]. */
  constructor(private readonly name: string, private readonly attributes: string[] = []) {}

  private use(ap: Aperture): void {
    const key = ap.t === 'C' || ap.t === 'OC8' ? `${ap.t},${num(ap.d)}` : `${ap.t},${num(ap.w)}X${num(ap.h)}`;
    let code = this.apertures.get(key);
    if (code === undefined) this.apertures.set(key, (code = 10 + this.apertures.size));
    if (code !== this.current) {
      this.body.push(`D${code}*`);
      this.current = code;
    }
  }

  /** Dark (adds) or clear (removes what was plotted before). */
  polarity(dark: boolean): void {
    if (dark === this.dark) return;
    this.body.push(dark ? '%LPD*%' : '%LPC*%');
    this.dark = dark;
  }

  flash(ap: Aperture, p: Point): void {
    this.use(ap);
    this.body.push(`${xy(p)}D03*`);
    this.at = p;
  }

  private moveTo(p: Point): void {
    if (this.at && coord(this.at.x) === coord(p.x) && coord(this.at.y) === coord(p.y)) return;
    this.body.push(`${xy(p)}D02*`);
    this.at = p;
  }

  /** A polyline drawn with a round aperture of the given width. */
  stroke(pts: Point[], width: number): void {
    if (!pts.length) return;
    this.use({ t: 'C', d: width });
    this.moveTo(pts[0]!);
    if (pts.length === 1) {
      this.body.push(`${xy(pts[0]!)}D01*`);
      return;
    }
    for (const p of pts.slice(1)) {
      this.body.push(`${xy(p)}D01*`);
      this.at = p;
    }
  }

  /**
   * A circular arc from `start` sweeping `sweep` radians (positive counter-clockwise) about
   * `c`, drawn with a round aperture. A full turn draws a whole circle.
   */
  arc(c: Point, r: number, start: number, sweep: number, width: number): void {
    this.use({ t: 'C', d: width });
    const from = { x: c.x + r * Math.cos(start), y: c.y + r * Math.sin(start) };
    const to = { x: c.x + r * Math.cos(start + sweep), y: c.y + r * Math.sin(start + sweep) };
    this.moveTo(from);
    const ij = `I${coord(c.x - from.x)}J${coord(c.y - from.y)}`;
    this.body.push(sweep >= 0 ? 'G03*' : 'G02*', `${xy(to)}${ij}D01*`, 'G01*');
    this.at = to;
  }

  /** A filled polygon (G36/G37 region). */
  region(pts: Point[]): void {
    if (pts.length < 3) return;
    this.body.push('G36*');
    this.body.push(`${xy(pts[0]!)}D02*`);
    for (const p of pts.slice(1)) this.body.push(`${xy(p)}D01*`);
    this.body.push(`${xy(pts[0]!)}D01*`, 'G37*');
    this.at = pts[0];
  }

  toString(): string {
    const head = [
      'G04 Osprey Gerber RS-274X export*',
      '%TF.GenerationSoftware,Osprey,Osprey,0.1*%',
      ...this.attributes.map((a) => `%TF.${a}*%`),
      '%MOMM*%',
      '%FSLAX34Y34*%',
      '%LPD*%',
      `%IN${this.name}*%`,
      '%IPPOS*%',
      '%AMOC8*',
      '5,1,8,0,0,1.08239X$1,22.5*%',
      'G01*',
      'G75*',
    ];
    for (const [key, code] of this.apertures) head.push(`%ADD${code}${key}*%`);
    return [...head, ...this.body, 'M02*', ''].join('\n');
  }
}
