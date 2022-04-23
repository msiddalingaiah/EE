
from msilib.schema import Component


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
        self.memory = [0]*2048
    
    def run(self):
        self.out <<= self.memory[self.address.getIntValue()]
        if self.clock.isRisingEdge():
            if self.write == 1:
                self.memory[self.address.getIntValue()] = self.din.getIntValue()
