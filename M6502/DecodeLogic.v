
`define ADDR_RP 0
`define ALU_A_OPERAND 1
`define ALU_B_RA 2
`define ALU_B_ZERO 3
`define ALU_OP_ADC 4
`define ALU_OP_OR 5
`define DATA_OUT_RA 6
`define PC_HOLD 7
`define PC_OPERAND 8
`define RA_ALU_OUT 9
`define RP_OPERAND 10
`define RX_ALU_OUT 11
`define RY_ALU_OUT 12
`define TIMING_RESET 13
`define WRITE_EN 14

/*
 * This module was automatically generated. Do not Edit.
 */
module DecodeLogic (input wire reset, input wire [7:0] timing, input wire [7:0] opcode,
    output wire [63:0] enables);

    assign t1 = timing[0];
    assign t2 = timing[1];
    assign t3 = timing[2];
    assign t4 = timing[3];
    assign t5 = timing[4];
    assign t6 = timing[5];

	assign adc_imm = opcode == 8'h69;
	assign jmp = opcode == 8'h4c;
	assign lda_abs = opcode == 8'had;
	assign lda_imm = opcode == 8'ha9;
	assign ldx_imm = opcode == 8'ha2;
	assign ldy_imm = opcode == 8'ha0;
	assign nop = opcode == 8'hea;
	assign sta_abs = opcode == 8'h8d;

	assign enables[`ADDR_RP] = (sta_abs&t4) | (lda_abs&t4);
	assign enables[`ALU_A_OPERAND] = (lda_imm&t2) | (ldx_imm&t2) | (ldy_imm&t2) | (lda_abs&t5) | (adc_imm&t2);
	assign enables[`ALU_B_RA] = (adc_imm&t2);
	assign enables[`ALU_B_ZERO] = (lda_imm&t2) | (ldx_imm&t2) | (ldy_imm&t2) | (lda_abs&t5);
	assign enables[`ALU_OP_ADC] = (adc_imm&t2);
	assign enables[`ALU_OP_OR] = (lda_imm&t2) | (ldx_imm&t2) | (ldy_imm&t2) | (lda_abs&t5);
	assign enables[`DATA_OUT_RA] = (sta_abs&t4);
	assign enables[`PC_HOLD] = (sta_abs&t5) | (sta_abs&t4) | (lda_abs&t4) | (lda_abs&t5);
	assign enables[`PC_OPERAND] = (jmp&t3);
	assign enables[`RA_ALU_OUT] = (lda_imm&t2) | (lda_abs&t5) | (adc_imm&t2);
	assign enables[`RP_OPERAND] = (sta_abs&t3) | (lda_abs&t3);
	assign enables[`RX_ALU_OUT] = (ldx_imm&t2);
	assign enables[`RY_ALU_OUT] = (ldy_imm&t2);
	assign enables[`TIMING_RESET] = (nop&t1) | (lda_imm&t2) | (ldx_imm&t2) | (ldy_imm&t2) | (jmp&t3) | (sta_abs&t5) | (lda_abs&t5) | (adc_imm&t2);
	assign enables[`WRITE_EN] = (sta_abs&t4);
endmodule
