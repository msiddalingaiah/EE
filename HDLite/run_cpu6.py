
from hdlite import Simulation as sim
from hdlite import Signal as sig

from hdlite.Component import *
from hdlite.ControlPanel import *
from Centurion.CPU6 import *

def read_ucode():
    # Improved logical bit order
    romMap = [4, 1, 2, 5, 6, 3, 0]
    # Board order
    #romMap = [0, 1, 2, 3, 4, 5, 6]
    uc_roms = []
    for i in romMap:
        with open(f'Centurion/roms/CPU-AM27S191-L{i+1}.circ', 'rb') as f:
            uc_roms.append(f.read())
    ucode = []
    for i in range(2048):
        word = 0
        for rom in uc_roms:
            word <<= 8
            word |= rom[i]
        ucode.append(word)
    return ucode

def read_map_rom():
    data = None
    with open(f'Centurion/roms/CPU-6309.circ', 'rb') as f:
        data = f.read()
    return data

class CPU6TB(Component):
    def __init__(self):
        super().__init__()
        self.reset = Reset()
        self.clock = Clock(200)
        self.dataBus = sig.Vector(8)
        self.addressBus = sig.Vector(16)
        self.state = 0

        self.zero = sig.Signal()
        self.cpu6 = CPU6(self.reset.reset, self.clock.clock, self.zero, self.dataBus, self.addressBus)
        self.cpu6.uc_rom.memory = read_ucode()
        self.cpu6.map_rom.memory = read_map_rom()

    def run(self):
        if self.state == 0:
            self.zero <<= 1
            self.state += 1
            self.wait(2)
        elif self.state == 1:
            self.zero <<= 0
            self.state += 1
            self.wait(7)
        else:
            self.zero <<= 1

def simCPU6():
    sim.simulation = sim.Simulation('vcd/cpu6.vcd')
    sim.simulation.run(CPU6TB())

def runCPU6():
    sim.simulation = sim.Simulation()
    reset = sig.Signal()
    clock = sig.Signal()
    zero = sig.Signal()
    dataBus = sig.Vector(8)
    addressBus = sig.Vector(16)
    top = CPU6(reset, clock, zero, dataBus, addressBus)
    top.uc_rom.memory = read_ucode()
    top.map_rom.memory = read_map_rom()

    sim.simulation.setTopComponent(top)
    outputs = {'Databus':dataBus, 'Addressbus':addressBus}
    internal = {'0:S0': top.seq0.s0, '0:S1': top.seq0.s1,
        '1:S0': top.seq1.s0, '1:S1': top.seq1.s1,
        '2:S0': top.seq2.s0, '2:S1': top.seq2.s1,
        'μWord': top.pipeline, 'ROM Address': top.uc_rom_address, 'ROM data': top.uc_rom_data}
    inputs = {'Zero': zero}
    app = App(reset, clock, inputs, internal, outputs)
    app.mainloop()

if __name__ == '__main__':
    #runCPU6()
    simCPU6()

