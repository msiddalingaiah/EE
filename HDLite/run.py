
from hdlite import Simulation as sim
from hdlite import Signal as sig

from hdlite.Component import *


class DFlipFlop(Component):
    def __init__(self, name, clock, resetn, d, q, qn):
        super().__init__(name)
        self.d = d
        self.q = q
        self.qn = qn
        self.clock = clock
        self.resetn = resetn

    def run(self):
        if self.resetn == 0:
            self.q <<= 0
            self.qn <<= 1
        elif self.clock.isRisingEdge():
            self.q <<= self.d
            self.qn <<= ~self.d

def testDFF():
    sim.simulation = sim.Simulation('vcd/dff.vcd')
    
    reset = Reset()
    clock = Clock(10)

    din = sig.Signal(0)
    q = sig.Signal(0)
    qn = din
    
    top = DFlipFlop("D1", clock.clock, reset.resetn, din, q, qn)
    sim.simulation.run(top)

class Counter(Component):
    def __init__(self, resetn, clock, out):
        super().__init__()
        self.clock = clock
        self.resetn = resetn
        self.out = out

    def run(self):
        if self.resetn == 0:
            self.out <<= 0
        elif self.clock.isRisingEdge():
            if self.out < 10:
                self.out <<= self.out + 1

class CounterTB(Component):
    def __init__(self):
        super().__init__()
        self.reset = Reset()
        self.clock = Clock(20)
        self.out = sig.Vector(4)
        self.c1 = Counter(self.reset.resetn, self.clock.clock, self.out)

def testCounter():
    sim.simulation = sim.Simulation('vcd/counter.vcd')
    sim.simulation.run(CounterTB())

import bitslice.bitslice_tb as bit

def io_write(c):
    return (1 << 17) | (ord(c) << 8)

def testBitslice():
    sim.simulation = sim.Simulation('vcd/bitslice.vcd')
    tb = bit.bitslice_tb()
    CONT = 0x80
    JUMP = 0xb0
    CALL = 0x70
    RTS = 0x20
    data = [CONT] * 16
    data[1] = CONT|io_write('H')
    data[3] = CONT|io_write('i')
    data[5] = CONT|io_write('\n')
    data[6] = JUMP|0
    for i in range(len(data)):
        tb.rom.memory[i] = data[i]
    sim.simulation.run(tb)

if __name__ == '__main__':
    #testDFF()
    #testCounter()
    testBitslice()
