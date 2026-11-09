import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { domOf } from '../src/eagle/dom';
import { parseEagle, serializeEagle } from '../src/eagle/parse';
import type { Board, EagleFile, Element } from '../src/eagle/types';
import {
  deleteBoardTargets as deleteTargets, mirrorAbout, padPosition, rotationAbout,
  transformBoardTargets as transformTargets, translation,
} from '../src/edit/board';
import { History, Transaction } from '../src/edit/ops';
import { Project } from '../src/project/project';
import type { Target } from '../src/scene/types';

const text = readFileSync(join(__dirname, '..', 'samples', 'eagle', 'TA7358A.brd'), 'utf8');

let file: EagleFile;
let board: Board;
beforeEach(() => {
  file = parseEagle(text);
  board = file.board!;
});

const element = (name: string) => board.elements.find((e) => e.name === name)!;
const target = (el: Element): Target => ({ kind: 'element', element: el });
const signal = (name: string) => board.signals.find((s) => s.name === name)!;

/** Wire endpoints of `el`'s signals that sit exactly on one of its pads. */
function attachedEnds(el: Element): number {
  let n = 0;
  for (const s of board.signals) {
    for (const cr of s.contactrefs.filter((c) => c.element === el.name)) {
      const p = padPosition(board, el, cr.pad)!;
      for (const w of s.wires) {
        if (Math.abs(w.x1 - p.x) < 1e-4 && Math.abs(w.y1 - p.y) < 1e-4) n++;
        if (Math.abs(w.x2 - p.x) < 1e-4 && Math.abs(w.y2 - p.y) < 1e-4) n++;
      }
    }
  }
  return n;
}

describe('move', () => {
  it('moves the element in the model and the XML, dragging attached trace ends', () => {
    const c2 = element('C2');
    const n1 = signal('N$1');
    const [w0, w1] = [n1.wires[0]!, n1.wires[1]!];
    expect([w1.x2, w1.y2]).toEqual([5.461, 15.251]); // ends on C2 pad 2
    const before = attachedEnds(c2);

    const tx = new Transaction('Move');
    transformTargets(board, [target(c2)], translation(1.27, 0), tx);

    expect(c2.x).toBeCloseTo(6.731);
    expect(domOf(c2)!.getAttribute('x')).toBe('6.731');
    expect(w1.x2).toBeCloseTo(6.731); // dragged
    expect(w1.x1).toBeCloseTo(3.821); // other end stays
    expect(w0.x1).toBe(2.54); // unrelated wire untouched
    expect(attachedEnds(c2)).toBe(before);
    // Smashed name/value texts travel with the part.
    expect(domOf(c2.attributes[0]!)!.getAttribute('x')).toBe(String(Math.round((c2.attributes[0]!.x!) * 1e6) / 1e6));

    tx.revert();
    expect(serializeEagle(file)).toBe(serializeEagle(parseEagle(text)));
  });

  it('moving a trace drags the wires connected to its ends', () => {
    const n1 = signal('N$1');
    const [w0, w1] = [n1.wires[0]!, n1.wires[1]!];
    const tx = new Transaction('Move');
    transformTargets(board, [{ kind: 'signal-wire', signal: n1, wire: w0 }], translation(0, 0.635), tx);
    expect(w0.y1).toBeCloseTo(13.97 + 0.635);
    expect([w1.x1, w1.y1]).toEqual([w0.x2, w0.y2]); // shared corner followed
    expect(w1.y2).toBe(15.251); // far end stays on the pad
  });
});

describe('rotate', () => {
  it('rotates about the part origin and keeps traces attached', () => {
    const ic = element('IC1');
    const before = attachedEnds(ic);
    expect(before).toBeGreaterThan(0);
    const tx = new Transaction('Rotate');
    transformTargets(board, [target(ic)], rotationAbout({ x: ic.x, y: ic.y }, 1), tx);
    expect(ic.rot.angle).toBe(180); // was R90
    expect(domOf(ic)!.getAttribute('rot')).toBe('R180');
    expect(attachedEnds(ic)).toBe(before);
  });

  it('writes no rot attribute for R0', () => {
    const c2 = element('C2'); // R90
    const tx = new Transaction('Rotate');
    transformTargets(board, [target(c2)], rotationAbout({ x: c2.x, y: c2.y }, -1), tx);
    expect(c2.rot.angle).toBe(0);
    expect(domOf(c2)!.hasAttribute('rot')).toBe(false);
  });
});

describe('flip', () => {
  it('moves a part to the bottom side, mirroring its smashed texts', () => {
    const c2 = element('C2');
    const nameLayer = c2.attributes.find((a) => a.name === 'NAME')!.layer;
    const tx = new Transaction('Flip');
    transformTargets(board, [target(c2)], mirrorAbout(c2.x), tx);
    expect(c2.rot.mirror).toBe(true);
    expect(domOf(c2)!.getAttribute('rot')).toBe('MR90'); // mirroring an R90 part gives MR90, as in Eagle
    expect(c2.attributes.find((a) => a.name === 'NAME')!.layer).toBe(nameLayer === 25 ? 26 : nameLayer);
    tx.revert();
    expect(c2.rot).toEqual({ angle: 90, mirror: false, spin: false });
  });
});

describe('delete', () => {
  it('removes an element and its contact refs; undo restores the file exactly', () => {
    const c2 = element('C2');
    const tx = new Transaction('Delete');
    deleteTargets(board, [target(c2)], tx);
    expect(board.elements.includes(c2)).toBe(false);
    expect(board.signals.some((s) => s.contactrefs.some((c) => c.element === 'C2'))).toBe(false);
    const saved = serializeEagle(file);
    expect(saved).not.toContain('<element name="C2"');
    expect(saved).not.toContain('element="C2"');
    // Removing elements doesn't leave blank lines behind.
    expect(saved).not.toMatch(/\r\n\r\n/);

    tx.revert();
    expect(serializeEagle(file)).toBe(serializeEagle(parseEagle(text)));
  });

  it('skips locked elements', () => {
    const c2 = element('C2');
    c2.locked = true;
    const tx = new Transaction('Delete');
    deleteTargets(board, [target(c2)], tx);
    expect(tx.empty).toBe(true);
  });
});

describe('history', () => {
  it('tracks undo/redo and the saved state', () => {
    const h = new History();
    expect(h.dirty).toBe(false);
    const c2 = element('C2');
    const tx = new Transaction('Move C2');
    transformTargets(board, [target(c2)], translation(1, 0), tx);
    h.push(tx);
    expect(h.dirty).toBe(true);
    expect(h.undoLabel).toBe('Move C2');
    h.undo();
    expect(c2.x).toBe(5.461);
    expect(h.dirty).toBe(false);
    h.redo();
    expect(c2.x).toBeCloseTo(6.461);
    h.markSaved();
    expect(h.dirty).toBe(false);
    h.undo();
    expect(h.dirty).toBe(true);
    // A new edit after undoing past the save point makes the saved state unreachable.
    const tx2 = new Transaction('Move again');
    transformTargets(board, [target(c2)], translation(0, 1), tx2);
    h.push(tx2);
    h.undo();
    expect(h.dirty).toBe(true);
  });
});

function boardProject(): Project {
  const p = new Project();
  p.board = { file, name: 'TA7358A.brd' };
  return p;
}

describe('move session (Editor)', () => {
  it('snaps a part origin to the 50 mil grid and drags traces live; cancel restores', async () => {
    const { Editor } = await import('../src/app/editor');
    const ed = new Editor(boardProject(), () => {});
    const grid = (alt: boolean) => ed.grid(file, alt);
    expect(grid(false)).toBeCloseTo(1.27);
    const c2 = element('C2'); // at (5.461, 14.351): off grid
    const s = ed.beginMove([target(c2)], grid, { x: c2.x, y: c2.y }, { x: c2.x, y: c2.y })!;
    s.moveBy({ x: 2, y: 0.3 }, false);
    expect(c2.x / 1.27).toBeCloseTo(Math.round(c2.x / 1.27)); // origin now on grid
    expect(c2.y / 1.27).toBeCloseTo(Math.round(c2.y / 1.27));
    const n1 = signal('N$1');
    expect(n1.wires[1]!.x2).toBeCloseTo(padPosition(board, c2, '2')!.x); // still attached mid-move
    s.cancel();
    expect([c2.x, c2.y]).toEqual([5.461, 14.351]);
    expect(serializeEagle(file)).toBe(serializeEagle(parseEagle(text)));
    expect(ed.history.canUndo).toBe(false);
  });

  it('without a reference, snaps the displacement; rotate while moving; commit is one undo step', async () => {
    const { Editor } = await import('../src/app/editor');
    const ed = new Editor(boardProject(), () => {});
    const c2 = element('C2');
    const ic = element('IC1');
    const s = ed.beginMove([target(c2), target(ic)], (alt) => ed.grid(file, alt), { x: 0, y: 0 })!;
    s.moveBy({ x: 1.9, y: -0.2 }, false);
    expect(c2.x).toBeCloseTo(5.461 + 1.27);
    expect(c2.y).toBeCloseTo(14.351);
    s.rotate(1);
    s.commit();
    expect(ed.history.undoLabel).toBe('Move/rotate 2 objects');
    ed.undo();
    expect([c2.x, c2.y]).toEqual([5.461, 14.351]);
    expect(serializeEagle(file)).toBe(serializeEagle(parseEagle(text)));
  });
});
