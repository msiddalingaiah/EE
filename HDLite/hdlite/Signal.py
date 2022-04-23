
from hdlite import Simulation as sim

class Signal(object):
    def __init__(self, futureValue=0):
        # used to determine change
        self.priorValue = futureValue
        self.futureValue = futureValue
        self.value = futureValue
        sim.simulation.addSignal(self)

    def assign(self, other):
        self.futureValue = other
        return self

    def __len__(self):
        return 1
        
    def __and__(self, other):
        return self.value & other.value

    def __or__(self, other):
        return self.value | other.value

    def __xor__(self, other):
        return self.value ^ other.value

    # ~ (not)
    def __invert__(self):
        return 1 - self.value

    # x <<= y (assignment)
    def __ilshift__(self, other):
        if isinstance(other, Signal):
            self.futureValue = other.value
        elif other:
            self.futureValue = 1
        else:
            self.futureValue = 0
        return self

    def getIntValue(self):
        return self.value

    # Called once before deltaCycle to save state
    def prepare(self):
        self.priorValue = self.value
    
    # Called multiple times to propagate value changes
    def propagate(self):
        changed = self.value != self.futureValue
        self.value = self.futureValue
        return changed

    def isChanged(self):
        return self.value != self.priorValue

    def isRisingEdge(self):
        # Doesn't seem right, but it seems to work :-(
        return self.isChanged() and self.value == 1

    def isFallingEdge(self):
        return self.isChanged() and self.value == 0

    def __eq__(self, other):
        if isinstance(other, Signal):
            return self.value == other.value
        else:
            return self.value == other
    
    def __str__(self):
        return str(self.value)

class Vector(object):
    def __init__(self, size, futureValue=0):
        self.signals = []
        # little endian, e.g. bit 0 = LSB
        mask = 0x1
        for i in range(size):
            bit = 0
            if futureValue & mask > 0:
                bit = 1
            self.signals.append(Signal(bit))
            mask <<= 1

    def assign(self, other):
        for i in range(len(self.signals)):
            self.signals[i].assign(other & 0x01);
            other >>= 1
        return self
    
    def __len__(self):
        return len(self.signals)

    def __getitem__(self, index):
        if isinstance(index, slice):
            start = index.start
            stop = index.stop
            if start >= stop:
                raise Exception(f'Bit range must be greather than zero: {start}:{stop}')
            vec = Vector(0)
            vec.signals = self.signals[index]
            return vec
        return self.signals[index]

    # This must be defined, but don't do anything
    def __setitem__(self, index, value):
        pass

    def __and__(self, other):
        if isinstance(other, Vector) or isinstance(other, Signal):
            return self.getIntValue() & other.getIntValue()
        else:
            return self.getIntValue() & other
        return self

    def __or__(self, other):
        if isinstance(other, Vector) or isinstance(other, Signal):
            return self.getIntValue() | other.getIntValue()
        else:
            return self.getIntValue() | other
        return self

    def __xor__(self, other):
        if isinstance(other, Vector) or isinstance(other, Signal):
            return self.getIntValue() ^ other.getIntValue()
        else:
            return self.getIntValue() ^ other
        return self

    def __add__(self, other):
        if isinstance(other, Vector) or isinstance(other, Signal):
            return self.getIntValue() + other.getIntValue()
        else:
            return self.getIntValue() + other
        return self

    def __sub__(self, other):
        if isinstance(other, Vector) or isinstance(other, Signal):
            return self.getIntValue() - other.getIntValue()
        else:
            return self.getIntValue() - other
        return self

    def __lshift__(self, other):
        if isinstance(other, Vector) or isinstance(other, Signal):
            return self.getIntValue() << other.getIntValue()
        else:
            return self.getIntValue() << other
        return self
    
    def __rshift__(self, other):
        if isinstance(other, Vector) or isinstance(other, Signal):
            return self.getIntValue() >> other.getIntValue()
        else:
            return self.getIntValue() >> other
        return self
    
    # x <<= y (assignment)
    def __ilshift__(self, other):
        if isinstance(other, Vector):
            if len(self) != len(other):
                raise Exception('Size mismatch: %d bits <<= %d bits' % (len(self), len(other)))
            for i in range(len(self)):
                self.signals[i] <<= other.signals[i]
        else:
            mask = 0x1
            for s in self.signals:
                bit = 0
                if other & mask > 0:
                    bit = 1
                s <<= bit
                mask <<= 1
        return self

    def getIntValue(self):
        mask = 0x1
        result = 0
        for s in self.signals:
            if s == 1:
                result |= mask
            mask <<= 1
        return result

    def __lt__(self, other):
        if isinstance(other, Vector):
            return self.getIntValue() < other.getIntValue()
        else:
            return self.getIntValue() < other
    
    def __le__(self, other):
        if isinstance(other, Vector):
            return self.getIntValue() <= other.getIntValue()
        else:
            return self.getIntValue() <= other
    
    def __eq__(self, other):
        if isinstance(other, Vector):
            return self.getIntValue() == other.getIntValue()
        else:
            return self.getIntValue() == other
    
    def __ge__(self, other):
        if isinstance(other, Vector):
            return self.getIntValue() >= other.getIntValue()
        else:
            return self.getIntValue() >= other
    
    def __gt__(self, other):
        if isinstance(other, Vector):
            return self.getIntValue() > other.getIntValue()
        else:
            return self.getIntValue() > other
    
    def __str__(self):
        return bin(self.getIntValue())
