
from hdlite import Signal as sig

from hdlite.Component import *
from bitslice.Am2909 import *
from bitslice.Am2911 import *
from bitslice.Am2901 import *
from bitslice.ROM import *
from bitslice.IO import *

class CPU6(Component):
    def __init__(self, reset, clock, zero, dataBus, addressBus):
        super().__init__()
        self.reset = reset
        self.clock = clock
        self.zero = zero

        # 6309 ROM
        self.map_rom_address = sig.Vector(8)
        self.map_rom_data = sig.Vector(8)
        self.map_rom = ROM(self.map_rom_address, self.map_rom_data)

        # Microcode ROM(s)
        self.uc_rom_address = sig.Vector(12)
        self.uc_rom_data = sig.Vector(56)
        self.uc_rom = ROM(self.uc_rom_address, self.uc_rom_data)
        self.pipeline = sig.Vector(56)

        # Am2909/2911 Microsequencers
        self.seq0_din = sig.Vector(4)
        self.seq0_rin = sig.Vector(4)
        self.seq0_orin = sig.Vector(4)
        self.seq0_s0 = sig.Signal()
        self.seq0_s1 = sig.Signal()
        self.seq0_zero = sig.Signal()
        self.seq0_cin = sig.Signal()
        self.seq0_re = sig.Signal()
        self.seq0_fe = sig.Signal()
        self.seq0_pup = sig.Signal()
        self.seq0_yout = sig.Vector(4)
        self.seq0_cout = sig.Signal()
        self.seq0 = Am2909(self.reset, self.clock, self.seq0_din, self.seq0_rin, self.seq0_orin,
            self.seq0_s0, self.seq0_s1, self.seq0_zero, self.seq0_cin, self.seq0_re, self.seq0_fe,
            self.seq0_pup, self.seq0_yout, self.seq0_cout)

        self.seq1_din = sig.Vector(4)
        self.seq1_rin = sig.Vector(4)
        self.seq1_orin = sig.Vector(4)
        self.seq1_s0 = sig.Signal()
        self.seq1_s1 = sig.Signal()
        self.seq1_zero = sig.Signal()
        self.seq1_cin = sig.Signal()
        self.seq1_re = sig.Signal()
        self.seq1_fe = sig.Signal()
        self.seq1_pup = sig.Signal()
        self.seq1_yout = sig.Vector(4)
        self.seq1_cout = sig.Signal()
        self.seq1 = Am2909(self.reset, self.clock, self.seq1_din, self.seq1_rin, self.seq1_orin,
            self.seq1_s0, self.seq1_s1, self.seq1_zero, self.seq1_cin, self.seq1_re, self.seq1_fe,
            self.seq1_pup, self.seq1_yout, self.seq1_cout)

        self.seq2_din = sig.Vector(4)
        self.seq2_orin = sig.Vector(4)
        self.seq2_s0 = sig.Signal()
        self.seq2_s1 = sig.Signal()
        self.seq2_zero = sig.Signal()
        self.seq2_cin = sig.Signal()
        self.seq2_re = sig.Signal()
        self.seq2_fe = sig.Signal()
        self.seq2_pup = sig.Signal()
        self.seq2_yout = sig.Vector(4)
        self.seq2_cout = sig.Signal()
        self.seq2 = Am2911(self.reset, self.clock, self.seq2_din, self.seq2_orin,
            self.seq2_s0, self.seq2_s1, self.seq2_zero, self.seq2_cin, self.seq2_re, self.seq2_fe,
            self.seq2_pup, self.seq2_yout, self.seq2_cout)

        # Am2901 ALUs
        self.alu0_din = sig.Vector(4)
        self.alu0_a = sig.Vector(4)
        self.alu0_b = sig.Vector(4)
        self.alu0_src = sig.Vector(3)
        self.alu0_op = sig.Vector(3)
        self.alu0_dest = sig.Vector(3)
        self.alu0_cin = sig.Signal()
        self.alu0_yout = sig.Vector(4)
        self.alu0_cout = sig.Signal()
        self.alu0_f0 = sig.Signal()
        self.alu0_f3 = sig.Signal()
        self.alu0_ovr = sig.Signal()
        self.alu0 = Am2901(clock, self.alu0_din, self.alu0_a, self.alu0_b, self.alu0_src,
            self.alu0_op, self.alu0_dest, self.alu0_cin, self.alu0_yout, self.alu0_cout,
            self.alu0_f0, self.alu0_f3, self.alu0_ovr)

        self.alu1_din = sig.Vector(4)
        self.alu1_a = sig.Vector(4)
        self.alu1_b = sig.Vector(4)
        self.alu1_src = sig.Vector(3)
        self.alu1_op = sig.Vector(3)
        self.alu1_dest = sig.Vector(3)
        self.alu1_cin = sig.Signal()
        self.alu1_yout = sig.Vector(4)
        self.alu1_cout = sig.Signal()
        self.alu1_f0 = sig.Signal()
        self.alu1_f3 = sig.Signal()
        self.alu1_ovr = sig.Signal()
        self.alu1 = Am2901(clock, self.alu1_din, self.alu1_a, self.alu1_b, self.alu1_src,
            self.alu1_op, self.alu1_dest, self.alu1_cin, self.alu1_yout, self.alu1_cout,
            self.alu1_f0, self.alu1_f3, self.alu1_ovr)

        # ALU flags
        self.alu_zero = sig.Signal()

        # Busses
        self.iDBus = sig.Vector(8)
        self.FBus = sig.Vector(8)
        self.dataBus = dataBus
        self.addressBus = addressBus

        # Constant (immediate data)
        self.constant = sig.Vector(8)

        # Enables
        self.d2d3 = sig.Vector(4)
        self.e7 = sig.Vector(2)
        self.h11 = sig.Vector(3)
        self.k11 = sig.Vector(3)
        self.e6 = sig.Vector(3)

        # Shift/carry select
        self.shift_carry = sig.Vector(2)

        # Trace signals
        self.aluR0 = sig.Vector(8)
        self.case = sig.Signal()

    def run(self):
        if self.reset == 1:
            pass

        # Sequencer 0
        self.seq0_din <<= self.pipeline[16:20]
        self.seq0_rin <<= self.map_rom_data[0:4]
        self.seq0_orin <<= 0
        # Case control
        self.case <<= self.pipeline[33]
        if self.pipeline[33] == 0:
            self.seq0_orin[1] <<= self.alu_zero
        self.seq0_s0 <<= ~self.pipeline[29]
        self.seq0_s1 <<= ~self.pipeline[30]
        self.seq0_zero <<= self.zero
        self.seq0_cin <<= 1
        self.seq0_re <<= 1
        self.seq0_fe <<= self.pipeline[27]
        self.seq0_pup <<= self.pipeline[28]
        self.uc_rom_address[0:4] <<= self.seq0_yout[0:4]

        # Sequencer 1
        self.seq1_din <<= self.pipeline[20:24]
        self.seq1_rin <<= self.map_rom_data[4:8]
        self.seq1_orin <<= 0
        self.seq1_s0 <<= ~self.pipeline[31]
        if self.pipeline[54] == 0:
            self.seq1_s1 <<= 0
        else:
            self.seq1_s1 <<= ~self.pipeline[32]
        self.seq1_zero <<= self.zero
        self.seq1_cin <<= self.seq0_cout
        self.seq1_re <<= 1
        self.seq1_fe <<= self.pipeline[27]
        self.seq1_pup <<= self.pipeline[28]
        self.uc_rom_address[4:8] <<= self.seq1_yout[0:4]

        # Sequencer 2
        self.seq2_din[0:3] <<= self.pipeline[24:27]
        self.seq2_orin <<= 0
        self.seq2_s0 <<= ~self.pipeline[31]
        self.seq2_s1 <<= ~self.pipeline[32]
        self.seq2_zero <<= self.zero
        self.seq2_cin <<= self.seq1_cout
        self.seq2_re <<= 1
        self.seq2_fe <<= self.pipeline[27]
        self.seq2_pup <<= self.pipeline[28]
        self.uc_rom_address[8:11] <<= self.seq2_yout[0:3]

        # ALU 0
        self.alu0_din <<= self.iDBus[0:4]
        self.alu0_a <<= self.pipeline[47:51]
        self.alu0_b <<= self.pipeline[43:47]
        self.alu0_src <<= self.pipeline[34:37]
        self.alu0_op <<= self.pipeline[37:40]
        self.alu0_dest <<= self.pipeline[40:43]
        self.alu0_cin <<= 0
        if self.shift_carry == 0:
            self.alu0_cin <<= 0
        elif self.shift_carry == 1:
            self.alu0_cin <<= 1
        elif self.shift_carry == 2:
            self.alu0_cin <<= self.alu1_cout
        elif self.shift_carry == 3:
            self.alu0_cin <<= 0

        # ALU 1
        self.alu1_din <<= self.iDBus[4:8]
        self.alu1_a <<= self.pipeline[47:51]
        self.alu1_b <<= self.pipeline[43:47]
        self.alu1_src <<= self.pipeline[34:37]
        self.alu1_op <<= self.pipeline[37:40]
        self.alu1_dest <<= self.pipeline[40:43]
        self.alu1_cin <<= self.alu0_cout

        # Shift/carry select
        self.shift_carry <<= self.pipeline[51:51+2]

        # Constant (immediate data)
        self.constant <<= ~self.pipeline[16:16+8]

        # Enables
        # d2d3 is decoded before pipeline, but outputs are registered.
        self.d2d3 <<= self.pipeline[0:4]
        self.e6 <<= self.pipeline[4:4+3]
        self.k11 <<= self.pipeline[7:7+3]
        self.h11 <<= self.pipeline[10:10+3]
        self.e7 <<= self.pipeline[13:13+2]

        # Datapath
        self.iDBus <<= 0
        self.FBus <<= 0

        if self.d2d3 == 13:
            self.iDBus <<= self.constant
        elif self.d2d3 == 10:
            self.iDBus <<= self.dataBus
            # force instruction for testing
            self.iDBus <<= 0x01

        # ALU trace
        self.aluR0 <<= (self.alu1.regs[0] << 4) | self.alu0.regs[0]

        if self.clock.isRisingEdge():
            self.pipeline <<= self.uc_rom_data
            self.alu_zero <<= self.alu0_f0 & self.alu1_f0
            #r7 = (self.alu1.regs[7] << 4) | self.alu0.regs[7]
            #print(f'r7 = {r7}')