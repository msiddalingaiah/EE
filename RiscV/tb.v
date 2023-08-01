
module Memory(input wire clock, input wire [9:0] address, input wire [3:0] write_en, input wire [31:0] data_in,
    output reg [31:0] data_out);

    parameter ADDRESS_MASK = 17'h7f;
    parameter MEM_SIZE = 1024;

    reg [7:0] cells[0:MEM_SIZE-1];
    reg [31:0] pc;
    wire [31:0] inst = { cells[pc|3], cells[pc|2], cells[pc|1], cells[pc|0] };

    integer i;
    initial begin
        for (i=0; i<MEM_SIZE; i=i+1) begin
            cells[i] = 0;
        end
        pc = 0;
    end

    always @(*) begin
    end

    always @(posedge clock) begin
        $write("%d: %x\n", pc, inst);
        pc <= pc + 4;
    end
endmodule

`timescale 1ns / 1ns
module tb;
    reg clock;
    reg reset;
    wire [9:0] address;
    wire [3:0] write_en;
    wire [31:0] data_in;
    wire [31:0] data_out;

    Memory uut (clock, address, write_en, data_in, data_out);
    initial begin
        clock = 0;
        forever #50 clock = ~clock;
    end
    integer i, iw;
    initial begin
        $dumpfile("vcd/tb.vcd");
        $dumpvars(0, uut);

        $write("Begin...\n");
        $readmemh("hello.hex", uut.cells);

        #0 reset=0; #25 reset=1; #100; reset=0;

        #2000;
        $write("All done!\n");
        $finish;
    end
endmodule
