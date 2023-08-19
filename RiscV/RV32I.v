
module RV32I (input wire reset, input wire clock,
    output wire [31:0] pmAddress, output reg [2:0] pmFunc3,
    output reg pmWrite,
    output reg [31:0] pmDataOut, input wire [31:0] pmDataIn,
    output wire [31:0] dmAddress, output reg [2:0] dmFunc3,
    output reg dmWrite,
    output reg [31:0] dmDataOut, input wire [31:0] dmDataIn);

    reg [31:0] pc, pc_next;
    reg [31:0] instruction_1;
    wire [6:0] opcode_1 = instruction_1[6:0];
    wire [4:0] rd_1 = instruction_1[11:7];
    reg [31:0] rx[0:31];
    reg post_reset, mem_load;

    wire[31:0] instruction_0 = pmDataIn;

    wire [6:0] opcode;
    wire [4:0] rd, rs1, rs2;
    wire [2:0] funct3;
    wire [31:0] imm12, imm20;
    wire [31:0] store_offset;
    wire [31:0] jal_offset;
    wire [31:0] branch_offset;
    wire [31:0] jalr_offset;
    wire [3:0] alu_op;

    assign pmAddress = pc_next;
    assign dmAddress = opcode == OP_STORE ? rx[rs1] + store_offset : rx[rs1] + imm12;

    wire [31:0] alu_a = rx[rs1];
    wire [31:0] alu_b = opcode == OP_OP_IMM ? imm12 : rx[rs2];
    wire [31:0] alu_out;

    Decoder dec(instruction_0, opcode, rd, rs1, rs2, funct3, imm12, imm20,
        store_offset, jal_offset, jalr_offset, branch_offset, alu_op);
    ALU alu(alu_op, alu_a, alu_b, alu_out);

    reg[20:0] total_clocks, total_bubbles;

    integer i;
    initial begin
        for (i=0; i<32; i=i+1) begin
            rx[i] = 0;
        end
    end

    always @(*) begin
        dmWrite = 0;
        dmDataOut = 0;
        dmFunc3 = funct3;
        pmWrite = 0;
        pmFunc3 = 2;
        pc_next = pc + 4;
        if (post_reset == 1) begin
            pc_next = 0;
        end else begin
            if (opcode == OP_JAL) begin
                pc_next = pc + jal_offset;
            end
            if (opcode == OP_JALR && funct3 == 0) begin
                pc_next = rx[rs1] + jalr_offset;
            end
            if (opcode == OP_STORE) begin   // sw
                dmWrite = 1;
                dmDataOut = rx[rs2];
                `ifdef TRACE_WR
                    $write("WR %x = %d\n", rx[rs1] + store_offset, rx[rs2]);
                `endif
            end
            if (opcode == OP_LOAD) begin   // lw
                // Force a bubble to avoid data hazard
                if (mem_load == 0) pc_next = pc;
            end

            if (opcode == OP_BRANCH) begin
                case (funct3)
                    F3_BRANCH_BEQ: if (rx[rs1] == rx[rs2]) pc_next = pc + branch_offset;
                    F3_BRANCH_BNE: if (rx[rs1] != rx[rs2]) pc_next = pc + branch_offset;
                    // FIXME: signed comparison needed here
                    F3_BRANCH_BLT: if (rx[rs1] < rx[rs2]) pc_next = pc + branch_offset;
                    F3_BRANCH_BGE: if (rx[rs1] >= rx[rs2]) pc_next = pc + branch_offset;
                    F3_BRANCH_BLTU: if (rx[rs1] < rx[rs2]) pc_next = pc + branch_offset;
                    F3_BRANCH_BGEU: if (rx[rs1] >= rx[rs2]) pc_next = pc + branch_offset;
                    default:
                        $write("branch f3: %d, rx[%d]: %d rx[%d]: %d\n", funct3, rs1, rx[rs1], rs2, rx[rs2]);
                endcase
            end
        end
    end

    always @(posedge clock, posedge reset) begin
        if (reset == 1) begin
            post_reset <= 1;
            pc <= 0;
            pmWrite <= 0;
            dmWrite <= 0;
            mem_load <= 0;
            total_clocks <= 0;
            total_bubbles <= 0;
            instruction_1 <= 0;
        end else begin
            mem_load <= 0;
            post_reset <= 0;
            pc <= pc_next;
            instruction_1 <= instruction_0;
            if (post_reset == 0) begin
                total_clocks <= total_clocks + 1;
                `ifdef TRACE_REGS
                    $write("    0: %x %x %x %x %x %x %x %x\n", rx[0], rx[1], rx[2], rx[3], rx[4], rx[5], rx[6], rx[7]);
                    $write("    8: %x %x %x %x %x %x %x %x\n", rx[8], rx[9], rx[10], rx[11], rx[12], rx[13], rx[14], rx[15]);
                    $write("   16: %x %x %x %x %x %x %x %x\n", rx[16], rx[17], rx[18], rx[19], rx[20], rx[21], rx[22], rx[23]);
                    $write("   24: %x %x %x %x %x %x %x %x\n", rx[24], rx[25], rx[26], rx[27], rx[28], rx[29], rx[30], rx[31]);
                `endif
                case (opcode)
                    OP_LOAD: begin    // lw
                        if (rd != 0 && mem_load == 0) begin
                            mem_load <= 1;
                            total_bubbles <= total_bubbles + 1;
                        end
                        `ifdef TRACE_I
                            $write("%x: lw r%d, %x(rs%d)\n", pc, rd, imm12, rs1);
                        `endif
                    end
                    OP_LUI: begin
                        if (rd != 0) rx[rd] <= imm20;
                        `ifdef TRACE_I
                            $write("%x: %x lui r%d %d\n", pc, instruction_0, rd, imm20);
                        `endif
                    end
                    OP_STORE: begin
                        `ifdef TRACE_I
                            $write("%x: sw rs%d, %x(rs%d)\n", pc, rs2, store_offset, rs1);
                        `endif
                    end
                    OP_OP_IMM: begin
                        if (rd != 0) rx[rd] <= alu_out;
                        `ifdef TRACE_I
                            $write("%x: %x ALU(%d) r%d, rs%d, %d\n", pc, instruction_0, alu_op, rd, rs1, imm12);
                        `endif
                    end
                    OP_OP: begin
                        if (rd != 0) rx[rd] <= alu_out;
                        `ifdef TRACE_I
                            $write("%x: %x ALU(%d) r%d, rs%d, rs%d\n", pc, instruction_0, alu_op, rd, rs1, rs2);
                        `endif
                    end
                    OP_JAL: begin
                        if (rd != 0) rx[rd] <= pc + 4;
                        `ifdef TRACE_I
                            $write("%x: jal r%d, %x\n", pc, rd, pc + jal_offset);
                        `endif
                    end
                    OP_BRANCH: begin
                        `ifdef TRACE_I
                            $write("%x: branch %x (f3 %d), alu_out: %d\n", pc, pc + branch_offset, funct3, alu_out);
                        `endif
                    end
                    OP_JALR: begin
                        `ifdef TRACE_I
                            $write("%x: jalr %x\n", pc, rx[rs1] + jalr_offset, funct3, alu_out);
                        `endif
                    end
                    default:
                        $write("%x: Unknown OP: %x, funct3: %x, opcode: %x, rd: %x, rs1: %x, imm12: %d\n",
                            pc, instruction_0, funct3, opcode, rd, rs1, imm12);
                endcase
            end
            if (mem_load) begin
                rx[rd_1] <= dmDataIn;
                `ifdef TRACE_RD
                    $write("RD r%d <= %d\n", rd, dmDataIn);
                `endif
            end
        end
    end

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

    parameter F3_OP_OP_IMM_SLL1 = 1;
    parameter F3_OP_OP_IMM_SRI = 5; // SRLI if imm7 == 0, SRAI if imm7 == 7'h20
endmodule
