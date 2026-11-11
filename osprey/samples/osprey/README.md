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
script, as a first test of building designs with Claude, and placed with the placement toolkit
(`src/edit/arrange.ts`): connectors on the edges, blocks beside the pins they connect to,
rotations chosen by airwire length and crossings, then improved by small moves and swaps
(`src/edit/improve.ts`), then laid out again by hand on a smaller board (44.46 x 27.46 mm).
The 2-pin headers (VCC power, IN antenna, VOUT audio) have ground on pin 1; the UPDI header is UPDI, GND, VCC from pin 1. Unrouted.

The JFET source follower drives the 2N3904's base directly: its source voltage biases the
transistor, so there is no coupling capacitor or base divider. The emitter's bypassed
resistor (R6, 1k) keeps the collector current near 1 mA for a typical MPF102; a JFET with a
small pinch-off voltage may need a larger R2.
