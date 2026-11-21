# Hand-drawn subcircuits

A test set for schematic generation: common subcircuits, generated and then redrawn by hand,
so the generator's rules can be compared with (and scored against) how a person draws them.

- `subcircuits.blocks`: the description: one block per subcircuit, with a comment saying
  what it is. Blocks share only VCC and GND.
- `subcircuits-gen.osprey`: the generator's layout. Regenerate it freely:
  `npm run osprey -- generate samples/schematics/subcircuits.blocks -o samples/schematics/subcircuits-gen.osprey`
- `subcircuits-hand.osprey`: the hand drawing. It started as a copy of `-gen`. It is never
  regenerated, only read.

## Redrawing

Treat the generated layout as a bin of parts. Move anything, and delete and redraw wires.
Keep the parts, their names and the connections. Blocks can go anywhere on the sheet: each
block is compared by the positions within it, not by where it sits. Where a choice isn't
obvious, add a short text note next to the block. Where there are two good ways, draw your
default and note the other.

## Subcircuits

To add one: add a block to `subcircuits.blocks`, regenerate `-gen`, and copy the new block
into `-hand`.

- [ ] Divider: half of VCC, filtered, to a connector
- [ ] RC-lowpass
- [ ] LED with its resistor, from VCC
- [ ] CE-amp: divider bias, bypassed emitter, coupling caps
- [ ] Inverting-amp: single supply, +IN biased at half supply
- [ ] LC-tank: tuned collector load

Later: RC high-pass, pull-up/pull-down, decoupling around an IC, emitter follower,
transistor switch with a relay and flyback diode, differential pair, non-inverting amp,
buffer, active filter, crystal oscillator, and two or three subcircuits chained together.
