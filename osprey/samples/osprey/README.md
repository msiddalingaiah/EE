# Osprey samples

Native Osprey projects (`.osprey`, see [docs/format.md](../../docs/format.md)).

`TA7358A.osprey` is the import of the Eagle pair in `../eagle/`. A test keeps the two in step:
it fails if the importer or the writer would now produce something different. After an
intended change to either, regenerate the sample and review the diff:

```sh
npm run samples
```

`wwvbfind.osprey` is the WWVB finder (ATtiny412, MPF102/2N3904 front end, 20 MHz Pierce
oscillator): a schematic and board placement generated from a circuit description by a
script, as a first test of building designs with Claude. Unrouted.
