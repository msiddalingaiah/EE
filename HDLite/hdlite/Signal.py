
from hdlite import Simulation as sim

class Signal(object):
    def __init__(self, futureValue=0):
        # used to determine change
        self.priorValue = futureValue
        self.futureValue = futureValue
        self.value = futureValue
        sim.simulation.addSignal(self)

    def __len__(self):
        return 1

    def rhs(self, other):
        if isinstance(other, int):
            return other & 1
        if isinstance(other, (Signal, Vector, VectorSlice)):
            if len(other) != 1:
                raise Exception(f'Sizes do not match {len(self)} != {len(other)}')
            return other.getIntValue()
        raise Exception(f'Unexpected type {type(other)}')

    def __and__(self, other):
        return self.value & self.rhs(other)

    def __or__(self, other):
        return self.value | self.rhs(other)

    def __xor__(self, other):
        return self.value ^ self.rhs(other)

    def __lshift__(self, other):
        return self.value << self.rhs(other)
    
    # ~ (not)
    def __invert__(self):
        return 1 - self.value

    # x <<= y (assignment)
    def __ilshift__(self, other):
        self.futureValue = self.rhs(other)
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
        return self.value == self.rhs(other)
    
    def __str__(self):
        return str(self.value)

# Below is a faster implementation of Vector

class AbstractVector(object):
    def __init__(self, size):
        self.size = size
        self.mask = ~(-1 << size)

    def __len__(self):
        return self.size

    def rhs(self, other):
        if isinstance(other, int):
            return other & self.mask
        if isinstance(other, (Signal, Vector, VectorSlice)):
            if len(self) != len(other):
                raise Exception(f'Sizes do not match {len(self)} != {len(other)}')
            return other.getIntValue()
        raise Exception(f'Unexpected type {type(other)}')

    def __and__(self, other):
        return self.getIntValue() & self.rhs(other)

    def __or__(self, other):
        return self.getIntValue() | self.rhs(other)

    def __xor__(self, other):
        return self.getIntValue() ^ self.rhs(other)

    def __add__(self, other):
        return self.getIntValue() + self.rhs(other)

    def __sub__(self, other):
        return self.getIntValue() - self.rhs(other)

    def __lshift__(self, other):
        return self.getIntValue() << self.rhs(other)
    
    def __rshift__(self, other):
        return self.getIntValue() >> self.rhs(other)
    
    def __lt__(self, other):
        return self.getIntValue() < self.rhs(other)
    
    def __le__(self, other):
        return self.getIntValue() <= self.rhs(other)
    
    def __eq__(self, other):
        return self.getIntValue() == self.rhs(other)
    
    def __ge__(self, other):
        return self.getIntValue() >= self.rhs(other)
    
    def __gt__(self, other):
        return self.getIntValue() > self.rhs(other)
    
    # ~ (not)
    def __invert__(self):
        return (~self.getIntValue()) & self.mask

    def __str__(self):
        return bin(self.getIntValue())

class VectorSlice(AbstractVector):
    def __init__(self, vector, start, size):
        super().__init__(size)
        # Don't add this to simulation, composed vector was already added
        self.vector = vector
        self.start = start

    def getIntValue(self):
        value = (self.vector.getIntValue() >> self.start) & self.mask
        return value

    def __getitem__(self, index):
        raise Exception('Why are you slicing a slice?')

    # This must be defined, but don't do anything
    def __setitem__(self, index, value):
        pass

    # x <<= y (assignment)
    def __ilshift__(self, other):
        value = self.rhs(other)
        mask = self.mask << self.start
        fv = self.vector.futureValue
        fv = (fv & ~mask) | ((value & self.mask) << self.start)
        self.vector.futureValue = fv
        return self

class Vector(AbstractVector):
    def __init__(self, size, futureValue=0):
        super().__init__(size)
        self.priorValue = futureValue
        self.futureValue = futureValue
        self.value = futureValue
        sim.simulation.addSignal(self)

    def getIntValue(self):
        return self.value

    # Called once before deltaCycle to save state
    def prepare(self):
        self.priorValue = self.getIntValue()
    
    # Called multiple times to propagate value changes
    def propagate(self):
        changed = self.getIntValue() != self.futureValue
        self.value = self.futureValue
        return changed

    def isChanged(self):
        return self.getIntValue() != self.priorValue

    # x <<= y (assignment)
    def __ilshift__(self, other):
        self.futureValue = self.rhs(other)
        return self

    def __getitem__(self, index):
        if isinstance(index, slice):
            start = index.start
            stop = index.stop
            if start >= stop:
                raise Exception(f'Bit range must be greather than zero: {start}:{stop}')
            return VectorSlice(self, start, stop - start)
        return VectorSlice(self, index, 1)

    # This must be defined, but don't do anything
    def __setitem__(self, index, value):
        pass
