
from hdlite import Simulation as sim
from hdlite import Signal as sig

from hdlite.ControlPanel import *

from hdlite.Component import *

class NAND(Component):
    def __init__(self, a, b, c):
        super().__init__()
        self.a = a
        self.b = b
        self.c = c

    def run(self):
        self.c <<= ~(self.a & self.b)

if __name__ == '__main__':
    sim.simulation = sim.Simulation()
    reset = sig.Signal()
    clock = sig.Signal()
    a = sig.Signal()
    b = sig.Signal()
    c = sig.Signal()
    nand = NAND(a, b, c)
    sim.simulation.setTopComponent(nand)
    inputs = {'a': a, 'b':b}
    internal = {}
    outputs = {'c':c}
    app = App(reset, clock, inputs, internal, outputs)
    app.mainloop()
