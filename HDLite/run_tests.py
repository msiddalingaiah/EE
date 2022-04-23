
import unittest

from hdltest import TestSignals

from hdlite import Signal as sig
from hdlite import Simulation as sim

class Test(object):
    def __init__(self, value):
        self.value = value

    def __ilshift__(self, other):
        print(f'ilshift {self} {other}')
        return self

    def __le__(self, other):
        print(f'le {other}')
        return self.value

    def __getitem__(self, index):
        print(f'getitem {self} {index}')
        return Test(self.value[index])

    def __setitem__(self, index, value):
        print(f'setitem {self} {index} {value}')
        return self.value

    def __str__(self):
        return self.value

def testFunctions():
    x = Test('x12345')
    y = Test('yabcdef')
    #x <<= y[3]
    x[2:4] <<= y[3:5]

def testSlice():
    sim.simulation = sim.Simulation('vcd/foo.vcd')
    x = sig.Vector(4)
    y = sig.Vector(4)
    y[1] <<= 5
    for s in y.signals:
        s.propagate()
    x[1:4] <<= y[0:3]
    for s in x.signals:
        s.propagate()
    assert str(x) == '0b100'

def suite():
    suite = unittest.TestSuite()
    suite.addTest(TestSignals.TestSignals())
    return suite

if __name__ == '__main__':
    loader = unittest.TestLoader()
    suite = loader.discover('hdltest')
    runner = unittest.TextTestRunner()
    runner.run(suite)