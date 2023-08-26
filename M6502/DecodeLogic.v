
`define PC_INC 0
`define TIMING_RESET 1
`define WRITE_EN 2
`define RA_OPERAND 3
`define PC_OPERAND 4
`define RX_OPERAND 5
`define RY_OPERAND 6
`define RP_OPERAND 7
`define ADDR_RP 8
`define DATA_OUT_RA 9
`define ADDR_OPERAND 10

module DecodeLogic (input wire reset, input wire [7:0] timing, input wire [7:0] opcode,
    output wire [63:0] enables);

    assign t1 = timing[0];
    assign t2 = timing[1];
    assign t3 = timing[2];
    assign t4 = timing[3];
    assign t5 = timing[4];
    assign t6 = timing[5];

    assign nop = opcode == 8'hea;
    assign lda_imm = opcode == 8'ha9;
    assign ldx_imm = opcode == 8'ha2;
    assign ldy_imm = opcode == 8'ha0;
    assign jmp = opcode == 8'h4c;
    assign sta_abs = opcode == 8'h8d;
    assign lda_abs = opcode == 8'had;

    assign enables[`TIMING_RESET] = reset | nop | (lda_imm & t2) | (ldx_imm & t2) | (ldy_imm & t2) |
        (jmp & t3) | (sta_abs & t5) | (lda_abs & t5);
    assign enables[`WRITE_EN] = sta_abs & t4;
    assign enables[`ADDR_RP] = (sta_abs & t4) | (lda_abs & t4);
    assign enables[`DATA_OUT_RA] = sta_abs & t4;
    assign enables[`RP_OPERAND] = (sta_abs & t3) | (lda_abs & t3);
    assign enables[`PC_INC] = nop | lda_imm | jmp | ldx_imm | ldy_imm | (sta_abs & (t1 | t2 | t3)) | (lda_abs & (t1 | t2 | t3));
    assign enables[`RA_OPERAND] = (lda_imm & t2) | (lda_abs & t5);
    assign enables[`RX_OPERAND] = ldx_imm & t2;
    assign enables[`RY_OPERAND] = ldy_imm & t2;
    assign enables[`PC_OPERAND] = jmp & t3;
endmodule
