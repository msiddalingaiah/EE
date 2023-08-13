
`define MEM_SIZE 1024

module Memory(input wire clock, input wire [31:0] address, input[3:0] width, input wire write_en, input wire [31:0] data_in,
    output reg [31:0] data_out);

    parameter ADDRESS_MASK = 17'h7f;
    parameter MEM_SIZE_W = `MEM_SIZE >> 2;

    reg [7:0] cells0[0:MEM_SIZE_W-1];
    reg [7:0] cells1[0:MEM_SIZE_W-1];
    reg [7:0] cells2[0:MEM_SIZE_W-1];
    reg [7:0] cells3[0:MEM_SIZE_W-1];
    wire [7:0] address_w = address[9:2];
    wire [2:0] two_bits = address[1:0];

    integer i;
    initial begin
        for (i=0; i<MEM_SIZE_W; i=i+1) begin
            cells0[i] = 0;
            cells1[i] = 0;
            cells2[i] = 0;
            cells3[i] = 0;
        end
        data_out = 0;
    end

    always @(posedge clock) begin
        data_out <= 0;
        case (width)
            1: begin
                case (two_bits)
                    0: data_out <= { 24'h0, cells0[address_w] };
                    1: data_out <= { 24'h0, cells1[address_w] };
                    2: data_out <= { 24'h0, cells2[address_w] };
                    3: data_out <= { 24'h0, cells3[address_w] };
                endcase
            end
            2: begin
                case (two_bits)
                    0: data_out <= { 16'h0, cells1[address_w], cells0[address_w] };
                    2: data_out <= { 16'h0, cells3[address_w], cells2[address_w] };
                endcase
            end
            4: data_out <= { cells3[address_w], cells2[address_w], cells1[address_w], cells0[address_w] };
        endcase
        if (write_en == 1) begin
            case (width)
                1: begin
                    case (two_bits)
                        0: cells0[address_w] <= data_in[7:0];
                        1: cells1[address_w] <= data_in[7:0];
                        2: cells2[address_w] <= data_in[7:0];
                        3: cells3[address_w] <= data_in[7:0];
                    endcase
                end
                2: begin
                    case (two_bits)
                        0: { cells1[address_w], cells0[address_w] } <= data_in[15:0];
                        2: { cells3[address_w], cells3[address_w] } <= data_in[15:0];
                    endcase
                end
                4: { cells3[address_w], cells2[address_w], cells1[address_w], cells0[address_w] } <= data_in;
            endcase
        end
    end
endmodule

/*

https://wavedrom.com/editor.html

{ "signal" : [
  { "name": "clk",       "wave": "p............" },
  { "name": "reset",     "wave": "010...........", phase: 2.9 },
  { "name": "post_reset","wave": "1.0...........", phase: 2.0 },
  { "name": "pc_next",   "wave": "444444.4444.|", "data": ["0", "4", "14", "18", "1C", "20", "24", "28", "1C", "20"] },
  { "name": "pc",        "wave": "3333333.3333|", "data": ["0", "0", "4", "14", "18", "1C", "20", "24", "28", "1C", "20"] },
  { "name": "opcode",    "wave": "z555555.5555|", "data": ["li 400", "j 14", "li 3", "sw r15", "lw a5", "ai a5", "sw r15", "j 1C", "lw a5", "ai a5"] },
  { "name": "mem_load",  "wave": "0.....10...1|", "data": [] },
  { "name": "reg_data",  "wave": "zzzzzz66zzz6|", "data": ["mem_data", "reg_data", "mem_data"] },
  { "name": "dm_wr",     "wave": "0...10..10..|", "data": [] },
  { "name": "dm_addr",   "wave": "zzzzz7zzzz7z|", "data": ["addr", "addr"] },
  { "name": "dm_data",   "wave": "zzzzzz8zzzz8|", "data": ["data", "data"] },
  ],
  config: { hscale: 2 }
}

 */

`define ALU_OP_ADD 0
`define ALU_OP_SUB 1
`define ALU_OP_AND 2
`define ALU_OP_OR 3
`define ALU_OP_XOR 4
`define ALU_OP_LTU 5
`define ALU_OP_LT 6
`define ALU_OP_ZERO 7

module ALU (input wire [3:0] alu_op, input wire [31:0] a, input wire [31:0] b, output reg [31:0] out);
    wire [1:0] signs = { a[31], b[31] };
    always @(*) begin
        out = 0;
        case (alu_op)
            `ALU_OP_ADD: out = a + b;
            `ALU_OP_SUB: out = a - b;
            `ALU_OP_AND: out = a & b;
            `ALU_OP_OR: out = a | b;
            `ALU_OP_XOR: out = a ^ b;
            `ALU_OP_LTU: out = a < b;
            `ALU_OP_LT: begin
                case (signs)
                    0: out = a < b;
                    1: out = 0;
                    2: out = 1;
                    3: out = b[30:0] < a[30:0]; // is this right?
                endcase
            end
        endcase
    end
endmodule

module CPU32 (input wire reset, input wire clock,
    output wire [31:0] pmAddress, output reg [3:0] pmWidth,
    output reg pmWrite,
    output reg [31:0] pmDataOut, input wire [31:0] pmDataIn,
    output reg [31:0] dmAddress, output reg [3:0] dmWidth,
    output reg dmWrite,
    output reg [31:0] dmDataOut, input wire [31:0] dmDataIn);

    parameter OP_LOAD = (0 << 5) | (0 << 2) | 3;
    parameter OP_LOAD_FP = (0 << 5) | (1 << 2) | 3;
    parameter OP_CUSTOM_0 = (0 << 5) | (2 << 2) | 3;
    parameter OP_MISC_MEM = (0 << 5) | (3 << 2) | 3;
    parameter OP_OP_IMM = (0 << 5) | (4 << 2) | 3;
    parameter OP_AUIPC = (0 << 5) | (5 << 2) | 3;
    parameter OP_OP_IMM_32 = (0 << 5) | (6 << 2) | 3;

    parameter OP_STORE = (1 << 5) | (0 << 2) | 3;
    parameter OP_STORE_FP = (1 << 5) | (1 << 2) | 3;
    parameter OP_CUSTOM_1 = (1 << 5) | (2 << 2) | 3;
    parameter OP_AMO = (1 << 5) | (3 << 2) | 3;
    parameter OP_OP = (1 << 5) | (4 << 2) | 3;
    parameter OP_LUI = (1 << 5) | (5 << 2) | 3;
    parameter OP_OP_32 = (1 << 5) | (6 << 2) | 3;

    parameter OP_MADD = (2 << 5) | (0 << 2) | 3;
    parameter OP_MSUB = (2 << 5) | (1 << 2) | 3;
    parameter OP_NMSUB = (2 << 5) | (2 << 2) | 3;
    parameter OP_NMADD = (2 << 5) | (3 << 2) | 3;
    parameter OP_OP_FP = (2 << 5) | (4 << 2) | 3;
    parameter OP_RESERVED_1 = (2 << 5) | (5 << 2) | 3;
    parameter OP_CUSTOM_2 = (2 << 5) | (6 << 2) | 3;

    parameter OP_BRANCH = (3 << 5) | (0 << 2) | 3;
    parameter OP_JALR = (3 << 5) | (1 << 2) | 3;
    parameter OP_RESERVED_2 = (3 << 5) | (2 << 2) | 3;
    parameter OP_JAL = (3 << 5) | (3 << 2) | 3;
    parameter OP_SYSTEM = (3 << 5) | (4 << 2) | 3;
    parameter OP_RESERVED_3 = (3 << 5) | (5 << 2) | 3;
    parameter OP_CUSTOM_3 = (3 << 5) | (6 << 2) | 3;

    parameter F3_JALR = 0;

    parameter F3_BRANCH_BEQ = 0;
    parameter F3_BRANCH_BNE = 1;
    parameter F3_BRANCH_BLT = 4;
    parameter F3_BRANCH_BGE = 5;
    parameter F3_BRANCH_BLTU = 6;
    parameter F3_BRANCH_BGEU = 7;

    parameter F3_LOAD_LB = 0;
    parameter F3_LOAD_LH = 1;
    parameter F3_LOAD_LW = 2;
    parameter F3_LOAD_LBU = 4;
    parameter F3_LOAD_LHU = 5;

    parameter F3_STORE_SB = 0;
    parameter F3_STORE_SH = 1;
    parameter F3_STORE_SW = 2;

    parameter F3_OP_OP_IMM_ADDI = 0;
    parameter F3_OP_OP_IMM_SLTI = 2;
    parameter F3_OP_OP_IMM_SLTIU = 3;
    parameter F3_OP_OP_IMM_XORI = 4;
    parameter F3_OP_OP_IMM_ORI = 6;
    parameter F3_OP_OP_IMM_ANDI = 7;

    parameter F3_OP_OP_IMM_SLL1 = 1;
    parameter F3_OP_OP_IMM_SRI = 5; // SRLI if imm7 == 0, SRAI if imm7 == 7'h20

    parameter F3_OP_OP_SUM = 0; // ADD if imm7 == 0, SUB if imm7 == 7'h20
    parameter F3_OP_OP_SLL = 1; // if imm7 == 0
    parameter F3_OP_OP_SLT = 2; // if imm7 == 0
    parameter F3_OP_OP_SLTU = 3; // if imm7 == 0
    parameter F3_OP_OP_XOR = 4; // if imm7 == 0
    parameter F3_OP_OP_SR = 5; // SRL if imm7 == 0, SRA if imm7 == 7'h20
    parameter F3_OP_OP_OR = 6; // if imm7 == 0
    parameter F3_OP_OP_AND = 7; // if imm7 == 0

    parameter IMM7_OP_OP_0 = 7'h00;
    parameter IMM7_OP_OP_20 = 7'h20;

    reg [31:0] pc, pc_next;
    reg [31:0] rx[0:31];
    reg [4:0] dest_reg;
    reg post_reset, mem_load;
    assign pmAddress = pc_next;
    wire [6:0] opcode = pmDataIn[6:0];
    wire [4:0] rd = pmDataIn[11:7];
    wire [2:0] funct3 = pmDataIn[14:12];
    wire [4:0] rs1 = pmDataIn[19:15];
    wire [4:0] rs2 = pmDataIn[24:20];
    wire [19:0] imm20 = pmDataIn[31:12];
    wire [31:0] imm12 = { {20{pmDataIn[31]}}, pmDataIn[31:20] };
    wire [6:0] imm7 = pmDataIn[31:25];
    wire [31:0] load_store_offset = { {20{pmDataIn[31]}}, pmDataIn[31:25], pmDataIn[11:7] };
    wire [31:0] jal_offset = { pmDataIn[31] ? 11'h7ff : 11'h0, pmDataIn[31], pmDataIn[19:12], pmDataIn[20], pmDataIn[30:21], 1'b0 };

    reg [3:0] alu_op;
    wire [31:0] alu_a = rx[rs1];
    wire [31:0] alu_b = opcode == OP_OP_IMM ? imm12 : rx[rs2];
    wire [31:0] alu_out;
    ALU alu(alu_op, alu_a, alu_b, alu_out);

    integer i;
    initial begin
        for (i=0; i<32; i=i+1) begin
            rx[i] = 0;
        end
    end

    always @(*) begin
        dmWrite = 0;
        dmAddress = 0;
        dmDataOut = 0;
        dmWidth = 0;
        pmWrite = 0;
        pc_next = pc + 4;
        if (post_reset == 1) begin
            pc_next = 0;
        end else begin
            // Simple branch prediction, needs a pipeline bubble to avoid branch hazard
            if (opcode == 7'h6f) begin
                pc_next = pc + jal_offset;
            end
            if (opcode == 7'h23 && funct3 == 2) begin   // sw
                dmWrite = 1;
                dmWidth = 4;
                dmAddress = rx[rs1] + load_store_offset;
                dmDataOut = rx[rs2];
            end
            if (opcode == 7'h3 && funct3 == 2) begin   // lw
                dmWidth = 4;
                dmAddress = rx[rs1] + imm12;
            end
            // Pipeline bubble to avoid data hazard, e.g. lw, 15 followed by addi 15
            if (mem_load == 1 && dest_reg == rd) begin
                pc_next = pc;
            end
            alu_op = `ALU_OP_ZERO;
            if ((opcode == OP_OP_IMM && funct3 == F3_OP_OP_IMM_ADDI) ||
                (opcode == OP_OP && funct3 == F3_OP_OP_SUM && imm7 == IMM7_OP_OP_0)) alu_op = `ALU_OP_ADD;
            if (opcode == OP_OP && funct3 == F3_OP_OP_SUM && imm7 == IMM7_OP_OP_20) alu_op = `ALU_OP_SUB;
            if ((opcode == OP_OP_IMM && funct3 == F3_OP_OP_IMM_SLTI) ||
                (opcode == OP_OP && funct3 == F3_OP_OP_SLT && imm7 == IMM7_OP_OP_0)) alu_op = `ALU_OP_LT;
            if ((opcode == OP_OP_IMM && funct3 == F3_OP_OP_IMM_SLTIU) ||
                (opcode == OP_OP && funct3 == F3_OP_OP_SLTU && imm7 == IMM7_OP_OP_0)) alu_op = `ALU_OP_LTU;
            if ((opcode == OP_OP_IMM && funct3 == F3_OP_OP_IMM_ANDI) ||
                (opcode == OP_OP && funct3 == F3_OP_OP_AND && imm7 == IMM7_OP_OP_0)) alu_op = `ALU_OP_AND;
            if ((opcode == OP_OP_IMM && funct3 == F3_OP_OP_IMM_ORI) ||
                (opcode == OP_OP && funct3 == F3_OP_OP_OR && imm7 == IMM7_OP_OP_0)) alu_op = `ALU_OP_OR;
            if ((opcode == OP_OP_IMM && funct3 == F3_OP_OP_IMM_XORI) ||
                (opcode == OP_OP && funct3 == F3_OP_OP_XOR && imm7 == IMM7_OP_OP_0)) alu_op = `ALU_OP_XOR;
        end
    end

    always @(posedge clock, posedge reset) begin
        if (reset == 1) begin
            post_reset <= 1;
            pc <= 0;
            pmWidth <= 4;
            pmWrite <= 0;
            dmWidth <= 4;
            dmWrite <= 0;
            mem_load <= 0;
            dest_reg <= 0;
        end else begin
            mem_load <= 0;
            dest_reg <= 0;
            post_reset <= 0;
            pc <= pc_next;
            if (post_reset == 0) begin
                $write("    0: %x %x %x %x %x %x %x %x\n", rx[0], rx[1], rx[2], rx[3], rx[4], rx[5], rx[6], rx[7]);
                $write("    8: %x %x %x %x %x %x %x %x\n", rx[8], rx[9], rx[10], rx[11], rx[12], rx[13], rx[14], rx[15]);
                $write("   16: %x %x %x %x %x %x %x %x\n", rx[16], rx[17], rx[18], rx[19], rx[20], rx[21], rx[22], rx[23]);
                $write("   24: %x %x %x %x %x %x %x %x\n", rx[24], rx[25], rx[26], rx[27], rx[28], rx[29], rx[30], rx[31]);
                case (opcode)
                    7'h3: case (funct3)
                        2: begin    // lw
                            if (rd != 0) begin
                                mem_load <= 1;
                                dest_reg <= rd;
                            end
                            $write("%x: lw r%d, %x(rs%d)\n", pc, rd, imm12, rs1);
                        end
                    endcase
                    OP_OP_IMM: begin
                        if (rd != 0) rx[rd] <= alu_out;
                        $write("%x: %x ALU(%d) r%d, rs%d, %d\n", pc, pmDataIn, alu_op, rd, rs1, imm12);
                    end
                    OP_OP: begin
                        if (rd != 0) rx[rd] <= alu_out;
                        $write("%x: %x ALU(%d) r%d, rs%d, rs%d\n", pc, pmDataIn, alu_op, rd, rs1, rs2);
                    end
                    7'h23: case (funct3)
                        2: begin    // sw
                            $write("%x: sw rs%d, %x(rs%d)\n", pc, rs2, load_store_offset, rs1);
                        end
                    endcase
                    7'h6f: begin    // jal
                        $write("%x: jal %x\n", pc, pc + jal_offset);
                    end
                    default:
                        $write("%x: %x, funct3: %x, opcode: %x, rd: %x, rs1: %x, imm12: %d\n", pc, pmDataIn, funct3, opcode, rd, rs1, imm12);
                endcase
            end
            if (mem_load) rx[dest_reg] <= dmDataIn;
        end
    end
endmodule

`timescale 1 ns/10 ps  // time-unit = 1 ns, precision = 10 ps

module Clock(output reg clock);
    initial begin
        #0 clock = 0;
    end

    always begin
        #50 clock <= ~clock;
    end
endmodule

module tb;
    wire clock;
    reg reset;
    wire [31:0] pmAddress;
    wire [3:0] pmWidth;
    wire pmWrite;
    wire [31:0] pmDataCOut;
    wire [31:0] pmDataCIn;
    wire [31:0] dmAddress;
    wire [3:0] dmWidth;
    wire dmWrite;
    wire [31:0] dmDataCOut;
    wire [31:0] dmDataCIn;

    Clock cg0(clock);
    Memory pMemory (clock, pmAddress, pmWidth, pmWrite, pmDataCOut, pmDataCIn);
    Memory dMemory (clock, dmAddress, dmWidth, dmWrite, dmDataCOut, dmDataCIn);
    CPU32 cpu(reset, clock, pmAddress, pmWidth, pmWrite, pmDataCOut, pmDataCIn,
        dmAddress, dmWidth, dmWrite, dmDataCOut, dmDataCIn);

    reg [7:0] temp[0:`MEM_SIZE];

    integer i;
    initial begin
        $dumpfile("vcd/tb.vcd");
        $dumpvars(0, cpu);

        $write("Begin...\n");
        $readmemh("main.hex", temp);
        for (i=0; i<`MEM_SIZE; i=i+4) begin
            pMemory.cells0[i>>2] = temp[i+0];
            pMemory.cells1[i>>2] = temp[i+1];
            pMemory.cells2[i>>2] = temp[i+2];
            pMemory.cells3[i>>2] = temp[i+3];
        end

        #0 reset=0; #25 reset=1; #100; reset=0;

        #2000;
        $write("All done!\n");
        $finish;
    end
endmodule
