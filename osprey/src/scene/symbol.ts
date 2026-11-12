// Drawing of schematic symbols and their pins (native model).

import type { Transform } from '../geom/transform';
import { compose, composeRotation, placement } from '../geom/transform';
import { rotation } from '../model/geometry';
import type * as O from '../model/types';
import { readableText, type EmitContext, type SceneBuilder } from './builder';

const PIN_LENGTH = { point: 0, short: 2.54, middle: 5.08, long: 7.62 } as const;
const PIN_LINE_WIDTH = 0.1524;
const PIN_NAME_SIZE = 1.778;
const PIN_PAD_SIZE = 1.27;
const PIN_NAME_GAP = 1.016;
const PAD_OFFSET = 0.254;
const DOT_RADIUS = 0.635;
export const SYMBOL_LAYER = 'symbols';
const SYMBOL_LAYER_NUMBER = 94;

/**
 * Emit a symbol's graphics and pins under transform T.
 * `padsByPin` maps pin names to their connected pad names (shown as pad numbers).
 * `substitute` resolves placeholder texts; returning undefined hides the text.
 */
export function buildSymbolInto(
  b: SceneBuilder, sym: O.Symbol, T: Transform, owner: string,
  padsByPin: Map<string, string>, substitute: (t: string) => string | undefined,
): void {
  b.graphics(sym.graphics, { owner, transform: T, textContext: 'schematic', substitute });
  for (const pin of sym.pins) emitPin(b, pin, padsByPin.get(pin.name) ?? '', T, owner);
}

/** Emit one pin (its line, decorations, name and pad numbers) under the parent transform. */
export function emitPin(b: SceneBuilder, pin: O.Pin, pads: string, parent: Transform, owner: string): void {
  const T = compose(parent, placement(pin.at[0], pin.at[1], rotation(pin.rot, false)));
  const ctx: EmitContext = { owner, transform: T, textContext: 'schematic' };
  const len = PIN_LENGTH[pin.length ?? 'long'];
  const fn = pin.function;
  const dot = fn === 'dot' || fn === 'dotclock';
  const clk = fn === 'clock' || fn === 'dotclock';

  if (len > 0) {
    const lineEnd = dot ? len - 2 * DOT_RADIUS : len;
    if (lineEnd > 0) b.line(line(0, 0, lineEnd, 0), SYMBOL_LAYER, ctx);
    if (dot) b.graphic({ circle: [len - DOT_RADIUS, 0], radius: DOT_RADIUS, width: PIN_LINE_WIDTH, layer: SYMBOL_LAYER }, ctx);
    if (clk) {
      b.line(line(len, 0.75, len + 1.5, 0), SYMBOL_LAYER, ctx);
      b.line(line(len + 1.5, 0, len, -0.75), SYMBOL_LAYER, ctx);
    }
  }

  if (len === 0) return;
  const visible = pin.visible ?? 'both';
  const noRot = rotation(0, false);
  if (visible === 'pin' || visible === 'both') {
    // A suffix after "@" makes pin names unique (e.g. "GND@2") and is not displayed.
    const name = pin.name.replace(/@.*$/, '');
    b.text(name, len + PIN_NAME_GAP + (clk ? 1.5 : 0), 0, PIN_NAME_SIZE, noRot, 'center-left', SYMBOL_LAYER_NUMBER, ctx);
  }
  if ((visible === 'pad' || visible === 'both') && pads !== '') {
    // Pad numbers sit above horizontal pins (left of vertical ones) whichever way the pin points.
    // Text that gets turned 180° for readability is anchored on the other side so it lands there.
    const flips = readableText(composeRotation(T, noRot), 'bottom-center', 'schematic').align.startsWith('top');
    b.text(pads, len / 2, flips ? -PAD_OFFSET : PAD_OFFSET, PIN_PAD_SIZE, noRot,
      flips ? 'top-center' : 'bottom-center', SYMBOL_LAYER_NUMBER, ctx);
  }
}

function line(x1: number, y1: number, x2: number, y2: number) {
  return { line: [[x1, y1], [x2, y2]] as [O.Pt, O.Pt], width: PIN_LINE_WIDTH };
}
