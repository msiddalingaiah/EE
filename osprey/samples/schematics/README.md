# Hand-drawn subcircuits

A test set for schematic generation: common subcircuits, generated and then redrawn by hand,
so the generator's rules can be compared with (and scored against) how a person draws them.

- `subcircuits.blocks`: the description: one block per subcircuit, with a comment saying
  what it is. Blocks share only VCC and GND.
- `subcircuits-gen.osprey`: the generator's layout. Regenerate it freely:
  `npm run osprey -- generate samples/schematics/subcircuits.blocks -o samples/schematics/subcircuits-gen.osprey`
- `subcircuits-hand.osprey`: the hand drawing. The first six blocks started as a copy of `-gen`
  and were redrawn; the rest are copied, as drawn, from old Eagle designs (below). It is never
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

### From old designs

Copied with their wires and supply symbols from the old Eagle designs (private-ee/designs), picked
from a count of subcircuit types across them. Parts are renamed to be unique here, positive
supplies become VCC, and wires that ran to parts left behind are trimmed (their pins are `nc:`).

- ATtiny412: decoupling cap, UPDI header, trimmer on an ADC pin, LED (panels/ATTiny412)
- Crystal with two load caps (ustem/atmega8u2)
- Reset-button: pull-up and push button (ustem/atmega8u2)
- Regulator: 78L05 with a series input diode (ustem/tiny24X)
- Boost: MAX17225 (IoT/nano-boost_rev_C)
- PMOS-polarity: reverse-polarity P-MOSFET (ustem/Polarity)
- MOSFET-switch: low-side switch with a flyback diode (BeamSensor)
- 555-astable (ustem/555-astable)
- Current-mirror (ustem/n-mirror)
- Diff-pair with mirror tail and load (ustem/mixer)
- Colpitts, common collector (ustem/3904Colpitts4)
- Colpitts-CB, common base with emitter follower and detector (ustem/3904Colpitts1)
- Multivibrator (ustem/t2)
- Power-latch: NPN-driven PNP high-side switch (IoT/RTC_latch)
- Detector-buffer: diode detector and op-amp follower (ustem/PNP-Dipper; 1N4148 drawn as 1N914)

Later: RC high-pass, pull-up/pull-down, decoupling around an IC, emitter follower,
transistor switch with a relay and flyback diode, differential pair, non-inverting amp,
buffer, active filter, crystal oscillator, and two or three subcircuits chained together.
