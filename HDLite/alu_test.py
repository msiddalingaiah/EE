
from hdlite import Simulation as sim
from hdlite import Signal as sig

from bitslice.Am2901 import *
from hdlite.ControlPanel import *

if __name__ == '__main__':
    sim.simulation = sim.Simulation()
    reset = sig.Signal()
    clock = sig.Signal()
    din = sig.Vector(4)
    aSel = sig.Vector(4)
    bSel = sig.Vector(4)
    aluSrc = sig.Vector(3)
    aluOp = sig.Vector(3)
    aluDest = sig.Vector(3)
    cin = sig.Signal()
    yout = sig.Vector(4)
    cout = sig.Signal()
    alu = Am2901(clock, din, aSel, bSel, aluSrc, aluOp, aluDest, cin, yout, cout)
    sim.simulation.setTopComponent(alu)
    inputs = {'Din': din, 'aSel': aSel, 'bSel': bSel, 'aluSrc': aluSrc, 'aluOp': aluOp,
        'aluDest': aluDest, 'Carry In': cin}
    internal = {'Q': alu.q}
    outputs = {'Y': yout, 'Carry Out':cout}
    app = App(reset, clock, inputs, internal, outputs)
    app.mainloop()
