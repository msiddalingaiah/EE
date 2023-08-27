
`define ADDR_RP 0
`define DATA_OUT_RA 1
`define PC_INC 2
`define PC_OPERAND 3
`define RA_OPERAND 4
`define RP_OPERAND 5
`define RX_OPERAND 6
`define RY_OPERAND 7
`define TIMING_RESET 8
`define WRITE_EN 9

module DecodeLogic (input wire reset, input wire [7:0] timing, input wire [7:0] opcode,
    output wire [63:0] enables);

    assign t1 = timing[0];
    assign t2 = timing[1];
    assign t3 = timing[2];
    assign t4 = timing[3];
    assign t5 = timing[4];
    assign t6 = timing[5];

	assign jmp = opcode == 8'h4c;
	assign lda_abs = opcode == 8'had;
	assign lda_imm = opcode == 8'ha9;
	assign ldx_imm = opcode == 8'ha2;
	assign ldy_imm = opcode == 8'ha0;
	assign nop = opcode == 8'hea;
	assign sta_abs = opcode == 8'h8d;

	assign enables[`ADDR_RP] = (sta_abs&t4) | (lda_abs&t4);
	assign enables[`DATA_OUT_RA] = (sta_abs&t4);
	assign enables[`PC_INC] = (nop&t1) | (lda_imm&t1) | (lda_imm&t2) | (ldx_imm&t1) | (ldx_imm&t2) | (ldy_imm&t1) | (ldy_imm&t2) | (jmp&t1) | (jmp&t2) | (jmp&t3) | (sta_abs&t1) | (sta_abs&t2) | (sta_abs&t3) | (lda_abs&t1) | (lda_abs&t2) | (lda_abs&t3);
	assign enables[`PC_OPERAND] = (jmp&t3);
	assign enables[`RA_OPERAND] = (lda_imm&t2) | (lda_abs&t5);
	assign enables[`RP_OPERAND] = (sta_abs&t3) | (lda_abs&t3);
	assign enables[`RX_OPERAND] = (ldx_imm&t2);
	assign enables[`RY_OPERAND] = (ldy_imm&t2);
	assign enables[`TIMING_RESET] = (nop&t1) | (lda_imm&t2) | (ldx_imm&t2) | (ldy_imm&t2) | (jmp&t3) | (sta_abs&t5) | (lda_abs&t5);
	assign enables[`WRITE_EN] = (sta_abs&t4);
endmodule
