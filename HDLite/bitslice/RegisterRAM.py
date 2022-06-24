
from hdlite import Signal as sig

from hdlite.Component import *

class RegisterRAM(Component):
    def __init__(self, clock, write_en, address, data_in, data_out):
        super().__init__()
        self.clock = clock
        self.din = data_in
        self.write = write_en
        self.address = address
        self.out = data_out
        self.memory = [0xf5]*256
    
    def run(self):
        self.out <<= self.memory[self.address.getIntValue()]
        if self.clock.isRisingEdge():
            if self.write == 1:
                self.memory[self.address.getIntValue()] = self.din.getIntValue()
