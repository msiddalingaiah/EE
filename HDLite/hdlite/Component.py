
from hdlite import Simulation as sim
from hdlite import Signal as sig

class Component(object):
    def __init__(self, name='top'):
        self.name = name
        self.nextTime = 0
        self.signalMap = {}
        self.componentMap = {}
        self.parent = None
        sim.simulation.addComponent(self)

    def wait(self, time):
        if sim.simulation.time >= self.nextTime :
            self.nextTime = sim.simulation.time + time

    def addSignals(self):
        for name, var in self.__dict__.items():
            if isinstance(var, (sig.Signal, sig.Vector)):
                self.signalMap[name] = var
        for name, comp in self.componentMap.items():
            comp.addSignals()

    def addComponents(self):
        for name, comp in self.__dict__.items():
            if isinstance(comp, (Component)):
                comp.addComponents()
                comp.name = name
                self.componentMap[name] = comp
                comp.setParent(self)

    def setParent(self, parent):
        self.parent = parent
    
    def getParent(self):
        return self.parent
    
    def getName(self):
        return self.name
    
    def getComponents(self):
        return list(self.componentMap.values())
    
    def assertTrue(self, value):
        if value == 0:
            raise Exception(f'Expected 0, found {value}')
        return 1
    
    def assertFalse(self, value):
        if value != 0:
            raise Exception(f'Expected not 0, found {value}')
        return 1
    
    def assertEquals(self, expected, value):
        if expected != value:
            raise Exception(f'Expected {expected}, found {value}')
        return 1
    
    def getNextTime(self):
        return self.nextTime

    def containsSignal(self, name):
        return name in self.signalMap
    
    def getSignal(self, name):
        return self.signalMap[name]

    def getComponent(self, name):
        return self.componentMap[name]

    def printAll(self, indent=0):
        tab = '    '*indent
        print(f'{tab} {self.name}:')
        for name in self.signalMap:
            print(f'  {tab} {name}')
        for comp in self.componentMap:
            self.componentMap[comp].printAll(indent+1)

    def run(self):
        pass

class Reset(Component):
    def __init__(self):
        super().__init__()
        self.reset = sig.Signal(0)
        self.resetn = sig.Signal(1)
        self.state = 0

    def run(self):
        if self.state == 0:
            self.reset <<= 0
            self.resetn <<= 1
            self.state += 1
            self.wait(3)
        elif self.state == 1:
            self.reset <<= 1
            self.resetn <<= 0
            self.state += 1
            self.wait(3)
        else:
            self.reset <<= 0
            self.resetn <<= 1
        
class Clock(Component):
    def __init__(self, nCycles=10):
        super().__init__()
        self.state = 0
        self.clock = sig.Signal(0)
        self.nCycles = nCycles << 1
        self.moreToDo = True

    def run(self):
        if self.state == 0:
            self.state = 1
            self.wait(5)
        elif self.state == 1:
            if self.nCycles != 0 and self.moreToDo:
                self.wait(5)
                self.clock <<= ~self.clock
                self.nCycles -= 1

    def stop(self):
        self.moreToDo = False
