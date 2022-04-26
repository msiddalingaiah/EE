
from hdlite import Signal as sig

from hdlite.Component import *

from bitslice.Memory import *

class Am2909(Component):
    def __init__(self, reset, clock, din, rin, orin, s0, s1, zero, cin, re, fe, pup, yout, cout):
        super().__init__()
        self.clock = clock
        self.din = din
        self.rin = rin
        self.orin = orin
        self.s0 = s0
        self.s1 = s1
        self.zero = zero
        self.cin = cin
        self.re = re
        self.fe = fe
        self.pup = pup
        self.yout = yout
        self.cout = cout
        self.pc = sig.Vector(4)
        self.ar = sig.Vector(4)
        self.sp = sig.Vector(2)
        self.mux = sig.Vector(4)
        self.stackIn = sig.Vector(4)
        self.stackWr = sig.Signal()
        self.stackOut = sig.Vector(4)
        self.stackAddr = sig.Vector(2)
        self.clock = clock
        self.reset = reset
        self.stack = Memory(reset, clock, self.stackIn, self.stackWr, self.stackAddr, self.stackOut)

    def run(self):
        if self.reset == 1:
            self.pc <<= 0
            self.ar <<= 0
            self.sp <<= 3
        if (self.s1 == 0) & (self.s0 == 0):
            self.mux <<= self.pc
        if (self.s1 == 0) & (self.s0 == 1):
            self.mux <<= self.ar
        if (self.s1 == 1) & (self.s0 == 0):
            self.mux <<= self.stackOut
        if (self.s1 == 1) & (self.s0 == 1):
            self.mux <<= self.din
        self.cout <<= (self.cin == 1) & (self.mux == 0xf)
        if self.zero == 0:
            self.yout <<= 0
        else:
            self.yout <<= self.mux | self.orin
        
        self.stackIn <<= self.pc
        self.stackWr <<= 0
        if self.fe == 0:
            if self.pup == 1:
                self.stackWr <<= 1
                # Lookahead to pre-increment stack pointer
                self.stackAddr <<= self.sp + 1
            else:
                self.stackAddr <<= self.sp
        if self.clock.isRisingEdge():
            if self.cin == 1:
                self.pc <<= self.mux + 1
            if self.re == 0:
                self.ar <<= self.rin            
            if self.fe == 0:
                if self.pup == 1:
                    self.sp <<= self.sp + 1
                else:
                    self.sp <<= self.sp - 1
