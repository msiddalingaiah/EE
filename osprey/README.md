# Osprey

A browser-based electronic CAD tool built around noun-verb (select, then act) editing, starting from Eagle CAD designs.

## Status

Milestone 2 — **board editing**:

- Commands act on the selection (noun, then verb): **move** (drag a selected object, or press
  M and click to place), **rotate** (R / Shift+R), **flip** to the other side of the board (F),
  **delete** (Del). Rotation and flip can also be applied while moving.
- Moves snap to the board's grid (Alt = alternate grid): a part's origin, or a trace's grabbed
  end, lands on the grid. Traces attached to moved pads, vias and trace ends follow (rubber-band).
- Undo/redo (Ctrl+Z / Ctrl+Y), with the affected objects reselected. Locked parts are left in place.
- **Lossless save** (Ctrl+S): the original XML is kept and only edited attributes change, so
  everything Osprey doesn't model (design rules, attributes, variants, CAM settings, 3D links…)
  is written back untouched. Unedited files round-trip unchanged. In Chromium browsers, files
  opened with Open… are saved in place; otherwise Save downloads the file.

Milestone 1 — **Eagle viewer with selection**:

- Parses Eagle 6+ XML schematics (`.sch`), boards (`.brd`) and libraries (`.lbr`) into a typed model.
- Renders schematics (symbols, pins, pad numbers, nets, junctions, labels, smashed attributes),
  boards (footprints, through-hole and SMD pads, traces, arcs, vias, drills, holes, polygon outlines,
  bottom-side mirroring) and individual library symbols, packages and device sets.
- Eagle layer colours and fill patterns; per-layer visibility.
- Selection (the "noun" half): click, Shift-click to add, Ctrl-click to toggle, box-select
  (left-to-right = fully inside, right-to-left = touching), Ctrl+A, Esc. An inspector shows
  the properties of the selection. Clicking inside a part's body selects the part.

Not yet: schematic editing, schematic/board consistency (forward/back annotation), routing new
traces, polygon pour computation (outlines only), Eagle's vector font (text uses a system
sans-serif), multiple-sheet navigation beyond a sheet selector, busses beyond wires.

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
| Box select | Drag on empty space (left-to-right: inside, right-to-left: crossing) |
| Move | Drag a selected object, or `M` then click to place (right-click or Esc cancels) |
| Rotate 90° | `R` (Shift+R clockwise), also while moving |
| Flip to other side | `F`, also while moving |
| Delete | Del / Backspace |
| Fine grid while moving | Hold Alt |
| Undo / redo | Ctrl+Z / Ctrl+Y (or Ctrl+Shift+Z) |
| Save | Ctrl+S |
| Pan | Right- or middle-drag, or Space + drag |
| Zoom | Mouse wheel (about the cursor) |
| Fit | Home |
| Select all / clear | Ctrl+A / Esc |

## Layout

- `samples/eagle/`: sample Eagle files (`.sch`, `.brd`, `.lbr`) used for parser and renderer development
- `src/eagle/`: Eagle XML model (`types.ts`), parser and serializer (`parse.ts`), and the
  model-to-XML links that make lossless saving possible (`dom.ts`)
- `src/edit/`: undoable operations and transactions (`ops.ts`), board commands (`board.ts`)
- `src/geom/`: affine transforms (Eagle rotations/mirroring) and arc geometry
- `src/scene/`: turns a design into a flat list of drawable primitives in world space (mm, y-up),
  each tagged with its **owner**, the selectable object. `schematic.ts`, `board.ts`, `library.ts`,
  with shared `builder.ts` (graphics, pads, text readability) and `symbol.ts` (symbols and pins)
- `src/view/`: Canvas2D renderer, viewport (pan/zoom), hit testing, palette and fill patterns
- `src/app/`: the selection set, the editor (commands, move sessions, history) and file open/save
- `src/main.ts`: application shell (panels, file loading, pointer and keyboard handling)
- `test/`: Vitest suites

## Design notes

- **Owners are the nouns.** Every primitive belongs to one owner (a part instance, net wire,
  element, trace, via, …). Picking and box selection resolve to owners; commands will act on them.
- **Coordinates** stay in Eagle's units (mm, y-up) end to end; only the renderer flips to screen space.
- **Edits change model and XML together.** Each parsed object is linked to its XML element; an
  edit is a list of operations that update both and know how to revert. Saving serializes the
  retained document in Eagle's style (attribute order, `<x/>`, escaping, CRLF, prolog).
- **Eagle rules reproduced:** `MRθ` means rotate by θ, then mirror (verified against 1,100+
  routed pad connections on real boards); text is kept readable (turned 180°
  with alignment flipped unless it has the spin flag); mirrored schematic text is drawn unmirrored;
  bottom-side board parts swap paired layers (1↔16, 21↔22, …); automatic pad and via diameters
  come from the board's design rules (restring ratio clamped to min/max).
