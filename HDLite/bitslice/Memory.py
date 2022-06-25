
from hdlite import Signal as sig

from hdlite.Component import *

class Memory(Component):
    def __init__(self, reset, clock, din, write, address, out):
        super().__init__()
        self.reset = reset
        self.clock = clock
        self.din = din
        self.write = write
        self.address = address
        self.out = out
        self.memory = [0]*256

    def run(self):
        self.out <<= self.memory[self.address.getIntValue() & 0xff]
        if self.clock.isRisingEdge():
            if self.write == 1:
                self.memory[self.address.getIntValue() & 0xff] = self.din.getIntValue()

    def read(self, fname):
        with open(fname) as f:
            lines = f.readlines()
            for i, line in enumerate(lines):
                if len(line) > 2:
                    self.memory[i] = int(line[0:2], 16)
