
module Decoder (input wire[31:0] instruction, output wire [6:0] opcode,
    output wire [4:0] rd, output wire [4:0] rs1, output wire [4:0] rs2,
    output wire [2:0] funct3, output wire [31:0] imm12, output wire [31:0] imm20,
    output wire [31:0] store_offset,
    output wire [31:0] jal_offset, output wire [31:0] jalr_offset, output wire [31:0] branch_offset, 
    output reg [3:0] alu_op);

    parameter OP_OP_IMM = (0 << 5) | (4 << 2) | 3;
    parameter OP_OP = (1 << 5) | (4 << 2) | 3;

    parameter F3_OP_OP_IMM_ADDI = 0;
    parameter F3_OP_OP_IMM_SLTI = 2;
    parameter F3_OP_OP_IMM_SLTIU = 3;
    parameter F3_OP_OP_IMM_XORI = 4;
    parameter F3_OP_OP_IMM_ORI = 6;
    parameter F3_OP_OP_IMM_ANDI = 7;

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

    assign opcode = instruction[6:0];
    assign rd = instruction[11:7];
    assign funct3 = instruction[14:12];
    assign rs1 = instruction[19:15];
    assign rs2 = instruction[24:20];
    assign imm12 = { {20{instruction[31]}}, instruction[31:20] };
    assign imm20 = { instruction[31:12], 12'h000 };
    assign store_offset = { {20{instruction[31]}}, instruction[31:25], instruction[11:7] };
    assign jal_offset = { {12{instruction[31]}}, instruction[19:12], instruction[20], instruction[30:21], 1'b0 };
    assign jalr_offset = { {19{instruction[31]}}, instruction[31:20], 1'b0 };
    assign branch_offset = { {20{instruction[31]}}, instruction[7], instruction[30:25], instruction[11:8], 1'b0};

    wire [6:0] imm7 = instruction[31:25];

    always @(*) begin
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
endmodule
