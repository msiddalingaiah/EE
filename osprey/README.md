# Osprey

A browser-based electronic CAD tool built around noun-verb (select, then act) editing, starting from Eagle CAD designs.

## Status

Milestone 1 — **Eagle viewer with selection**:

- Parses Eagle 6+ XML schematics (`.sch`), boards (`.brd`) and libraries (`.lbr`) into a typed model.
- Renders schematics (symbols, pins, pad numbers, nets, junctions, labels, smashed attributes),
  boards (footprints, through-hole and SMD pads, traces, arcs, vias, drills, holes, polygon outlines,
  bottom-side mirroring) and individual library symbols, packages and device sets.
- Eagle layer colours and fill patterns; per-layer visibility.
- Selection (the "noun" half): click, Shift-click to add, Ctrl-click to toggle, box-select
  (left-to-right = fully inside, right-to-left = touching), Ctrl+A, Esc. An inspector shows
  the properties of the selection. Clicking inside a part's body selects the part.

Not yet: editing commands (the "verbs"), polygon pour computation (outlines only), Eagle's vector
font (text uses a system sans-serif), multiple-sheet navigation beyond a sheet selector, busses beyond wires.

## Running

Requires Node.js 20+.

```sh
npm install
npm run dev        # http://localhost:5173 — open a sample or drop an Eagle file on the canvas
npm test           # unit tests (parser, geometry, scene building, hit testing) against the samples
npm run typecheck
npm run build
```

A sample can be opened directly by URL: `http://localhost:5173/#TA7358A.brd`.

### Controls

| Action | Input |
| --- | --- |
| Select / add / toggle | Click / Shift-click / Ctrl-click |
| Box select | Drag (left-to-right: inside, right-to-left: crossing) |
| Pan | Right- or middle-drag, or Space + drag |
| Zoom | Mouse wheel (about the cursor) |
| Fit | `F` or Home |
| Select all / clear | Ctrl+A / Esc |

## Layout

- `samples/eagle/`: sample Eagle files (`.sch`, `.brd`, `.lbr`) used for parser and renderer development
- `src/eagle/`: Eagle XML model (`types.ts`) and parser (`parse.ts`)
- `src/geom/`: affine transforms (Eagle rotations/mirroring) and arc geometry
- `src/scene/`: turns a design into a flat list of drawable primitives in world space (mm, y-up),
  each tagged with its **owner**, the selectable object. `schematic.ts`, `board.ts`, `library.ts`,
  with shared `builder.ts` (graphics, pads, text readability) and `symbol.ts` (symbols and pins)
- `src/view/`: Canvas2D renderer, viewport (pan/zoom), hit testing, palette and fill patterns
- `src/app/selection.ts`: the selection set that commands will operate on
- `src/main.ts`: application shell (panels, file loading, pointer and keyboard handling)
- `test/`: Vitest suites

## Design notes

- **Owners are the nouns.** Every primitive belongs to one owner (a part instance, net wire,
  element, trace, via, …). Picking and box selection resolve to owners; commands will act on them.
- **Coordinates** stay in Eagle's units (mm, y-up) end to end; only the renderer flips to screen space.
- **Eagle rules reproduced:** rotations are mirror-then-rotate; text is kept readable (turned 180°
  with alignment flipped unless it has the spin flag); mirrored schematic text is drawn unmirrored;
  bottom-side board parts swap paired layers (1↔16, 21↔22, …); automatic pad and via diameters
  come from the board's design rules (restring ratio clamped to min/max).
