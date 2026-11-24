// Connect a bare pin to a net by name: a short wire out from the pin, away from its symbol,
// labelled with the net's name. How an agent wires a copied subcircuit's port to an MCU pin
// (copy=Oscillator,CLK=CLKIN then connect=U2.PA3,CLKIN) without drawing a route.

import { ProjectIndex } from '../model/derive';
import { pinPosition } from '../model/geometry';
import type * as O from '../model/types';
import type { Transaction } from './ops';
import { renameNet } from './properties';
import { addWire, sheetPins, touchAt } from './wire';

const G = 2.54;

/** A pin of a part, by name: "PA3/EXTCLK" or one of its slash-separated names ("PA3", "UPDI"); a gate when parts have several. */
export function findPin(project: O.Project, ref: string, index = new ProjectIndex(project)): { sheet: O.Sheet; gate: O.GatePlacement; pin: O.Pin } | string {
  const dot = ref.indexOf('.');
  if (dot < 1) return `${ref}: give <part>.<pin>`;
  const partName = ref.slice(0, dot);
  const part = index.parts.get(partName) ?? project.parts.find((p) => p.name.toLowerCase() === partName.toLowerCase());
  if (!part) return `No part ${partName}`;
  const component = index.components.get(part.component)!;
  let rest = ref.slice(dot + 1);
  // part.gate.pin, when the gate is named
  let gates = component.gates;
  const g2 = rest.indexOf('.');
  if (g2 > 0 && gates.some((g) => g.name === rest.slice(0, g2))) {
    gates = gates.filter((g) => g.name === rest.slice(0, g2));
    rest = rest.slice(g2 + 1);
  }
  const norm = (s: string) => s.replace(/!/g, '').toLowerCase();
  const found: { gate: O.Gate; pin: O.Pin }[] = [];
  for (const exact of [true, false]) {
    for (const g of gates) {
      for (const pin of index.symbols.get(g.symbol)?.pins ?? []) {
        const hit = exact ? norm(pin.name) === norm(rest) : norm(pin.name).split('/').includes(norm(rest));
        if (hit) found.push({ gate: g, pin });
      }
    }
    if (found.length) break;
  }
  if (!found.length) return `${part.name} has no pin ${rest}`;
  if (found.length > 1) return `${part.name}.${rest} is ambiguous: ${found.map((f) => `${part.name}.${f.gate.name}.${f.pin.name}`).join(', ')}`;
  const { gate, pin } = found[0]!;
  for (const sheet of project.schematic?.sheets ?? []) {
    const placed = sheet.gates.find((g) => g.part === part.name && g.gate === gate.name);
    if (placed) return { sheet, gate: placed, pin };
  }
  return `${part.name} gate ${gate.name} isn't on a sheet`;
}

/** Which way a pin's wire leaves the symbol (a unit step), from the pin's and its gate's rotation. */
function outward(pin: O.Pin, gate: O.GatePlacement): O.Pt {
  const r = (pin.rot ?? 0) + (gate.rot ?? 0);
  const a = (((gate.mirror ? 180 - r : r) % 360) + 360) % 360;
  // The pin's line points into the body; its free end faces the other way.
  return a === 0 ? [-1, 0] : a === 90 ? [0, -1] : a === 180 ? [1, 0] : [0, 1];
}

/**
 * Wire a pin to a net (one transaction): a stub out from the pin (7.62 mm, longer when that end
 * would touch something), then the stub's net renamed to `net`, joining a net of that name.
 */
export function wirePinToNet(project: O.Project, ref: string, net: string, tx: Transaction): { pin: string; net: string } | string {
  const index = new ProjectIndex(project);
  const found = findPin(project, ref, index);
  if (typeof found === 'string') return found;
  const { sheet, gate, pin } = found;
  const name = `${gate.part}.${pin.name}`;
  const on = project.nets.find((n) => (n.segments ?? []).some((s) => s.pins.some((r) => r.part === gate.part && r.gate === gate.gate && r.pin === pin.name)));
  if (on) return `${name} is on ${on.name} already`;
  const at = pinPosition(index, gate, pin.name);
  if (!at) return `${name}: no position`;
  const d = outward(pin, gate);
  const pins = sheetPins(project, sheet, index);
  const free = (p: O.Pt) => {
    const t = touchAt(project, sheet, p, pins);
    return !t.segments.length && !t.pins.length;
  };
  const from: O.Pt = [at.x, at.y];
  let end: O.Pt | undefined;
  for (let k = 3; k <= 8 && !end; k++) {
    const p: O.Pt = [Math.round((at.x + d[0] * k * G) * 1e6) / 1e6, Math.round((at.y + d[1] * k * G) * 1e6) / 1e6];
    if (free(p)) end = p;
  }
  if (!end) return `${name}: no free spot for a wire out of it`;
  const w = addWire(project, sheet, [from, end], tx, { index });
  if (!w || 'choose' in w) return `${name}: the wire couldn't be added`;
  if (w.net !== net) {
    const err = renameNet(project, w.net, net, tx);
    if (err) return `${name}: ${err}`;
  }
  return { pin: name, net: project.nets.find((n) => n.name.toLowerCase() === net.toLowerCase())?.name ?? net };
}
