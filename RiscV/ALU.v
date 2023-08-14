
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
