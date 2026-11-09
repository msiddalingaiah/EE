# Osprey

A browser-based electronic CAD tool built around noun-verb (select, then act) editing, starting from Eagle CAD designs.

## Status

An Osprey **project** is one `.osprey` file holding a schematic and its board as a single
native model (see [docs/format.md](docs/format.md)). Eagle files are imported into it.

- **Open** an `.osprey` project, or **import** an Eagle `.sch` + `.brd` pair (select both, or
  drop both on the canvas). Eagle libraries (`.lbr`) open read-only for browsing.
- **Save** (Ctrl+S) writes one `.osprey` file: JSON in a canonical, diff-friendly layout.
  In Chromium browsers a project opened with Open… is saved in place.
- **Views:** schematic and board, switched with Tab or the toolbar toggle; each keeps its own
  zoom, layers and selection. Selected parts and nets carry across (cross-probing).
- **Selection** (the noun): click, Shift-click to add, Ctrl-click to toggle, box-select
  (left-to-right = fully inside; right-to-left = touching; a part counts as inside when its
  origin is). An inspector shows the selection's properties.
- **Commands** (the verbs): move (drag, or M then click), rotate (R), flip to the other board
  side / mirror in the schematic (F), delete (Del), rename part or net (N), value (V),
  smash/unsmash. Moves snap to the grid (Alt = fine grid). Undo/redo for everything.
- **One model, always consistent.** Each part and net is stored once. Deleting a part in
  either view removes it everywhere; board pad connections are derived from the schematic,
  so a schematic wire delete disconnects the pad on the board by itself.
- **Wires and traces follow** moved pins, pads, vias and wire ends (rubber-banding).
- **Airwires are computed** after every edit, as Eagle does (identical to Eagle's for every net
  without a pour, across 153 real boards).
- **Import** maps Eagle's model to Osprey's, keeps data Osprey doesn't model in a passthrough,
  and reports any disagreement between schematic and board. Verified on 152 real pairs: every
  net's derived pads match the pads Eagle stored.

Not yet: Eagle export, routing new traces, placing parts, drawing wires, joining nets,
library editing, polygon pour computation (outlines only; airwires treat a pour as its whole
outline), Eagle's vector font (text uses a system sans-serif), busses beyond wires.

## Running

Requires Node.js 20+.

```sh
npm install
npm run dev        # http://localhost:5173 — open a sample, or drop files on the canvas
npm test           # unit tests against the samples
npm run typecheck
npm run build
```

A sample can be opened directly by URL: `http://localhost:5173/#TA7358A` (or `#TA7358A.brd`
for the board view).

To also check the importer and airwires against a folder of your own Eagle designs (every
`.sch` with a `.brd` of the same name), point `OSPREY_CORPUS` at it:

```sh
OSPREY_CORPUS=~/designs npx vitest run test/model.test.ts -t corpus
```

### Controls

| Action | Input |
| --- | --- |
| Select / add / toggle | Click / Shift-click / Ctrl-click |
| Box select | Drag on empty space (left-to-right: inside, right-to-left: crossing) |
| Move | Drag a selected object, or `M` then click to place (right-click or Esc cancels) |
| Rotate 90° | `R` (Shift+R clockwise), also while moving |
| Flip to other side (board) / mirror (schematic) | `F`, also while moving |
| Delete | Del / Backspace |
| Edit name / net name, value | `N`, `V` (Enter applies, Esc cancels) |
| Fine grid while moving | Hold Alt |
| Undo / redo | Ctrl+Z / Ctrl+Y (or Ctrl+Shift+Z) |
| Save | Ctrl+S |
| Pan | Right- or middle-drag, or Space + drag |
| Zoom | Mouse wheel (about the cursor) |
| Fit | Home |
| Select all / clear | Ctrl+A / Esc |
| Switch schematic / board | Tab, or the toolbar toggle |

## Layout

- `docs/format.md`: the `.osprey` project format
- `samples/eagle/`: sample Eagle files (`.sch`, `.brd`, `.lbr`)
- `src/model/`: the native project model (`types.ts`), `.osprey` reading and writing
  (`file.ts`), Eagle import (`import-eagle.ts`, `passthrough.ts`, `layers.ts`), derived facts
  such as net pads (`derive.ts`), geometry (`geometry.ts`) and the ratsnest (`ratsnest.ts`)
- `src/eagle/`: Eagle XML parser (`parse.ts`, `types.ts`), used by import
- `src/edit/`: undoable operations and history (`ops.ts`), move/rotate/mirror with
  rubber-banding (`transform.ts`), delete (`delete.ts`) and property edits (`properties.ts`)
- `src/scene/`: turns the model into drawable primitives in world space (mm, y-up), each tagged
  with its **owner**, the selectable object: `schematic.ts`, `board.ts`, `library.ts`, with
  shared `builder.ts` (graphics, pads, text) and `symbol.ts` (symbols and pins)
- `src/view/`: Canvas2D renderer, viewport, hit testing, layer palette and fill patterns
- `src/project/consistency.ts`: schematic/board consistency check, used to report on imports
- `src/app/`: selection, the editor (commands, move sessions, history), file open/save
- `src/main.ts`: application shell (panels, file handling, pointer and keyboard)
- `test/`: Vitest suites

## Design notes

- **Owners are the nouns.** Every primitive belongs to one owner (a gate, a footprint, a wire,
  a trace, a via, …). Picking and box selection resolve to owners; commands act on their targets.
- **One source of truth.** Schematic and board share one model; what Eagle stores twice
  (parts, libraries, board pad connections) is stored once or derived.
- **Coordinates** are millimetres, y-up, end to end; only the renderer flips to screen space.
- **Edits** are lists of small operations on the model that know how to revert; undo is
  checked against the saved `.osprey` text.
- **Eagle rules reproduced:** `MRθ` means rotate by θ, then mirror (verified against 1,100+
  routed pad connections on real boards); text is kept readable (turned 180° with alignment
  flipped unless it has the spin flag); mirrored schematic text is drawn unmirrored;
  bottom-side parts swap paired layers; automatic pad and via diameters come from the design
  rules; generated values (`74*151` + LS + D → `74LS151D`); implicit power pins.
