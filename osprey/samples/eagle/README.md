# Eagle samples

Drop Eagle files here. Keep a matching `.sch` and `.brd` together under the same base name, e.g.:

```
blinky.sch
blinky.brd
mylib.lbr
```

Files must be Eagle 6+ (XML format). Older binary files need to be opened and re-saved in Eagle 6 or later first.

The app lists each `.sch` + `.brd` pair as a sample to import, each `.lbr` as a library to
browse (and add parts from), and each `.dru` as design rules to load for the DRC.
Pairs are also used by the tests; `TA7358A` has a native counterpart in `../osprey/`.
Each `.cam` (an Eagle CAM job) is offered in the CAM menu. `TA7358A_2026-06-12.zip` is Eagle's CAM output for
`TA7358A` with `jlcpcb_2_layer_v9.cam`; the tests compare Osprey's CAM output against it.
