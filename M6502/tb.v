
`include "Decoder.v"
`timescale 1 ns/10 ps  // time-unit = 1 ns, precision = 10 ps

`define MEM_SIZE 65536

module Memory(input wire clock, input wire [15:0] address, input wire write_en, input wire [7:0] data_in, output reg [7:0] data_out);
    reg [7:0] cells[0:`MEM_SIZE-1];

    always @(write_en, address) begin
        if (write_en == 0) data_out = cells[address];
        else data_out = 0;
    end

    always @(posedge clock) begin
        if (write_en == 1) cells[address] <= data_in;
    end
endmodule

module CPU (input wire reset, input wire clock, output wire [15:0] address, output write_en,
    output reg [7:0] data_out, input wire [7:0] data_in);

    reg [7:0] timing;
    wire reset_timing;
    wire [7:0] source, dest;

    reg [15:0] pc = 0;
    reg [7:0] opcode;

    assign address = pc;
    assign write_en = 0;

    Decoder dec (reset, timing, opcode, source, dest, reset_timing);

    always @(posedge clock) begin
        if (reset_timing == 1) timing <= 8'b00000001;
        else timing <= { timing[6:0], timing[7] };
        if (reset_timing) opcode <= data_in;
        pc <= pc + 1;
    end
endmodule

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
    wire [15:0] address;
    wire write_en;
    wire [7:0] dataCOut;
    wire [7:0] dataCIn;
    wire [7:0] uart_char = dataCOut & 8'h7f;
    reg sim_end;
    reg [31:0] clock_count;

    Clock cg0(clock);
    Memory dMemory (clock, address, write_en, dataCOut, dataCIn);
    CPU cpu (reset, clock, address, write_en, dataCOut, dataCIn);

    integer i;
    initial begin
        $dumpfile("bin/tb.vcd");
        $dumpvars(0, tb);

        $write("Begin...\n");
        for (i=0; i<`MEM_SIZE; i=i+1) begin
            dMemory.cells[i] = 0;
        end
        $readmemh("code.hex", dMemory.cells);

        clock_count = 0;
        sim_end = 0; #0 reset=0; #25 reset=1; #100; reset=0;
        wait(sim_end == 1);

        $write("All done!\n");
        $write("Clock count: %d\n", clock_count);
        $finish;
    end

    always @(posedge clock) begin
        clock_count <= clock_count + 1;
        if (clock_count == 40) sim_end <= 1;
        if (write_en == 1 && address == 16'hf010) $write("%s", uart_char);
        if (write_en == 1 && address == 16'hf020 && dataCOut == 8'hc0) sim_end <= 1;
        `ifdef TRACE_WR
            if (dmWrite == 1) $write("WR %x: %d\n", dmAddress, uart_char);
        `endif
    end
endmodule
