
from cgitb import reset
from hdlite import Simulation as sim
from hdlite import Signal as sig
import bitslice.bitslice_tb as bit

from hdlite.Component import *
from hdlite.ControlPanel import *

class Counter(Component):
    def __init__(self, reset, clock, out):
        super().__init__()
        self.clock = clock
        self.reset = reset
        self.out = out
        self.bit2 = sig.Signal()

    def run(self):
        self.bit2 <<= self.out[2]
        if self.reset == 1:
            self.out <<= 0
        elif self.clock.isRisingEdge():
            if self.out < 10:
                self.out <<= self.out + 1

def runCounter():
    sim.simulation = sim.Simulation()
    clock = sig.Signal()
    reset = sig.Signal()
    out = sig.Vector(4)
    outputs = {'out': out}
    top = Counter(reset, clock, out)
    sim.simulation.setTopComponent(top)
    app = App(reset, clock, outputs)
    app.mainloop()

if __name__ == '__main__':
    runCounter()
