# Osprey

A browser-based electronic CAD tool built around noun-verb (select, then act) editing, starting from Eagle CAD designs.

## Status

An Osprey **project** is one `.osprey` file holding a schematic and its board as a single
native model (see [docs/format.md](docs/format.md)). Eagle files are imported into it.

- **Open** an `.osprey` project, or **import** an Eagle `.sch` + `.brd` pair (select both, or
  drop both on the canvas). Eagle libraries (`.lbr`) open read-only for browsing.
- **Save** (Ctrl+S) writes one `.osprey` file: JSON in a canonical, diff-friendly layout.
  In Chromium browsers a project opened with Open… is saved in place.
- **Export Eagle…** writes the project back as an Eagle 9 `.sch` + `.brd`, with pad lists and
  airwires regenerated and the Eagle data Osprey doesn't model written back. Importing the
  exported files gives the same project again (checked on 152 real pairs).
- **Views:** schematic and board, switched with Tab or the toolbar toggle; each keeps its own
  zoom, layers and selection. Selected parts and nets carry across (cross-probing).
- **Selection** (the noun): click, Shift-click to add, Ctrl-click to toggle, box-select
  (left-to-right = fully inside; right-to-left = touching; a part counts as inside when its
  origin is). An inspector shows the selection's properties.
- **Commands** (the verbs): move (drag, or M then click), rotate (R), flip to the other board
  side / mirror in the schematic (F), delete (Del), rename part or net (N), value (V),
  smash/unsmash. Moves snap to the grid (Alt = fine grid). Undo/redo for everything.
- **Adding parts** (schematic): pick a component from the project's library, a sample library
  or any Eagle `.lbr`, then click to place each gate. The component, its symbols and
  footprints are copied into the project; the footprint is parked beside the board outline.
- **Drawing wires** (schematic): wires snap to pins and wire ends and connect what they touch.
  A wire that connects different nets joins them, and the joined net keeps the strongest name
  (a supply name, then a name you gave it, then the lowest automatic N$n). If two nets you
  named meet, you choose which name stays. Board airwires follow straight away.
- **Copy and paste** (schematic): copy a selection of parts, wiring and drawing, and paste it
  as many times as needed; each copy floats until you click to place it. Names stay unique:
  C4 becomes the next free C, RF becomes RF1, automatic nets get new numbers, named nets a
  suffix (IN → IN_2), while supply nets (GND, VCC) join the existing net. A name that is free
  is kept, so cut and paste keeps names. The clipboard holds the components the parts use,
  so a selection can be pasted into another project.
- **Routing traces** (board): start on a pad, via or trace end and the route takes its net.
  Legs bend at 45°; changing layer adds a via. The route ends on copper of the same net, and
  the airwire it replaces disappears. Width and via drill come from the net class, else the
  board's most common ones. Each leg is checked against other nets' copper and the board edge
  as you route. When the direct leg would break a clearance rule, the route goes around the
  obstacles instead (like Eagle's follow-me routing): a 45° path that keeps clear, found on a
  grid an eighth of the routing grid. If there's no way round on the current layer, it goes
  under through vias on the other layer (a via counts as 1.6 mm of trace, so one layer is
  preferred); copper only on the other layer, such as a bottom-side pad, is reached the same
  way. Where there is no way through at all, the leg shows red and isn't placed (Shift+click
  places the direct leg anyway; Shift+L a via).
- **Design-rule check** (board): the Design rules panel checks copper clearance between
  nets (Eagle's wire/pad/SMD/via distances), shorts, minimum trace width and drill, and copper
  near the board edge or holes. Problems are listed and marked on the board; clicking one zooms
  to it and selects what's involved; the list updates as you edit. Rules come from the board
  (as imported from Eagle) and can be loaded from an Eagle `.dru` file; values the file doesn't
  set are kept. Poured copper is checked too.
- **The copper layer** (board): the toolbar's **Layer** selector is the layer Route and Pour
  work on, remembered while the project is open; L switches it (with nothing active, while
  routing through a via, while drawing a pour). It follows the route when the route changes
  layer itself (starting on one-sided copper, or a detour through vias).
- **Drawing and editing pours** (board): the **Pour** button draws one: click the corners
  (45° edges; / for any angle), and click the first corner, double-click or press Enter to
  close it. The first click on copper picks the net (otherwise the last one used, or GND); L
  changes layer. A selected pour shows handles: drag a corner to move it, drag an edge's middle
  to add a corner, click a corner and press Del to remove it. Its net, layer, width, isolation,
  rank, fill, thermals and orphans are edited in the inspector.
- **Stretching drawing lines** (board, schematic): a selected line shows handles on its ends;
  drag one to move that end. The ends of other lines on the same layer that meet it move too,
  so dragging a board outline corner resizes the board and keeps the outline closed.
- **Pours are computed** (board): each polygon pour is filled as Eagle does: clear of other
  nets' copper by the larger of its isolate and the clearance rule, the edge distance inside the
  board outline, out of keep-out areas, around holes and cutouts, in rank order; the net's pads
  get thermal spokes (or connect fully with thermals off); islands that reach none of the net's
  copper are dropped (unless orphans are kept). Pours reflow after every edit (a drag reflows
  them when it ends). The **pour fill** checkbox in the Layers panel (or P) shows them filled or
  as outlines only; that's just the view, so airwires and the DRC count the copper either way.
  Not yet: hatched fill (drawn solid), and removing copper narrower than the pour's width.
- **CAM output** (board): the **CAM…** menu makes the manufacturing files as one zip: Gerber
  (RS-274X with X2 file functions) for copper, solder mask, paste, silkscreen and the board
  outline, and an Excellon drill file (plated and unplated holes merged). The built-in job writes
  the common two-layer set (`.GTL`, `.GBL`, `.GTS`, … `.GKO`, `.XLN`, the files and layers of
  JLCPCB's Eagle job); an Eagle `.cam` job file can be used instead. Pads are flashed with
  Eagle's apertures; mask openings and paste follow the stop and cream rules (vias tented below
  the via stop limit). Checked against Eagle's own CAM output for TA7358A: drill file, masks and
  paste identical, pads, vias and traces identical, outline identical; poured copper within 1%
  (see pours above). Silkscreen text is plotted in Roboto (below), where Eagle places its text
  and at the same height; text with strokes thinner than 0.15 mm, which fabs may not print
  well, is reported. Not yet: pick-and-place files.
- **Board text in Roboto**: the board view draws text from Roboto's outlines, bundled with
  Osprey, and CAM output plots the same outlines, so the screen shows exactly what is printed,
  on any computer. Size, alignment and rotation are Eagle's; a text's ratio makes it bolder
  where it asks for wider strokes than Roboto's own. (Eagle's vector font isn't used: it is
  Autodesk's design.) The schematic keeps the system's sans-serif.
- **One model, always consistent.** Each part and net is stored once. Deleting a part in
  either view removes it everywhere; board pad connections are derived from the schematic,
  so a schematic wire delete disconnects the pad on the board by itself.
- **Wires and traces follow** moved pins, pads, vias and wire ends (rubber-banding).
- **Airwires are computed** after every edit, as Eagle does, with each poured island connecting
  what it reaches. Across 152 real boards they are identical to the airwires Eagle saved for
  every net, except four nets with pours: three boards were saved with their pours unpoured, and
  one isn't explained yet. They're the shortest connections (a minimum spanning tree per net),
  recomputed live while a part is dragged. **Airwires by net** in the Layers panel shows or
  hides each net's airwires (**Hide supplies** hides GND, VCC and the like), to route signals
  without the clutter; a view choice, so DRC and CAM are unaffected.
- **Import** maps Eagle's model to Osprey's, keeps data Osprey doesn't model in a passthrough,
  and reports any disagreement between schematic and board. Verified on 152 real pairs: every
  net's derived pads match the pads Eagle stored.

Not yet: library editing, busses beyond wires, push-and-shove routing, pick-and-place files.

## Running

Requires Node.js 20+. The one runtime dependency is [clipper2-js](https://www.npmjs.com/package/clipper2-js)
(polygon clipping for pours). It declares Angular as a peer dependency without using it, so
`.npmrc` tells npm not to install peers.

Board text uses [Roboto](https://github.com/googlefonts/roboto-classic) (SIL Open Font
License, `src/scene/font-license.txt`), converted once to `src/scene/font-data.ts` by
`node scripts/build-font.mjs <roboto-latin-400-normal.woff>` (from the `@fontsource/roboto`
package); nothing is loaded at runtime.

```sh
npm install
npm run dev        # http://localhost:5173 — open a sample, or drop files on the canvas
npm test           # unit tests against the samples
npm run samples    # regenerate samples/osprey/ from samples/eagle/ (after importer changes)
npm run typecheck
npm run build
```

The app opens the `TA7358A` Osprey project by default; the Sample menu also offers the
original Eagle pair (imported on the fly) and an Eagle library. A sample can be opened by URL,
e.g. `http://localhost:5173/#TA7358A.osprey`, or `#TA7358A.osprey/board` for the board view.

To also check import, airwires and export against a folder of your own Eagle designs (every
`.sch` with a `.brd` of the same name), point `OSPREY_CORPUS` at it:

```sh
OSPREY_CORPUS=~/designs npx vitest run -t corpus
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
| Copy / cut / paste (schematic) | Ctrl+C / Ctrl+X / Ctrl+V; click places the paste, `R`/`F` while floating, Esc cancels |
| Copper layer for Route and Pour (board) | Layer selector in the toolbar, or `L` |
| Draw a pour (board) | Pour button; click corners, click the first corner / double-click / Enter closes, `L` layer, `/` any angle, Esc cancels |
| Edit a pour's outline (board) | Select it; drag a corner, drag an edge's middle to add a corner, click a corner then Del to remove it |
| Stretch a drawing line, e.g. resize the board outline | Select the line; drag a handle on its end (lines meeting there follow) |
| Show / hide pour fill (board) | `P`, or the pour fill checkbox in the Layers panel |
| Design-rule check (board) | Design rules panel: Check; Load rules… for a `.dru` file; click a problem to zoom to it |
| Route traces (board) | `W` or the Route button; click a pad, via or trace end to start, click adds corners, `L` changes layer (adds a via), `/` flips the bend, Shift+click / Shift+L place a leg or via that breaks clearance; ends on copper of the same net, or with a double click, Esc or right-click; Esc again stops |
| Draw wires (schematic) | `W` or the Wire button; click to start, click adds a corner, `/` flips the bend; a wire ends on a pin or wire, or with a double click, Esc or right-click; Esc again stops |
| Add part (schematic) | `A` to search, choose a component, Place (or Enter); click places each gate, `R`/`F` while placing, Esc or right-click stops |
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
- `samples/osprey/`: native sample projects (`.osprey`), kept equal to imports of the Eagle samples
- `samples/eagle/`: sample Eagle files (`.sch`, `.brd`, `.lbr`)
- `src/model/`: the native project model (`types.ts`), `.osprey` reading and writing
  (`file.ts`), Eagle import and export (`import-eagle.ts`, `export-eagle.ts`, `passthrough.ts`, `layers.ts`), derived facts
  such as net pads (`derive.ts`), geometry (`geometry.ts`), the ratsnest (`ratsnest.ts`), design
  rules (`rules.ts`), board copper as geometry (`copper.ts`), poured copper (`pour.ts`) and the
  design-rule check (`drc.ts`)
- `src/eagle/`: Eagle XML parser and writer (`parse.ts`, `types.ts`), used by import and export
- `src/edit/`: undoable operations and history (`ops.ts`), move/rotate/mirror with
  rubber-banding (`transform.ts`), delete (`delete.ts`), property edits (`properties.ts`) and
  adding parts (`place.ts`), wires, which join nets (`wire.ts`), pours (`pours.ts`), copy and paste (`clipboard.ts`),
  routing traces (`route.ts`, with `walkaround.ts` finding paths around obstacles) and loading
  design rules (`rules.ts`)
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
