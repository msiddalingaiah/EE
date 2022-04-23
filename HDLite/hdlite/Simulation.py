
# singleton
simulation = None

from hdlite import VCDFile as vcd
import time

class Simulation(object):
    def __init__(self, outputFileName=None):
        self.outputFileName = outputFileName
        timeScale = '1ns'
        if outputFileName:
            print(f'Start simulation {outputFileName} time scale {timeScale}')
        self.vcd = vcd.VCDFile(outputFileName, timeScale)
        self.components = []
        self.signals = []
        self.time = 0

    def addComponent(self, component):
        self.components.append(component)

    def addSignal(self, signal):
        self.signals.append(signal)

    def run(self, topComponent):
        topComponent.addComponents()
        topComponent.addSignals()
        startTime = time.time()
        self.vcd.addSignals(topComponent)
        self.propagateSignals()
        self.vcd.addInitialValues()
        moreToDo = True
        while moreToDo:
            moreToDo = self.runOneCycle()
            if not moreToDo:
                # Advance time to the next minimum wait time
                # First find max time
                nextTime = self.time
                for p in self.components:
                    if p.nextTime > nextTime:
                        nextTime = p.nextTime
                # print 'Advance max time: %d' % nextTime
                # Now find the minimum time which is not the current time
                for p in self.components:
                    if p.nextTime < nextTime and p.nextTime > self.time:
                        nextTime = p.nextTime
                if nextTime > self.time:
                    self.time = nextTime
                    moreToDo = self.runOneCycle()
            self.vcd.addTime(self.time)
            self.vcd.writeSignals()
        endTime = time.time()
        if self.outputFileName:
            print(f'Simulation finished at time {self.time} ns')
            print(f'Real time {endTime-startTime:.3f} s')
        self.vcd.close()
        
    def runOneCycle(self):
        for p in self.components:
            if self.time >= p.nextTime:
                p.wait(0)
                p.run()
        moreToDo = self.propagateSignals()
        return moreToDo

    def propagateSignals(self):
        for s in self.signals:
            s.prepare()
        iterations = 0
        while True:
            changed = False
            for s in self.signals:
                changed |= s.propagate()
            if not changed:
                break
            iterations += 1
            if iterations > 100:
                raise Exception('No convergence!')
        return iterations > 0

