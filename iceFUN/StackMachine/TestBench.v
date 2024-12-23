
`timescale 1 ns/10 ps  // time-unit = 1 ns, precision = 10 ps

`define TESTBENCH

`include "StackMachineTop.v"

module Clock(output reg clock);
    initial begin
        #0 clock = 0;
    end

    always begin
        #41 clock <= ~clock;
    end
endmodule

module TestBench;
    reg [15:0] cycle_count;

    wire clock;
    wire led1;
    wire led2;
    wire led3;
    wire led4;
    wire led5;
    wire led6;
    wire led7;
    wire led8;
    wire lcol1;
    wire lcol2;
    wire lcol3;
    wire lcol4;

    initial begin
        $dumpfile("vcd/TestBench.vcd");
        $dumpvars(0, TestBench);
        cycle_count = 0;
    end

    Clock cg0(clock);

    StackMachineTop top(clock, led1, led2, led3, led4, led5, led6, led7, led8, lcol1, lcol2, lcol3, lcol4);
    
    always @(posedge clock) begin
        cycle_count <= cycle_count + 1;
        if (cycle_count > 100) begin
            $finish;
        end
    end
endmodule
