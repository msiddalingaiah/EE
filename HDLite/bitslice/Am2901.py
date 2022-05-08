
from hdlite import Signal as sig

from hdlite.Component import *

class Am2901(Component):
    def __init__(self, clock, din, aSel, bSel, aluSrc, aluOp, aluDest, cin, yout, cout, f0, f3, ovr):
        super().__init__()
        self.clock = clock
        self.din = din
        self.aSel = aSel
        self.bSel = bSel
        self.aluSrc = aluSrc
        self.aluOp = aluOp
        self.aluDest = aluDest
        self.cin = cin
        self.yout = yout
        self.cout = cout
        self.f0 = f0
        self.f3 = f3
        self.ovr = ovr
        self.regs = [0]*16
        self.q = sig.Vector(4)

    def run(self):
        a = self.regs[self.aSel.getIntValue()]
        b = self.regs[self.bSel.getIntValue()]
        r = 0
        s = 0
        if self.aluSrc == 0:
            r = a
            s = self.q.getIntValue()
        elif self.aluSrc == 1:
            r = a
            s = b
        elif self.aluSrc == 2:
            r = 0
            s = self.q.getIntValue()
        elif self.aluSrc == 3:
            r = 0
            s = b
        elif self.aluSrc == 4:
            r = 0
            s = a
        elif self.aluSrc == 5:
            r = self.din.getIntValue()
            s = a
        elif self.aluSrc == 6:
            r = self.din.getIntValue()
            s = self.q.getIntValue()
        elif self.aluSrc == 7:
            r = self.din.getIntValue()
            s = 0

        f = 0
        if self.aluOp == 0:
            f = r + s + self.cin.getIntValue()
        elif self.aluOp == 1:
            f = s + ((~r) & 0xf) + self.cin.getIntValue()
        elif self.aluOp == 2:
            f = r + ((~s) & 0xf) + self.cin.getIntValue()
        elif self.aluOp == 3:
            f = r | s
        elif self.aluOp == 4:
            f = r & s
        elif self.aluOp == 5:
            f = ~r + s
        elif self.aluOp == 6:
            f = r ^ s
        elif self.aluOp == 7:
            f = ~(r ^ s)

        self.cout <<= (f >> 4) & 1
        f &= 0xf
        self.f0 <<= 0
        if f == 0:
            self.f0 <<= 1
        self.f3 <<= (f >> 3) & 1

        # TODO: compute self.ovr
        
        qv = 0
        bv = 0
        if self.aluDest == 0:
            self.yout <<= f
            qv = f
        elif self.aluDest == 1:
            self.yout <<= f
        elif self.aluDest == 2:
            self.yout <<= a
            bv = f
        elif self.aluDest == 3:
            self.yout <<= f
            bv = f
        elif self.aluDest == 4:
            self.yout <<= f
            qv = self.q.getIntValue() >> 1
            bv = f >> 1
        elif self.aluDest == 5:
            self.yout <<= f
            bv = f >> 1
        elif self.aluDest == 6:
            self.yout <<= f
            qv = self.q.getIntValue() << 1
            bv = f << 1
        elif self.aluDest == 7:
            self.yout <<= f
            bv = f << 1

        if self.clock.isRisingEdge():
            self.q <<= qv
            self.regs[self.bSel.getIntValue()] = bv
