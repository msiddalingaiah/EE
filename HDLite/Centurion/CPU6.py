
from hdlite import Signal as sig

from hdlite.Component import *
from bitslice.Am2909 import *
from bitslice.Am2911 import *
from bitslice.Am2901 import *
from bitslice.ROM import *
from bitslice.IO import *
from bitslice.RegisterRAM import *

class CPU6(Component):
    def __init__(self, reset, clock, zero, dataInBus, writeEnBus, addressBus, dataOutBus):
        super().__init__()
        self.reset = reset
        self.clock = clock
        self.zero = zero
        self.dataInBus = dataInBus
        self.writeEnBus = writeEnBus
        self.addressBus = addressBus
        self.dataOutBus = dataOutBus

        # Rising edge triggered registers
        self.work_address = sig.Vector(16)
        self.memory_address = sig.Vector(16)
        self.register_index = sig.Vector(8)
        self.result_register = sig.Vector(8)
        self.swap_register = sig.Vector(8)
        self.flags_register = sig.Vector(8)
        self.condition_codes = sig.Vector(4)
        self.bus_read = sig.Vector(8)

        # 6309 ROM
        self.map_rom_address = sig.Vector(8)
        self.map_rom_data = sig.Vector(8)
        self.map_rom = ROM(self.map_rom_address, self.map_rom_data)

        # Microcode ROM(s)
        self.uc_rom_address = sig.Vector(12)
        self.uc_rom_data = sig.Vector(56)
        self.uc_rom = ROM(self.uc_rom_address, self.uc_rom_data)
        self.pipeline = sig.Vector(56)

        # Synchronous Register RAM
        self.bit53 = sig.Signal() # pipeline[53];
        self.reg_low_select = sig.Signal() # bit53;
        # High/low register select, D10 74LS02 NOR gate
        self.reg_ram_addr = sig.Vector(8) # { register_index[7:1], ~(reg_low_select | register_index[0]) };
        self.rr_write_en = sig.Signal() # k11 == 4;
        self.reg_ram_data_in = sig.Vector(8) # result_register;
        self.reg_ram_data_out = sig.Vector(8)
        self.reg_ram = RegisterRAM(clock, self.rr_write_en, self.reg_ram_addr, self.reg_ram_data_in, self.reg_ram_data_out)

        # Sequencer shared nets

        self.seq_fe = sig.Signal() # pipeline[27] & jsr_;
        self.seq_pup = sig.Signal() # pipeline[28];
        self.seq_zero = sig.Signal() # !reset;

        # Am2909/2911 Microsequencers

        # Sequencer 0 (microcode address bits 3:0)
        self.seq0_din = sig.Vector(4) # pipeline[19:16];
        self.seq0_rin = sig.Vector(4) # FBus[3:0];
        self.seq0_orin = sig.Vector(4) 
        self.seq0_s0 = sig.Signal() # ~(pipeline[29] & jsr_);
        self.seq0_s1 = sig.Signal() # ~(pipeline[30] & jsr_);
        self.seq0_cin = sig.Signal() # 1;
        self.seq0_re = sig.Signal() # ;
        self.seq0_yout = sig.Vector(4) # ;
        self.seq0_cout = sig.Signal() # ;

        self.seq0 = Am2909(self.reset, self.clock, self.seq0_din, self.seq0_rin, self.seq0_orin,
            self.seq0_s0, self.seq0_s1, self.seq_zero, self.seq0_cin, self.seq0_re, self.seq_fe,
            self.seq_pup, self.seq0_yout, self.seq0_cout)

        # Case control
        self.case_ = sig.Signal() # pipeline[33];

        # Microcode conditional subroutine calls
        self.jsr_ = sig.Signal()

        # Sequencer 1 (microcode address bits 7:4)
        self.seq1_din = sig.Vector(4) # pipeline[20:24]
        self.seq1_rin = sig.Vector(4) # FBus[4:8]
        self.seq1_orin = sig.Vector(4)
        self.seq1_s0 = sig.Signal() # ~(pipeline[31] & jsr_);
        self.seq1_s1 = sig.Signal() # ~(~(pipeline[54] & ~pipeline[32]) & jsr_);
        self.seq1_cin = sig.Signal() # seq0_cout;
        self.seq1_re = sig.Signal() #;
        self.seq1_yout = sig.Vector(4) #;
        self.seq1_cout = sig.Signal() #;

        self.seq1 = Am2909(self.reset, self.clock, self.seq1_din, self.seq1_rin, self.seq1_orin,
            self.seq1_s0, self.seq1_s1, self.seq_zero, self.seq1_cin, self.seq1_re, self.seq_fe,
            self.seq_pup, self.seq1_yout, self.seq1_cout)

        # Sequencer 2 (microcode address bits 10:8)

        self.seq2_din = sig.Vector(4) # pipeline[24:27];
        self.seq2_s0 = sig.Signal() # ~(pipeline[31] & jsr_);
        self.seq2_s1 = sig.Signal() # ~(pipeline[32] & jsr_);
        self.seq2_cin = sig.Signal() # seq1_cout;
        self.seq2_re = sig.Signal() # 1;
        self.seq2_yout = sig.Vector(4) # ;
        self.seq2_cout = sig.Signal() # ;

        self.seq2 = Am2911(self.reset, self.clock, self.seq2_din,
            self.seq2_s0, self.seq2_s1, self.seq_zero, self.seq2_cin, self.seq2_re, self.seq_fe,
            self.seq_pup, self.seq2_yout, self.seq2_cout)

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

        # Shift/carry select
        self.shift_carry = sig.Vector(2) # pipeline[52:51];

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
        self.DPBus = sig.Vector(8)
        self.FBus = sig.Vector(8)

        # Constant (immediate data)
        self.constant = sig.Vector(8)

        # Enables
        self.d2d3 = sig.Vector(4)
        self.e7 = sig.Vector(2)
        self.h11 = sig.Vector(3)
        self.k11 = sig.Vector(3)
        self.e6 = sig.Vector(3)
        self.j13 = sig.Vector(2)
        self.k9 = sig.Vector(3)
        self.j12 = sig.Vector(2)

        # Trace signals
        self.aluR0 = sig.Vector(8)

    def run(self):
        if self.reset == 1:
            pass

        self.addressBus <<= self.memory_address

        self.bit53 <<= self.pipeline[53]
        self.reg_low_select <<= self.bit53
        # High/low register select, D10 74LS02 NOR gate
        self.reg_ram_addr <<= self.register_index[1:8] | ~(self.reg_low_select | self.register_index[0])
        self.rr_write_en <<= self.k11 == 4
        self.reg_ram_data_in <<= self.result_register

        self.seq_fe <<= self.pipeline[27] & self.jsr_
        self.seq_pup <<= self.pipeline[28]
        self.seq_zero <<= ~self.reset

        # Sequencer 0
        self.seq0_din <<= self.pipeline[16:20]
        self.seq0_rin <<= self.FBus[0:4]
        self.seq0_orin <<= 0
        self.seq0_s0 <<= ~(self.pipeline[29] & self.jsr_)
        self.seq0_s1 <<= ~(self.pipeline[30] & self.jsr_)
        self.seq0_cin <<= 1

        self.uc_rom_address[0:4] <<= self.seq0_yout[0:4]

        # Case control
        self.case_ <<= self.pipeline[33]

        # Sequencer 1 (microcode address bits 7:4)
        self.seq1_din <<= self.pipeline[20:24]
        self.seq1_rin <<= self.FBus[4:8]
        self.seq1_s0 <<= ~(self.pipeline[31] & self.jsr_)
        self.seq1_s1 <<= ~(~(self.pipeline[54] & ~self.pipeline[32]) & self.jsr_.getIntValue())
        self.seq1_cin <<= self.seq0_cout

        # Sequencer 1
        self.seq1_orin <<= 0
        self.seq1_re <<= 1
        self.uc_rom_address[4:8] <<= self.seq1_yout[0:4]

        # Sequencer 2 (microcode address bits 10:8)

        self.seq2_din <<= self.pipeline[24:27].getIntValue() # only three bits are used
        self.seq2_s0 <<= ~(self.pipeline[31] & self.jsr_)
        self.seq2_s1 <<= ~(self.pipeline[32] & self.jsr_)
        self.seq2_cin <<= self.seq1_cout
        self.seq2_re <<= 1

        # Sequencer 2
        self.uc_rom_address[8:11] <<= self.seq2_yout[0:3]

        if self.e6 == 6:
            self.seq0_re <<= 0
            self.seq1_re <<= 0

        # ALU 0
        self.alu0_din <<= self.DPBus[0:4]
        self.alu0_a <<= self.pipeline[47:51]
        self.alu0_b <<= self.pipeline[43:47]
        self.alu0_src <<= self.pipeline[34:37]
        self.alu0_op <<= self.pipeline[37:40]
        self.alu0_dest <<= self.pipeline[40:43]
        self.alu0_cin <<= 0

        # Shift/carry select
        self.shift_carry <<= self.pipeline[51:53]

        # ALU 1
        self.alu1_din <<= self.DPBus[4:8]
        self.alu1_a <<= self.pipeline[47:51]
        self.alu1_b <<= self.pipeline[43:47]
        self.alu1_src <<= self.pipeline[34:37]
        self.alu1_op <<= self.pipeline[37:40]
        self.alu1_dest <<= self.pipeline[40:43]
        self.alu1_cin <<= self.alu0_cout

        # Constant (immediate data)
        self.constant <<= ~self.pipeline[16:16+8]

        # Decoders
        # d2d3 is decoded before pipeline, but outputs are registered.
        self.d2d3 <<= self.pipeline[0:4]
        self.e7 <<= self.pipeline[13:13+2]
        self.h11 <<= self.pipeline[10:10+3]
        self.k11 <<= self.pipeline[7:7+3]
        self.e6 <<= self.pipeline[4:4+3]
        self.j13 <<= self.pipeline[4:6]
        self.k9 <<= self.pipeline[16:19]
        self.j12 <<= self.pipeline[16:18]

        # Datapath
        self.DPBus <<= 0
        self.FBus <<= 0

        # always @(*)
        self.jsr_ <<= 1
        if self.pipeline[15] == 0:
            if self.k9 == 2:
                self.jsr_ <<= ~self.register_index[0]

        self.alu0_cin <<= 0
        if self.shift_carry == 0:
            self.alu0_cin <<= 0
        if self.shift_carry == 1:
            self.alu0_cin <<= 1
        if self.shift_carry == 2:
            self.alu0_cin <<= self.flags_register[3]
        if self.shift_carry == 3:
            self.alu0_cin <<= 0

        self.seq0_orin <<= 0
        if self.case_ == 0:
            if self.j13 == 0:
                self.seq0_orin[0] <<= self.flags_register[1]
                self.seq0_orin[1] <<= self.flags_register[0]
                pass

        self.seq1_orin <<= 0

        self.seq0_re <<= 1
        self.seq1_re <<= 1
        if self.e6 == 6:
            self.seq0_re <<= 0
            self.seq1_re <<= 0

        # Datapath muxes
        self.DPBus <<= 0

        # 74LS139 (D2), 74LS138 (D3)
        if self.d2d3 == 0:
            self.DPBus <<= self.swap_register
        if self.d2d3 == 1:
            self.DPBus <<= self.reg_ram_data_out
        if self.d2d3 == 2:
            self.DPBus <<= (~self.memory_address[12:16] << 4) | self.memory_address[8:12].getIntValue()
        if self.d2d3 == 3:
            self.DPBus <<= self.memory_address[0:8]
        if self.d2d3 == 4:
            pass
        if self.d2d3 == 5:
            pass
        if self.d2d3 == 6:
            pass
        if self.d2d3 == 7:
            pass
        if self.d2d3 == 8:
            pass # DPBus = translated address hi, 17:11 (17 down), and top 3 bits together
        if self.d2d3 == 9:
            self.DPBus <<= ~self.condition_codes[0:4] << 4 # low nibble is sense switches
        if self.d2d3 == 10:
            self.DPBus <<= self.bus_read # DPBus = (e7 == 3) ? dataInBus : bus_read;
        if self.d2d3 == 11:
            pass # read ILR (interrupt level register?) H14 4 bits, A8 4 bits current level
        if self.d2d3 == 12:
            pass # read switch 2 other half of dip switches and condition codes?
        if self.d2d3 == 13:
            self.DPBus <<= self.constant
        if self.d2d3 == 14:
            pass
        if self.d2d3 == 15:
            pass

        self.FBus <<= (self.alu1_yout << 4) | self.alu0_yout.getIntValue()
        if self.h11 == 6:
            self.FBus <<= self.map_rom_data

        # end always @(*)

        if self.clock.isRisingEdge():
            self.pipeline <<= self.uc_rom_data

            # 74LS138
            if self.e6 == 0:
                pass
            if self.e6 == 1:
                self.result_register <<= self.FBus
            if self.e6 == 2:
                self.register_index <<= self.FBus; # uC bit 53 might simplify 16 bit register write
            if self.e6 == 3:
                pass # load D9
            if self.e6 == 4:
                pass # load page table base register
            if self.e6 == 5:
                self.memory_address <<= self.work_address
            if self.e6 == 6:
                pass # load AR on 2909s, see above
            if self.e6 == 7:
                # load condition code register M12
                # based on table in wiki (j12), condition codes in instructions wiki
                if self.j12 == 0:
                    self.condition_codes[3] <<= self.condition_codes[0]
                    self.condition_codes[2] <<= self.condition_codes[1]
                if self.j12 == 1:
                    self.condition_codes[3] <<= self.flags_register[0]
                    self.condition_codes[2] <<= self.flags_register[1]
                if self.j12 == 2:
                    self.condition_codes <<= self.result_register[0:4] # Not sure
                if self.j12 == 3:
                    self.condition_codes[3] <<= self.flags_register[5] & self.flags_register[0]
                    self.condition_codes[2] <<= self.flags_register[1]

            # 74LS138 (only half used)            
            if self.e7 == 0:
                pass
            if self.e7 == 1:
                pass
            if self.e7 == 2:
                hi_n = (self.flags_register[0] << 5) | (self.alu0_cout << 4)
                lo_n = (self.alu1_cout << 3) | (self.alu1_ovr << 2) | (self.alu1_f3 << 1) | (self.alu0_f0 & self.alu1_f0)
                self.flags_register <<= (hi_n << 4) | lo_n
            if self.e7 == 3:
                self.bus_read <<= self.dataInBus

            # 74LS138
            if self.h11 == 0:
                pass
            if self.h11 == 1:
                pass # Begin bus read cycle
            if self.h11 == 2:
                pass # Begin bus write cycle
            if self.h11 == 3:
                # Load work_address high byte
                self.work_address[8:16] <<= self.result_register
                if self.e6 == 5:
                    self.work_address[8:16] <<= self.memory_address[8:16]
            if self.h11 == 4:
                self.work_address <<= self.work_address + 1 # WAR increment
            if self.h11 == 5:
                self.memory_address <<= self.memory_address + 1 # MAR increment
            if self.h11 == 6:
                pass # Select FBus source (combinational)
            if self.h11 == 7:
                self.swap_register <<= (self.DPBus[0:4] << 4) | self.DPBus[4:8].getIntValue()

            self.writeEnBus <<= 0

            # 74LS138
            if self.k11 == 0:
                pass
            if self.k11 == 1:
                pass
            if self.k11 == 2:
                pass
            if self.k11 == 3:
                pass # enable F11 addressable latch, machine state, bus state, A0-2 on F11 are B1-3 and D input is B0
            if self.k11 == 4:
                pass
            if self.k11 == 5:
                 pass
            if self.k11 == 6: # Load work_address low byte
                self.work_address[0:8] <<= self.result_register
                if self.e6 == 5:
                    self.work_address[0:8] <<= self.memory_address[0:8]
            if self.k11 == 7:
                self.writeEnBus <<= 1
