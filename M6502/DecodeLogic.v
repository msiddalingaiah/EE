
module DecodeLogic (input wire reset, input wire [7:0] timing, input wire [7:0] opcode,
    output wire [63:0] enables);

    assign nop = opcode == 8'hea;
    assign lda_imm = opcode == 8'ha9;
    assign ldx_imm = opcode == 8'ha2;
    assign ldy_imm = opcode == 8'ha0;
    assign jmp = opcode == 8'h4c;

    assign enables[`TIMING_RESET] = reset | nop | (lda_imm & timing[1]) | (ldx_imm & timing[1]) | (ldy_imm & timing[1]) |
        (jmp & timing[2]);
    assign enables[`WRITE_EN] = 0;
    assign enables[`PC_INC] = nop | lda_imm | jmp | ldx_imm | ldy_imm;
    assign enables[`RA_OPERAND] = lda_imm & timing[1];
    assign enables[`RX_OPERAND] = ldx_imm & timing[1];
    assign enables[`RY_OPERAND] = ldy_imm & timing[1];
    assign enables[`PC_OPERAND] = jmp & timing[2];
endmodule
