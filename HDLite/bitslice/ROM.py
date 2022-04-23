
from hdlite import Signal as sig

from hdlite.Component import *

class ROM(Component):
    def __init__(self, address, out):
        super().__init__()
        self.address = address
        self.out = out
        self.memory = [0]*2048

    def run(self):
        self.out <<= self.memory[self.address.getIntValue()]
