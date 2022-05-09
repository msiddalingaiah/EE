
from hdlite import Signal as sig

from hdlite.Component import *

class Am2901(Component):
    def __init__(self, clock, din, aSel, bSel, aluSrc, aluOp, aluDest, cin, yout, cout, fzero, f3, ovr):
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
        self.fzero = fzero
        self.f3 = f3
        self.ovr = ovr
        self.regs = [0]*16
        self.q = sig.Vector(4)
        self.f = sig.Vector(5)
        self.writeRam = sig.Signal()
        self.writeQ = sig.Signal()

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

        self.f <<= 0
        if self.aluOp == 0:
            self.f <<= r + s + self.cin.getIntValue()
        elif self.aluOp == 1:
            self.f <<= s + ((~r) & 0xf) + self.cin.getIntValue()
        elif self.aluOp == 2:
            self.f <<= r + ((~s) & 0xf) + self.cin.getIntValue()
        elif self.aluOp == 3:
            self.f <<= r | s
        elif self.aluOp == 4:
            self.f <<= r & s
        elif self.aluOp == 5:
            self.f <<= ~r + s
        elif self.aluOp == 6:
            self.f <<= r ^ s
        elif self.aluOp == 7:
            self.f <<= ~(r ^ s)

        self.cout <<= self.f[4]
        self.fzero <<= 0
        if self.f[0:4] == 0:
            self.fzero <<= 1
        self.f3 <<= self.f[3]

        # TODO: compute self.ovr
        
        qv = 0
        bv = 0
        self.writeQ <<= 0
        self.writeRam <<= 0
        fvalue = self.f[0:4].getIntValue()
        if self.aluDest == 0:
            self.yout <<= self.f[0:4]
            qv = fvalue
            self.writeQ <<= 1
        elif self.aluDest == 1:
            self.yout <<= fvalue
        elif self.aluDest == 2:
            self.yout <<= a
            bv = fvalue
            self.writeRam <<= 1
        elif self.aluDest == 3:
            self.yout <<= fvalue
            bv = fvalue
            self.writeRam <<= 1
        elif self.aluDest == 4:
            self.yout <<= fvalue
            qv = self.q.getIntValue() >> 1
            bv = fvalue >> 1
            self.writeRam <<= 1
            self.writeQ <<= 1
        elif self.aluDest == 5:
            self.yout <<= fvalue
            bv = fvalue >> 1
            self.writeRam <<= 1
        elif self.aluDest == 6:
            self.yout <<= fvalue
            qv = self.q.getIntValue() << 1
            bv = fvalue << 1
            self.writeRam <<= 1
            self.writeQ <<= 1
        elif self.aluDest == 7:
            self.yout <<= fvalue
            bv = fvalue << 1
            self.writeRam <<= 1

        if self.clock.isRisingEdge():
            if self.writeQ == 1:
                self.q <<= qv
            if self.writeRam == 1:
                self.regs[self.bSel.getIntValue()] = bv
