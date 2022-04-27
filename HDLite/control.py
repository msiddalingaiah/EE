
from cgitb import reset
from hdlite import Simulation as sim
from hdlite import Signal as sig
import bitslice.bitslice_tb as bit

from hdlite.Component import *
from hdlite.ControlPanel import *
from bitslice.Am2909 import *
from bitslice.ROM import *
from bitslice.IO import *


class Counter(Component):
    def __init__(self, reset, clock, out, odd):
        super().__init__()
        self.clock = clock
        self.reset = reset
        self.out = out
        self.odd = odd

    def run(self):
        self.odd <<= self.out[0]
        if self.reset == 1:
            self.out <<= 0
        elif self.clock.isRisingEdge():
            if self.out < 10:
                self.out <<= self.out + 1

class BitsliceTB(Component):
    def __init__(self, reset, clock):
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
        self.reset = reset
        self.clock = clock
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

def runCounter():
    sim.simulation = sim.Simulation()
    clock = sig.Signal()
    reset = sig.Signal()
    out = sig.Vector(4)
    odd = sig.Signal()
    outputs = {'Out': out, 'Odd': odd}
    top = Counter(reset, clock, out, odd)
    sim.simulation.setTopComponent(top)
    app = App(reset, clock, outputs)
    app.mainloop()

def io_write(c):
    return (1 << 17) | (ord(c) << 8)

def runBitslice():
    sim.simulation = sim.Simulation()
    clock = sig.Signal()
    reset = sig.Signal()
    top = BitsliceTB(reset, clock)
    CONT = 0x80
    JUMP = 0xb0
    CALL = 0x70
    RTS = 0x20
    data = [CONT] * 16
    data[1] = CONT|io_write('H')
    data[3] = CONT|io_write('i')
    data[4] = CONT|io_write('\n')
    data[6] = JUMP|0
    for i in range(len(data)):
        top.rom.memory[i] = data[i]
    sim.simulation.setTopComponent(top)
    outputs = {'μWord': top.pipeline, 'Address': top.address,
        'I/O Write': top.io_write, 'I/O Char': top.io_char}
    app = App(reset, clock, outputs)
    app.mainloop()

if __name__ == '__main__':
    #runCounter()
    runBitslice()
