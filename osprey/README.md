# Osprey

A browser-based electronic CAD tool built around noun-verb (select, then act) editing, starting from Eagle CAD designs.

## Status

An Osprey **project** is one `.osprey` file holding a schematic and its board as a single
native model (see [docs/format.md](docs/format.md)). Eagle files are imported into it.

- **Open** an `.osprey` project, or **import** an Eagle `.sch` + `.brd` pair (select both, or
  drop both on the canvas).
- **Save** (Ctrl+S) writes one `.osprey` file: JSON in a canonical, diff-friendly layout.
  In Chromium browsers a project opened with Open… is saved in place.
- **Libraries:** open an Osprey library (`.ospreylib`), or import an Eagle library (`.lbr`);
  Save writes an `.ospreylib` (the same canonical JSON) and Export Eagle writes an `.lbr`.
  The Library panel lists components, symbols or footprints (tabs, with counts), filtered by
  name or description. A component links to its gates' symbols and its variants' footprints,
  and a symbol or footprint to the components that use it.
- **Duplicating and copying** (library): **Duplicate** (in the inspector) copies the open item
  as NAME-2; a duplicated component uses the same symbols and footprints. **Copy from…** (Library
  panel) lists another library's items, or a project's library (projects imported from Eagle
  often hold parts in no `.lbr`), to click and copy into the open library, renamed to its name
  ("madhu/DIODE" → "mine/DIODE"). A component brings its symbols and footprints; an item already
  here with the same content is reused, and a different one of the same name is copied as NAME-2
  rather than overwritten.
- **Editing symbols and footprints** (library): pins, pads, lines, shapes and text are objects
  of their own, selected, moved (symbols on a 0.1 inch grid, footprints on 0.635 mm; Alt for the
  fine grid), rotated, mirrored and deleted as on a sheet or board, with undo. The inspector
  changes a pin's name, direction, length, function, visibility, swap level and position, and
  a pad's name, size and roundness (SMD) or drill, diameter and shape, position and rotation.
  Renaming or deleting a pin or pad updates the pin-to-pad maps of the library's components
  that use it, so the library stays consistent.
- **Drawing symbols and footprints** (library): **New library** starts an empty one; **+ Symbol**
  and **+ Footprint** add items, named in the inspector (as is the library). The toolbar's tools
  add pins (named P$1, P$2…, pointing in toward the origin), through-hole and SMD pads
  (numbered 1, 2…), lines (click the corners; double-click, Enter or Esc ends), rectangles,
  circles and text (`>NAME` and `>VALUE` show a part's). Each tool keeps placing until Esc.
  The inspector sets a graphic's layer, width, radius, text and size, and where it is.
- **Editing components** (library): **+ Component** adds one. Its gates (the symbols a part is
  drawn with) are objects on the canvas, added from the inspector, dragged into place, renamed,
  given an add level and swap level, and deleted. The inspector sets the prefix (R, U), whether
  the value is typed per part, and the description; and per variant (package option) its name,
  footprint (or none, for a supply symbol), and the pin-to-pad map: type each pin's pads ("1",
  or "4, 8" for a pin on two pads). A pad belongs to one pin. **Connect the rest** connects
  pins left open to free pads: the pad of the same name, else the next in order. Renaming a gate
  or changing a footprint keeps the map consistent. A component whose value is its name (a chip,
  a transistor) can have a default **LCSC part** number per variant (and technology), which its
  parts use unless they have their own; it is stored as a technology attribute, as Eagle keeps
  MF and MPN. Components with typed values (resistors) take the number on each part instead.
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
- **Adding parts** (schematic): pick a component from the project's library, a sample library,
  an Osprey `.ospreylib` or any Eagle `.lbr`, then click to place each gate. The component, its symbols and
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
  Legs bend at 45°; changing layer adds a via. Corners snap to the grid, except that a grid line
  within half a step of a pad of the net moves onto the pad's row or column, so a pad off the
  grid can be reached with a straight last leg. The route ends on copper of the same net, and
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
  near the board edge or holes, an outline left open (ends that don't meet), and lists every airwire left as unrouted (a board passes only
  when it is fully connected). Problems are listed; clicking one marks it on the board and selects
  what's involved (the view stays put), clicking it again unmarks it, and only the problems
  chosen are marked. The list updates as you edit. Rules come from the board
  (as imported from Eagle) and can be loaded from an Eagle `.dru` file; values the file doesn't
  set are kept. Poured copper is checked too.
- **Electrical rule check** (schematic): the Electrical rules panel finds what the board's DRC
  can't see. Errors: outputs driving each other or an open-collector output, an output driving
  a supply, different supplies joined, a pin on two nets. Warnings: unconnected pins, nets with
  a single pin (or wires and no pins), nets that only inputs listen to, wired not-connect pins,
  power pins that nothing supplies, pins a net lists that no wire reaches, pins touching a wire
  they aren't connected to, and parts missing from the board. Clicking a problem shows its
  sheet, marks it and selects what's involved; the list updates as you edit. **Approve**
  accepts a problem as it is (an unused pin, say): it is saved with the project, moves to the
  Approved list (where Unapprove brings it back) and no longer counts.
- **The copper layer** (board): the toolbar's **Layer** selector is the layer Route and Pour
  work on, remembered while the project is open; L switches it (with nothing active, while
  routing through a via, while drawing a pour). It follows the route when the route changes
  layer itself (starting on one-sided copper, or a detour through vias).
- **Text** (board and schematic): the **Text** button (or T) places a text where you click and
  opens its text field to type into (Shift+Enter starts a new line; Enter applies). On a sheet
  it goes on the info layer at 1.778 mm, for notes. On the board it goes on the top silkscreen, or the bottom one (mirrored, to
  read from below) when the layer is bottom; F flips it to the other side. The inspector sets
  the text, size, ratio (stroke width as a percentage of the size: the default 1.27 mm at 15% gives
  0.19 mm strokes), rotation, layer (silkscreen, document, fab) and position. Text is plotted into
  the silkscreen Gerbers; strokes thinner than 0.15 mm are reported when making CAM files.
- **Drawing and editing pours** (board): the **Pour** button draws one: click the corners
  (45° edges; / for any angle), and click the first corner, double-click or press Enter to
  close it. The first click on copper picks the net (otherwise the last one used, or GND); L
  changes layer. A selected pour shows handles: drag a corner to move it, drag an edge's middle
  to add a corner, click a corner and press Del to remove it; the inspector lists the corners as
  x, y in mm, to type a position exactly. Its net, layer, width, isolation,
  rank, fill, thermals and orphans are edited in the inspector.
- **Placing vias** (board): the **Via** button places vias one click at a time (each its own
  undo step), e.g. to stitch a ground pour. A via takes the net of the copper under it (pad,
  trace, via or poured copper), else the last via's net, else GND; it snaps onto pads, vias and
  trace ends. The drill is the net class's, else the board's usual one, else 0.35 mm (13.8 mil:
  what most Eagle boards use). A via that breaks clearance is refused; Shift+click places it
  anyway.
- **Stretching drawing lines** (board, schematic): a selected line shows handles on its ends;
  drag one to move that end. The ends of other lines on the same layer that meet it move too,
  so dragging a board outline corner resizes the board and keeps the outline closed. The
  inspector shows the line's Start and End as x, y in mm: type a point (off the grid too) and
  press Enter to move that end the same way.
- **Pours are computed** (board): each polygon pour is filled much as Eagle does, but with one
  gap, its **isolate** (10 mil unless set), whatever the design rules say: that far from other
  nets' copper, inside the board outline and around holes; out of keep-out areas and cutouts, in
  rank order; the net's pads
  get thermal spokes (or connect fully with thermals off); islands that reach none of the net's
  copper are dropped (unless orphans are kept). Pours reflow after every edit (a drag reflows
  them when it ends). The **pour fill** checkbox in the Layers panel (or P) shows them filled or
  as outlines only (a pour's dashed outline shows only when it has no copper to show); that's just the view, so airwires and the DRC count the copper either way.
  Not yet: hatched fill (drawn solid), and removing copper narrower than the pour's width.
- **Assembly files** (board): **CAM… → Assembly** saves a zip with a bill of materials and a
  pick-and-place list in JLCPCB's format: SMD parts, or SMD and through-hole parts (a choice in
  the menu; a board house's standard assembly is SMD, through-hole parts are usually soldered by
  hand). Parts marked **Do not place** (a checkbox in the inspector, the part's DNP attribute)
  are left out too, and what was left out is listed. The BOM has one row per group of identical parts
  (value, footprint, LCSC part number, manufacturer and MPN alike): designators, quantity, and
  whether they are SMD or through-hole. The pick-and-place list gives each part's centre (the
  middle of its pads, not its footprint's origin), side and rotation. A part's **LCSC part** is
  set in the inspector (C25804…; checked, kept through Eagle export), or comes from its
  component in the library (see below); parts without one are
  pointed out, as JLCPCB then matches them by hand. Parts without a footprint (supply symbols)
  are left out. A board house's zero rotation for some packages (SOT-23, diodes) differs from
  the library's: their preview shows it, and parts on the bottom are flagged to check.
- **Blocks** (schematic and board): parts that belong together (a filter, an oscillator) form a
  block, and blocks can sit inside blocks. Select parts and type a block in the inspector's
  **Block** field (or B): a name, or a path such as `rx/frontend` for a block inside `rx`; empty
  takes them out. Each block is outlined with right-angled corners and tinted in its own colour,
  the same in both views (Shift+B or the blocks checkbox shows or hides the outlines); supply
  symbols belong to none. **Select block** selects a block's parts, blocks inside it included.
  The **Blocks** panel lists the tree, each block in its outline's colour with its part count
  (click one to select it). **Suggest** gives every part without a block one, from the wiring:
  ICs and transistors anchor blocks (transistors wired to each other share one), other parts
  join the anchor they reach through the fewest, smallest signal nets (ties: the one drawn
  nearest), decoupling caps the nearest IC on their supply, and a connector bringing power in
  starts a `power` block; in a large block, a cluster hanging off a named net (ADC) becomes a
  block inside it. Parts already in a block keep it and pull their neighbours in, so naming one
  IC's block and suggesting again fills it in. One undo step.
  A part's block is its BLOCK attribute, so it is kept through Eagle export. Placement is to work
  block by block.
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

Not yet: updating a project from a library, busses beyond wires, push-and-shove routing,
text on copper.

### Next

1. **Library editing,** in library files, as in Eagle: projects keep their copies until
   updated from the library.
   - **Update from library** in a project: see which parts differ and how, and apply as one
     step that can be undone, with ERC run afterwards (a renamed or moved pin shows as a
     problem rather than a silently broken connection).

### Roadmap

Then, to take a board through manufacturing and assembly:

- **Design rules edited in place:** type a clearance, width or drill in the Design rules
  panel, without a `.dru` file.
- **Pours drop copper narrower than their width** (slivers between close pads and at the
  edge), as Eagle does.
- **Net classes:** set trace width, clearance and via drill per class (e.g. wider supplies),
  and which class a net is in.

Smaller:

- **Routing alignment guide:** show a faint line when the cursor lines up with a pad's row or
  column, and line up only with pads the route isn't connected to yet.
- **Open `.osprey` files from Explorer:** the installed app registers for them (file
  handlers), so double-clicking a project opens it in Osprey.

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
npm run test:ui    # the editor driven in headless Chrome (test/ui; skipped without Chrome)
npm run samples    # regenerate samples/osprey/ from samples/eagle/ (after importer changes)
npm run typecheck
npm run build
npm run app        # build, serve it at http://localhost:4173 and open it (to install, below)
```

### Driving the app

`scripts/drive.mjs` runs the app in headless Chrome (or Edge; `CHROME_PATH` picks one) over the
DevTools protocol, against a dev server it starts: open a sample, switch views, click at world
coordinates in mm, press keys, type into inspector fields, click buttons, take screenshots. A
dev-only `window.__osprey` hook (end of `src/main.ts`) gives the project and the editor's
state (view, mode, selection, status, undo, DRC), so checks read state rather than pixels.
The UI tests use it, and so can you:

```sh
npm run drive -- open:wwvbfind.osprey/board click:4.1,8.83 key:r state shot:out.png
```

The steps are listed at the top of the script. Errors the page logs are printed at the end.

### As an installed app (no server)

Osprey can be installed as a progressive web app, which then runs in its own window with no
server: a service worker (`sw.js`, written by `vite.config.ts` at build time) caches every file
of the build. To install:

1. `npm run app` (builds, then serves `dist/` at http://localhost:4173 and opens it in the browser).
2. In Chrome or Edge, click the install icon at the right of the address bar (or menu → *Cast,
   save and share* → *Install page as app*). Osprey gets a Start menu entry and its own window.
3. Stop the server (Ctrl+C). The installed app keeps working.

To update an installed app, run `npm run app` again (same port: the app is tied to
`localhost:4173`), and reopen it once it has loaded; the new build takes over the next time it
starts. The icons are drawn by `npm run icons` (`scripts/build-icons.mjs`, into `public/`).

Opening `dist/index.html` straight from disk doesn't work: browsers don't run module scripts
from `file://`.

The app opens the `TA7358A` Osprey project by default; the Sample menu also offers the
original Eagle pair (imported on the fly), an Osprey library and the Eagle library it was
imported from. A sample can be opened by URL,
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
| Place vias (board) | Via button; click places one (net from the copper under it), Shift+click ignores clearance, Esc or right-click stops |
| Edit a pour's outline (board) | Select it; drag a corner, drag an edge's middle to add a corner, click a corner then Del to remove it |
| Stretch a drawing line, e.g. resize the board outline | Select the line; drag a handle on its end (lines meeting there follow) |
| Show / hide pour fill (board) | `P`, or the pour fill checkbox in the Layers panel |
| Put the selected parts in a block | `B`, type a name or path (`rx/frontend`), Enter; empty takes them out |
| Show / hide block outlines | Shift+B, or the blocks checkbox in the Layers panel |
| Design-rule check (board) | Design rules panel: Check; Load rules… for a `.dru` file; click a problem to mark it on the board, again to unmark it |
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
