
`define PC_INC 0
`define TIMING_RESET 1
`define WRITE_EN 2
`define RA_DATA_IN_Q 3

`include "DecodeLogic.v"
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
    wire [63:0] enables;

    reg [15:0] pc;
    reg [7:0] opcode, data_in_q;
    reg [7:0] ra, rx, ry;

    assign address = pc;
    assign write_en = enables[`WRITE_EN];
    assign timing_reset = enables[`TIMING_RESET];
    assign pc_inc = enables[`PC_INC];
    assign ra_data_in_q = enables[`RA_DATA_IN_Q];

    DecodeLogic dec (reset, timing, opcode, enables);

    always @(posedge clock, posedge reset) begin
        if (reset == 1) begin
            pc <= 0;
            opcode <= 8'hea;
            timing <= 8'b00000001;
            data_in_q <= 0;
            ra <= 0;
            rx <= 0;
            ry <= 0;
        end else begin
            if (timing_reset == 1) begin
                timing <= 8'b00000001;
                opcode <= data_in;
            end else begin
                timing <= { timing[6:0], timing[7] };
            end
            if (pc_inc == 1) pc <= pc + 1;
            if (ra_data_in_q == 1) ra <= data_in_q;
            data_in_q <= data_in;
        end
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
