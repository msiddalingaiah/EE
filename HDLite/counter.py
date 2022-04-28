
from hdlite import Simulation as sim
from hdlite import Signal as sig

from hdlite.Component import *
from hdlite.ControlPanel import *

class Counter(Component):
    def __init__(self, reset, clock, load, input, output, odd):
        super().__init__()
        self.reset = reset
        self.clock = clock
        self.load = load
        self.input = input
        self.output = output
        self.odd = odd

    def run(self):
        self.odd <<= self.output[0]
        if self.reset == 1:
            self.output <<= 0
        elif self.clock.isRisingEdge():
            if self.load == 1:
                self.output <<= self.input
            else:
                self.output <<= self.output + 1

def runCounter():
    sim.simulation = sim.Simulation()
    clock = sig.Signal()
    reset = sig.Signal()
    load = sig.Signal()
    input = sig.Vector(4)
    out = sig.Vector(4)
    odd = sig.Signal()
    inputs = {'Load': load, 'Input': input}
    interns = {}
    outputs = {'Out': out, 'Odd': odd}
    top = Counter(reset, clock, load, input, out, odd)
    sim.simulation.setTopComponent(top)
    app = App(reset, clock, inputs, interns, outputs)
    app.mainloop()

if __name__ == '__main__':
    runCounter()
