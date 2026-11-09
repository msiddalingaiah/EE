# Eagle samples

Drop Eagle files here. Keep a matching `.sch` and `.brd` together under the same base name, e.g.:

```
blinky.sch
blinky.brd
mylib.lbr
```

Files must be Eagle 6+ (XML format). Older binary files need to be opened and re-saved in Eagle 6 or later first.

The app lists each `.sch` + `.brd` pair as a sample to import, and each `.lbr` as a library to
browse. Pairs are also used by the tests; `TA7358A` has a native counterpart in `../osprey/`.
