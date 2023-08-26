
module DecodeLogic (input wire reset, input wire [7:0] timing, input wire [7:0] opcode,
    output wire [63:0] enables);

    assign nop = opcode == 8'hea;
    assign lda = opcode == 8'ha9;
    assign jmp = opcode == 8'h4c;

    assign enables[`TIMING_RESET] = reset | nop | (timing[1] & lda) | (timing[2] & jmp);
    assign enables[`WRITE_EN] = 0;
    assign enables[`PC_INC] = nop | lda | jmp;
    assign enables[`RA_DATA_IN_Q] = lda & timing[1];
endmodule
