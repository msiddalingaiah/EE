
from hdlite import Simulation as sim
from hdlite import Signal as sig

from hdlite.Component import *
from hdlite.ControlPanel import *
from Centurion.CPU6 import *
from bitslice.Memory import *

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
        self.clock = Clock(250)
        self.dataBus = sig.Vector(8)
        self.addressBus = sig.Vector(16)
        self.state = 0

        self.zero = sig.Signal()
        self.cpu = CPU6(self.reset.reset, self.clock.clock, self.zero, self.dataBus, self.addressBus)
        self.cpu.uc_rom.memory = read_ucode()
        self.cpu.map_rom.memory = read_map_rom()

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

class CPU6TBPanel(Component):
    def __init__(self, reset, clock, zero, dataInBus, writeEnBus, addressBus, dataOutBus):
        super().__init__()
        self.reset = reset
        self.clock = clock
        self.zero = zero
        self.dataInBus = dataInBus
        self.writeEnBus = writeEnBus
        self.addressBus = addressBus
        self.dataOutBus = dataOutBus
        self.cpu = CPU6(self.reset, self.clock, self.zero, self.dataInBus, self.writeEnBus, self.addressBus, self.dataOutBus)
        self.memory = Memory(self.reset, self.clock, self.dataOutBus, self.writeEnBus, self.addressBus, self.dataInBus)
        self.memory.read('Centurion/programs/hellorld.txt')
        self.cpu.uc_rom.memory = read_ucode()
        self.cpu.map_rom.memory = read_map_rom()

    def run(self):
        if self.writeEnBus == 1:
            # Pretend there's a UART here :-)
            if self.addressBus == 0x5a00:
                print(chr(self.dataOutBus), end='')
            # A hack to stop simulation
            #if (addressBus == 16'h5b00 && data_c2r == 8'h5a) begin
            #    sim_end <= 1;

def runCPU6():
    sim.simulation = sim.Simulation()
    reset = sig.Signal()
    clock = sig.Signal()
    zero = sig.Signal()
    dataInBus = sig.Vector(8)
    writeEnBus = sig.Signal()
    addressBus = sig.Vector(16)
    dataOutBus = sig.Vector(8)
    top = CPU6TBPanel(reset, clock, zero, dataInBus, writeEnBus, addressBus, dataOutBus)

    sim.simulation.setTopComponent(top)
    outputs = {'DataInbus':dataInBus, 'Addressbus':addressBus, 'DataOutbus':dataOutBus}
    internal = { 'μWord': top.cpu.pipeline, 'ROM Address': top.cpu.uc_rom_address,
        'DBus': top.cpu.DPBus, 'FBus': top.cpu.FBus, 'Result': top.cpu.result_register,
        'Flags': top.cpu.flags_register }
    inputs = {'Zero': zero}
    app = App(reset, clock, inputs, internal, outputs)
    app.mainloop()

if __name__ == '__main__':
    runCPU6()
    #simCPU6()

