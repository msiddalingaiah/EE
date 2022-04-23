
from hdlite import Signal as sig

from hdlite.Component import *
from bitslice.Am2909 import *
from bitslice.ROM import *
from bitslice.IO import *

class bitslice_tb(Component):
    def __init__(self):
        super().__init__()
        self.address = sig.Vector(4)
        self.pipeline = sig.Vector(24)
        self.din = sig.Vector(4)
        self.rin = sig.Vector(4)
        self.orin = sig.Vector(4)
        self.s0 = sig.Signal()
        self.s1 = sig.Signal()
        self.zero = sig.Signal()
        self.cin = sig.Signal()
        self.re = sig.Signal()
        self.fe = sig.Signal()
        self.pup = sig.Signal()
        self.yout = sig.Vector(4)
        self.cout = sig.Signal()
        self.reset = Reset().reset
        self.clock = Clock(50).clock
        self.am0 = Am2909(self.reset, self.clock, self.din, self.rin, self.orin,
            self.s0, self.s1, self.zero, self.cin, self.re, self.fe, self.pup, self.yout, self.cout)
        self.data = sig.Vector(24)
        self.rom = ROM(self.address, self.data)
        self.io_char = sig.Vector(8)
        self.io_write = sig.Signal()
        self.io = IO(self.reset, self.clock, self.io_char, self.io_write)

    def run(self):
        self.address <<= self.yout
        self.din <<= self.pipeline[0:4]
        self.s1 <<= self.pipeline[5]
        self.s0 <<= self.pipeline[4]
        self.fe <<= self.pipeline[7]
        self.pup <<= self.pipeline[6]
        self.rin <<= 0
        self.orin <<= 0
        self.zero <<= 1
        self.cin <<= 1
        self.re <<= 1
        self.io_char <<= self.pipeline[8:16]
        self.io_write <<= self.pipeline[17]

        if self.clock.isRisingEdge():
            self.pipeline <<= self.data
