
`define MEM_SIZE 1024

`define ALU_OP_ADD 0

module CPU32 (input wire reset, input wire clock);
    parameter OP_OP_IMM = (0 << 5) | (4 << 2) | 3;
    parameter OP_BRANCH = (3 << 5) | (0 << 2) | 3;

    reg [31:0] rxx;
    wire [6:0] opcode = pmDataIn[6:0];
    reg [3:0] alu_op;
    reg [31:0] alu_a;
    reg [31:0] alu_b;
    reg [31:0] alu_out;

    reg [31:0] pmDataIn;

    initial begin
        pmDataIn = OP_OP_IMM;
    end

    always @(*) begin
        alu_op = `ALU_OP_ADD;
        alu_a = 0;
        alu_b = 0;
        if (opcode == OP_OP_IMM) begin
            alu_a = rxx;
            alu_b = pmDataIn;
        end
        alu_out = 0;
        case (alu_op)
            `ALU_OP_ADD: alu_out = alu_a + alu_b;
        endcase
        // if (opcode == OP_BRANCH) begin
        //     // $write("alu_op: %d, alu_a: %x, alu_b: %x, alu_out: %d\n", alu_op, alu_a, alu_b, alu_out);
        // end
    end

    always @(posedge clock) begin
        pmDataIn <= OP_OP_IMM;
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

    Clock cg0(clock);
    CPU32 cpu(reset, clock);

    initial begin
        $dumpfile("vcd/tb.vcd");
        $dumpvars(0, cpu);

        $write("Begin...\n");

        #0 reset=0; #25 reset=1; #100; reset=0;
        // #0 clock = 0;
        // forever #50 clock = ~clock;

        #2000;
        $write("All done!\n");
        $finish;
    end
endmodule
