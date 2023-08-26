
module Decoder (input wire reset, input wire [7:0] timing, input wire [7:0] opcode,
    output reg [7:0] source, output reg [7:0] dest, output wire reset_timing);

    assign nop = (opcode == 8'hea) | (opcode == 8'h00);
    assign lda = opcode == 8'ha9;
    assign jmp = opcode == 8'h4c;

    assign reset_timing = reset | nop | (timing[1] & lda) | (timing[2] & jmp);
endmodule
