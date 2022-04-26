
import unittest

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
        self.flipped = 0
        self.clockcount = 0

    def run(self):
        if self.resetn == 0:
            self.q <<= 0
            self.qn <<= 1
        elif self.clock.isRisingEdge():
            self.clockcount += 1
            self.q <<= self.d
            self.qn <<= ~self.d
            if self.q.getIntValue() == 1:
                self.flipped += 1

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

class Pipeline(Component):
    def __init__(self):
        super().__init__()
        self.pipeline = sig.Vector(24)
        self.pipeline <<= 0x80
        self.s0 = sig.Signal()
        self.s1 = sig.Signal()
        self.fe = sig.Signal()
        self.pup = sig.Signal()

    def run(self):
        self.s1 <<= self.pipeline[5]
        self.s0 <<= self.pipeline[4]
        self.fe <<= self.pipeline[7]
        self.pup <<= self.pipeline[6]

class TestSignals(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        pass

    def setUp(self):
        sim.simulation = sim.Simulation()

    def tearDown(self):
        pass

    @classmethod
    def tearDownClass(cls):
        pass

    def x_test_slice_slow(self):
        x = sig.Vector(4)
        y = sig.Vector(4)
        y[1] <<= 5
        for s in y.signals:
            s.propagate()
        x[1:4] <<= y[0:3]
        for s in x.signals:
            s.propagate()
        self.assertEqual(str(x), '0b100')

    def test_slice_fast(self):
        x = sig.Vector(4)
        y = sig.Vector(4)
        y[1] <<= 5
        self.assertEqual(y.futureValue, 2)
        self.assertEqual(y.value, 0)
        y.propagate()
        self.assertEqual(y.value, 2)
        x[1:4] <<= y[0:3] & 0xf
        self.assertEqual(x.futureValue, 4)
        self.assertEqual(x.value, 0)
        x.propagate()
        self.assertEqual(x.value, 4)
        self.assertEqual(str(x), '0b100')

    def test_index_fast(self):
        x = sig.Vector(4)
        y = sig.Signal()
        z = sig.Signal()
        x <<= 0xa
        self.assertEqual(x.futureValue, 0xa)
        self.assertEqual(x.value, 0)
        x.propagate()
        y <<= x[1]
        self.assertEqual(y.futureValue, 1)
        self.assertEqual(y.value, 0)
        y.propagate()
        self.assertEqual(y.value, 1)
        z <<= x[0]
        self.assertEqual(z.futureValue, 0)
        self.assertEqual(z.value, 0)
        z.propagate()
        self.assertEqual(z.value, 0)

    def test_pipeline(self):
        pp = Pipeline()
        sim.simulation.run(pp)
        self.assertEquals(pp.fe.value, 1)
        self.assertEquals(pp.pup.value, 0)
        self.assertEquals(pp.s1.value, 0)
        self.assertEquals(pp.s0.value, 0)

    def testDFF(self):
        reset, clock = Reset(), Clock(11)

        din, q = sig.Signal(0), sig.Signal(0)
        qn = din
        
        dff = DFlipFlop("D1", clock.clock, reset.resetn, din, q, qn)
        sim.simulation.run(dff)
        self.assertEqual(dff.clockcount, 10)
        self.assertEqual(dff.flipped, 5)

    def testCounter(self):
        tb = CounterTB()
        sim.simulation.run(tb)
        self.assertEqual(tb.out, 10)

if __name__ == '__main__':
    unittest.main()