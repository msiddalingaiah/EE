# The `.osprey` project format — draft 1 (for review)

Status: **accepted**, not yet implemented. Design decisions are recorded at the end
([Decisions](#decisions)).

An Osprey project is one file: a schematic and its board, together, as UTF-8 JSON with
the extension `.osprey`. Eagle `.sch`/`.brd` files are imported into this format and can
be exported from it; they are not edited directly anymore. Libraries (`.lbr`) stay
separate for now.

## Goals

1. **One source of truth.** Each fact is stored once: a part once (with a schematic and a
   board placement), a net once (with its schematic wiring and its board routing). The
   schematic and board cannot disagree, so no annotation or consistency checking is needed
   between them.
2. **Readable diffs.** Canonical formatting with one record per line, fixed key order, and
   no derived data, so a git diff of a `.osprey` file shows what changed in the design.
3. **Nothing lost on import.** Eagle data Osprey doesn't model yet is kept (see
   [Passthrough](#passthrough)) so it can be modelled later without re-importing.
4. **Room to grow.** The format is versioned and unknown fields are preserved on save.

Non-goals: byte-identical Eagle export (Eagle is a migration source), view state (zoom,
selection, layer visibility), undo history.

## Conventions

| Topic | Rule |
| --- | --- |
| Lengths | Numbers in **millimetres**, at most 6 decimal places (1 nm resolution), no exponent. |
| Points | `[x, y]` arrays. Y points **up** (as in Eagle). |
| Rotation | `rot`: degrees counter-clockwise, `0 ≤ rot < 360`. Omitted when 0. |
| Mirroring | `mirror: true` mirrors about the Y axis **after** rotating (Eagle's `MRθ`). On the board, a part's mirror is expressed as `side: "bottom"`. |
| Text spin | `spin: true` disables the keep-text-readable flip (Eagle's `S` flag). |
| Arcs | A straight segment with `curve`: sweep in degrees, counter-clockwise from the first point to the second (Eagle's convention). Omitted when 0. |
| Names | Part and net names are upper-case, without white space, unique in their collection. |
| Optional fields | Omitted when they have their default value (listed per type). |
| Unknown fields | Kept and written back unchanged, so older and newer Osprey versions can share files. |

### Canonical formatting

Osprey always writes the same bytes for the same design:

- LF line endings, final newline, 2-space indentation.
- Keys in the order listed in this document.
- **Each record in an array goes on one line** (parts, pins, wires, vias, pads…). A record
  that contains its own arrays of records (a net, a sheet, a symbol) is opened on a line,
  with its records indented below.
- Numbers formatted as described above (`2.54`, never `2.540000` or `2.54e0`).

Editors' JSON formatters would undo this layout; the `.osprey` extension (not `.json`)
keeps them away.

## Top level

```json
{
  "osprey": 1,
  "project": { … },
  "library": { … },
  "parts": [ … ],
  "nets": [ … ],
  "busses": [ … ],
  "schematic": { … },
  "board": { … },
  "eagle": { … }
}
```

| Key | Meaning |
| --- | --- |
| `osprey` | Format version (integer). Osprey upgrades older versions on open and refuses newer major versions it doesn't know. |
| `project` | Name and provenance. |
| `library` | Every symbol, footprint and component the design uses (the project library). |
| `parts` | The parts: identity, component, value, attributes. |
| `nets` | Electrical nets with their schematic wiring and board routing. |
| `busses` | Schematic busses (graphical only; they carry no connectivity). |
| `schematic` | Sheets, gate placements, free drawing. Absent for a board-only project. |
| `board` | Outline, footprint placements, free drawing, layer stack, rules. Absent for a schematic-only project. |
| `eagle` | Document-level Eagle data not modelled yet. See [Passthrough](#passthrough). |

### `project`

```json
"project": {
  "name": "TA7358A",
  "imported": { "from": ["TA7358A.sch", "TA7358A.brd"], "date": "2026-11-09", "eagleVersion": "9.6.2" }
}
```

`imported` is present only for projects that came from Eagle.

## Library

Eagle copies library items into every schematic and board that uses them, as separate
copies. Osprey keeps **one project library**, shared by schematic and board.

```json
"library": {
  "symbols": [ … ],
  "footprints": [ … ],
  "components": [ … ]
}
```

Library items are keyed by **`"library/name"`**, e.g. `"madhu/CAPACITOR-NP"`, so items with
the same name from different Eagle libraries don't collide.

### Symbol (schematic graphic of a gate)

```json
{ "id": "madhu/CAPACITOR-NP", "description": "Non-polarized capacitor",
  "graphics": [
    { "line": [[0, 2.54], [0, 2.032]], "width": 0.1524, "layer": "symbols" },
    { "line": [[0, 0], [0, 0.508]], "width": 0.1524, "layer": "symbols" },
    { "rect": [[-2.032, 0.508], [2.032, 1.016]], "layer": "symbols" },
    { "rect": [[-2.032, 1.524], [2.032, 2.032]], "layer": "symbols" },
    { "text": ">NAME", "at": [1.524, 2.921], "size": 1.778, "layer": "names" },
    { "text": ">VALUE", "at": [1.524, -2.159], "size": 1.778, "layer": "values" }
  ],
  "pins": [
    { "name": "1", "at": [0, 5.08], "rot": 270, "length": "short", "direction": "passive", "visible": "none", "swap": 1 },
    { "name": "2", "at": [0, -2.54], "rot": 90, "length": "short", "direction": "passive", "visible": "none", "swap": 1 }
  ]
}
```

Pin fields: `length` (`point` | `short` | `middle` | `long`, default `long`), `direction`
(`nc` | `in` | `out` | `io` | `oc` | `power` | `passive` | `hiz` | `supply`, default `io`),
`function` (`none` | `dot` | `clock` | `dotclock`), `visible` (`both` | `pad` | `pin` |
`none`, default `both`), `swap` (swap level, default 0).

### Footprint (Eagle "package")

```json
{ "id": "madhu/0805", "description": "0805 SMT",
  "graphics": [
    { "text": ">NAME", "at": [1.9685, -0.889], "rot": 90, "size": 0.6096, "layer": "names.top" },
    { "line": [[-1.524, -0.3], [-1.524, 0.3]], "width": 0.4064, "layer": "silk.top" }
  ],
  "pads": [
    { "name": "1", "smd": [0.8, 1.2], "at": [-0.9, 0] },
    { "name": "2", "smd": [0.8, 1.2], "at": [0.9, 0] }
  ]
}
```

Pads are either SMD or through-hole:

| SMD | Through-hole |
| --- | --- |
| `smd: [dx, dy]`, `roundness` (%, default 0), `side` (`top`/`bottom`, default `top`), `mask`/`paste` (default true) | `drill`, `diameter` (default 0 = automatic from design rules), `shape` (`round` \| `square` \| `octagon` \| `long` \| `offset`), `first` |

Both have `name`, `at`, `rot`, and `thermals` (default true). Footprints are always defined as seen from the top;
placing one on the bottom side mirrors it.

### Component (Eagle "device set" + "devices")

```json
{ "id": "madhu/CAPACITOR-NP", "prefix": "C", "userValue": true, "description": "…",
  "gates": [
    { "name": "A", "symbol": "madhu/CAPACITOR-NP", "at": [0, 0] }
  ],
  "variants": [
    { "name": "0805", "footprint": "madhu/0805", "pads": { "A.1": ["1"], "A.2": ["2"] } },
    { "name": "0.2\"", "footprint": "madhu/CAP-0.2", "pads": { "A.1": ["1"], "A.2": ["2"] } }
  ]
}
```

- A **variant** (Eagle "device") chooses the footprint and maps each `gate.pin` to one or
  more pads. A variant without `footprint` is schematic-only (e.g. a ground symbol).
- `technologies` (optional) on a variant: `{ "LS": { "attr": "value" }, "HC": { … } }`.
  An attribute users may change per part is written `{ "value": "…", "constant": false }`.
  Omitted when the variant has only the empty technology with no attributes.
- A part that exists only on the board (no schematic) refers to a footprint-only component,
  `"<footprint id>#footprint"`, with no gates and one variant naming the footprint.
- Gate fields: `addLevel` (`next` | `must` | `can` | `always` | `request`, default `next`),
  `swap` (default 0).
- **Generated value:** for components with `userValue: false`, a part's value is the
  component name with `*` replaced by the technology and `?` by the variant (the variant
  name is appended when there is no `?`): `74*151` + `LS` + `D` → `74LS151D`.

## Parts

```json
"parts": [
  { "name": "C2", "component": "madhu/CAPACITOR-NP", "variant": "0805", "value": "22p" },
  { "name": "IC1", "component": "linear/TA7358P", "variant": "" },
  { "name": "IC2", "component": "74xx-us/74*151", "variant": "D", "technology": "LS" }
]
```

Fields: `name`, `component`, `variant`, `technology` (default `""`), `value` (omitted for
generated values), `attributes` (`{ "name": "value" }`, default `{}`).

A part's placements live in the schematic (one per gate) and on the board (one footprint),
both referring to the part by `name`.

## Nets

A net is stored once. Its **pins** say what it connects; its schematic segments and board
routing are how it's drawn and built.

```json
"nets": [
  { "name": "N$1",
    "segments": [
      { "sheet": "1",
        "pins": [{ "part": "C2", "gate": "A", "pin": "2" }, { "part": "IC1", "gate": "G$1", "pin": "MIX-IN" }],
        "wires": [
          { "line": [[5.08, 38.1], [20.32, 38.1]], "width": 0.1524 }
        ]
      }
    ],
    "traces": [
      { "line": [[2.54, 13.97], [3.821, 15.251]], "width": 0.254, "layer": "copper.top" },
      { "line": [[3.821, 15.251], [5.461, 15.251]], "width": 0.254, "layer": "copper.top" }
    ]
  }
]
```

| Field | Meaning |
| --- | --- |
| `name` | Net name. |
| `class` | Net class number (default 0). |
| `segments` | Schematic wiring, one per connected piece of wire on a sheet (Eagle "segment"): `sheet`, `pins` (the gate pins this piece touches), `wires`, `junctions` (`[x, y]` points), `labels`. |
| `traces` | Board copper: lines and arcs with `width` and `layer`. |
| `vias` | `{ "at": [x, y], "drill": 0.6, "diameter": 0, "layers": "1-16", "shape": "round" }`. |
| `pours` | Copper pours, as polygon shapes: `{ "polygon": [[x, y], …], "width", "layer", "isolate", "spacing", "rank", "pour" (`hatch` \| `cutout`), "thermals", "orphans" }`. |
| `pads` | **Board-only projects only:** `[{ "part", "pad" }]`. Without a schematic there are no pins to derive pads from, so they are stored. |

What is **derived, not stored**:

- **Board pad connections** (Eagle `contactref`): computed from the net's pins and each
  part's variant pad map. This is what makes schematic and board unable to disagree.
- **Implicit power connections:** supply pins not wired anywhere join the net named after
  the pin (Eagle's rule), as today.
- **Airwires** (Eagle's layer-19 "unrouted" wires): the ratsnest is computed from pads and
  traces, and regenerated on export. Eagle's stored airwires are not imported. As in Eagle,
  copper connects through traces, vias (including a via on a pad) and pours, not through
  overlapping pads. Until poured copper is computed, a pour counts as its whole outline, so
  a pour that Eagle splits into islands can show fewer airwires than Eagle would.

### Busses

`{ "name": "D[0..7]", "segments": [ { "sheet": "1", "wires": [ … ], "labels": [ … ] } ] }`.

## Schematic

```json
"schematic": {
  "grid": { "step": 2.54, "fine": 0.254 },
  "sheets": [
    { "id": "1",
      "gates": [
        { "part": "C2", "gate": "A", "at": [2.54, 38.1], "rot": 90,
          "labels": [
            { "attr": "NAME", "at": [-0.381, 39.624], "rot": 90, "size": 1.778, "layer": "names" },
            { "attr": "VALUE", "at": [4.699, 39.624], "rot": 90, "size": 1.778, "layer": "values" }
          ]
        }
      ],
      "drawing": [ … ]
    }
  ]
}
```

- **Gate placement:** `part`, `gate`, `at`, `rot`, `mirror`, and `labels`. A gate with
  `labels` is smashed: its name/value texts are placed independently. `smashed: true` with
  no labels hides them (Eagle allows this). Without either, the symbol's own `>NAME` and
  `>VALUE` texts are used.
- **Label fields:** `attr`, `value` (only when the label carries its own value, e.g. a
  board attribute such as `POPULARITY`), `at`, `rot`, `mirror`, `spin`, `size`, `layer`,
  `ratio` (default 8), `align` (default `bottom-left`), `display` (`value` | `name` |
  `both` | `none`, default `value`), `font`.
- **Sheet fields:** `id` (stable, never renumbered), `description`, `gates`, `drawing`
  (free graphics, frames).
- **Net labels** (in net segments): `{ "at", "rot", "size", "layer", "xref", "align" }`.
  The text is always the net name.

## Board

```json
"board": {
  "grid": { "step": 1.27, "fine": 0.127 },
  "layers": ["copper.top", "copper.bottom"],
  "classes": [{ "number": 0, "name": "default", "width": 0, "drill": 0 }],
  "footprints": [
    { "part": "C2", "at": [5.461, 14.351], "rot": 90,
      "labels": [
        { "attr": "NAME", "at": [4.699, 15.875], "size": 0.8128, "layer": "names.top" },
        { "attr": "VALUE", "at": [4.699, 13.97], "size": 0.8128, "layer": "names.top" }
      ]
    },
    { "part": "RF", "at": [17.907, 3.683], "rot": 90, "smashed": true }
  ],
  "drawing": [
    { "line": [[0, 0], [36.246, 0]], "width": 0, "layer": "outline" },
    { "hole": [2.54, 2.54], "drill": 3.175 }
  ]
}
```

- **Footprint placement:** `part`, `at`, `rot`, `side` (`top` | `bottom`, default `top`),
  `locked`, `labels`/`smashed` (as for gates). The footprint comes from the part's variant.
  Its pads' nets are derived from the part's pins.
- **`layers`:** the copper stack, top to bottom.
- **`classes`:** net classes; clearances between classes are kept in the passthrough for now.
- **Design rules** are not modelled yet: they stay in the board's passthrough (see below),
  and Osprey keeps reading pad and via restring from there as it does today.
- **`grid`:** `step` and `fine` (alternate grid) in mm, and `unit` (`mil` | `inch` | `mic`;
  omitted for mm), the unit shown to the user.

## Graphics

Used in symbols, footprints, sheet drawings, board drawing, wires and traces.

| Shape | Fields |
| --- | --- |
| line / arc | `line: [[x1, y1], [x2, y2]]`, `width`, `layer`, `curve`, `cap` (`round` \| `flat`), `style` (`continuous` \| `longdash` \| `shortdash` \| `dashdot`) |
| circle | `circle: [x, y]`, `radius`, `width` (0 = filled), `layer` |
| rectangle | `rect: [[x1, y1], [x2, y2]]`, `rot`, `layer` |
| polygon | `polygon: [[x, y], [x, y, curve], …]`, `width`, `layer` (a third number on a point is the arc sweep to the next point) |
| text | `text`, `at`, `size`, `layer`, `rot`, `mirror`, `spin`, `ratio`, `align`, `font` (`vector` \| `proportional` \| `fixed`) |
| hole | `hole: [x, y]`, `drill` |
| frame | `frame: [[x1, y1], [x2, y2]]`, `columns`, `rows`, `layer` |

The first key names the shape, so each line reads naturally in a diff.

## Layers

Osprey names layers by role instead of Eagle's numbers.

| Osprey | Eagle | Osprey | Eagle |
| --- | --- | --- | --- |
| `copper.top` | 1 Top | `copper.bottom` | 16 Bottom |
| `copper.in1` … `copper.in14` | 2 … 15 | `outline` | 20 Dimension |
| `silk.top` / `silk.bottom` | 21 tPlace / 22 bPlace | `names.top` / `names.bottom` | 25 tNames / 26 bNames |
| `values.top` / `values.bottom` | 27 tValues / 28 bValues | `mask.top` / `mask.bottom` | 29 tStop / 30 bStop |
| `paste.top` / `paste.bottom` | 31 tCream / 32 bCream | `finish.top` / `finish.bottom` | 33 tFinish / 34 bFinish |
| `glue.top` / `glue.bottom` | 35 tGlue / 36 bGlue | `test.top` / `test.bottom` | 37 tTest / 38 bTest |
| `keepout.top` / `keepout.bottom` | 39 tKeepout / 40 bKeepout | `restrict.top` / `restrict.bottom` / `restrict.vias` | 41 / 42 / 43 |
| `drills` | 44 Drills | `holes` | 45 Holes |
| `milling` | 46 Milling | `measures` | 47 Measures |
| `document` | 48 Document | `reference` | 49 Reference |
| `fab.top` / `fab.bottom` | 51 tDocu / 52 bDocu | `nets` | 91 Nets |
| `busses` | 92 Busses | `pins` | 93 Pins |
| `symbols` | 94 Symbols | `names` | 95 Names |
| `values` | 96 Values | `info` | 97 Info |
| `guide` | 98 Guide | `eagle.N` | any other layer N (user layers kept by number) |

Pads, vias, airwires and the other Eagle layers 17–19 are not layers in Osprey: pads and
vias are objects, and airwires are computed. Layer colours and visibility are display
settings and are not stored in the project.

## Passthrough

Eagle data that Osprey doesn't model is kept under `eagle` keys, in **JsonML**
(`["tag", {attributes}, ...children]`, an element and its attributes on one line, child
elements on the lines below), so nothing that matters is lost on import, and it is written
back on export:

- **Document level:** top-level `eagle` has a list per source document (`schematic`,
  `board`). Each entry groups unmodelled XML under the element it came from:
  `["eagle", …]` (root attributes), `["drawing", …]` (e.g. `settings`),
  `["schematic"|"board", {attributes}, …]` (e.g. `designrules`, `autorouter`,
  `mfgpreviewcolors`, `variantdefs`, `errors`), `["library", {name, urn}, …]` (library
  descriptions, 3D package lists), `["layers", …]` (user-defined layers the design draws
  on) and `["grid", {…}]` (grid display settings).
- **Object level:** any object may carry `"eagle": { "attrs": { … }, "children": [ … ] }`
  for attributes and child elements Osprey doesn't recognise (e.g. `package3d_urn`,
  `library_version`, `<variant>` on parts).

**Not kept**, because Eagle regenerates them or they are display settings: Eagle's
compatibility notes, the standard layer table (colours, visibility) and declared but unused
layers, airwires, and board contactrefs (derived from the netlist).

As the model grows, data moves out of the passthrough into native fields (with a format
version bump if it changes meaning). Projects created in Osprey have no `eagle` keys.

## Import and export

**Import** (`.sch` + `.brd`, or either alone):

1. Parse both files (existing parser).
2. Merge the libraries: symbols and components from the schematic, footprints from the
   board. If the schematic and board copies of a footprint differ (a library updated in
   only one of them), the board's wins and the import report says so.
3. Parts from the schematic, matched to board elements by name. Nets from schematic
   pinrefs, with traces, vias and pours from the board signal of the same name.
   Libraries sharing a name but not a URN are told apart as `name@urn`.
4. **Inconsistencies are reported, never silently resolved.** The consistency check runs
   first. If the pair disagrees, the import lists the differences and asks whether to
   import with the schematic as the authority for the netlist.

**Export** writes a `.sch` and a `.brd` in Eagle 9's format (element order, one element per
line, CRLF), with contactrefs, airwires, the layer table and each file's library copies
regenerated, and the passthrough written back where it came from. Importing the exported
files gives the same project: a test checks this on the sample and every available design
pair. Exported files mean the same as the originals but aren't byte-identical: the order of
graphics within a footprint or symbol, and of items within a library, is Osprey's.

## Decisions

1. **References are by name.** Parts and nets are referred to by name, which reads well in
   diffs and matches Eagle. Renaming rewrites the references (a few lines in a diff).
   Stable opaque IDs were considered and rejected: one-line renames, but unreadable
   references.
2. **Airwires are computed.** Osprey computes the ratsnest (needed for routing anyway) as
   part of switching to this format; Eagle's stored airwires are not imported.
3. **Sheets follow Eagle's model.** Gates are placed on sheets; a net spans sheets by name.
4. **Library items are keyed `library/name`**, which avoids clashes and stays traceable
   to the source library.
5. **Pin directions are spelled out** (`passive`, `power`, `supply`), not Eagle's
   abbreviations.
6. **Not chosen:** XML (wrapping the Eagle documents) and JSON with embedded Eagle XML.
   Eagle is a migration source, so a native model wins over lossless Eagle round trips.
   The extension is `.osprey`, not `.json`, so editors' formatters leave the canonical
   layout alone.
