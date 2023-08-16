
// `define TRACE_I // trace instructions
// `define TRACE_REGS // trace registers
// `define TRACE_WR // trace bus writes
// `define TRACE_RD // trace bus reads

// DM/PM memory size in bytes
`define MEM_SIZE 65536

`define ALU_OP_ADD 0
`define ALU_OP_SUB 1
`define ALU_OP_AND 2
`define ALU_OP_OR 3
`define ALU_OP_XOR 4
`define ALU_OP_LTU 5
`define ALU_OP_LT 6
`define ALU_OP_ZERO 15

`include "Memory.v"
`include "ALU.v"
`include "RV32I.v"

/*

https://wavedrom.com/editor.html

{ "signal" : [
  { "name": "clk",       "wave": "p............" },
  { "name": "reset",     "wave": "010...........", phase: 2.9 },
  { "name": "post_reset","wave": "1.0...........", phase: 2.0 },
  { "name": "pc_next",   "wave": "444444.4444.|", "data": ["0", "4", "14", "18", "1C", "20", "24", "28", "1C", "20"] },
  { "name": "pc",        "wave": "3333333.3333|", "data": ["0", "0", "4", "14", "18", "1C", "20", "24", "28", "1C", "20"] },
  { "name": "opcode",    "wave": "z555555.5555|", "data": ["li 400", "j 14", "li 3", "sw r15", "lw a5", "ai a5", "sw r15", "j 1C", "lw a5", "ai a5"] },
  { "name": "mem_load",  "wave": "0.....10...1|", "data": [] },
  { "name": "reg_data",  "wave": "zzzzzz66zzz6|", "data": ["mem_data", "reg_data", "mem_data"] },
  { "name": "dm_wr",     "wave": "0...10..10..|", "data": [] },
  { "name": "dm_addr",   "wave": "zzzzz7zzzz7z|", "data": ["addr", "addr"] },
  { "name": "dm_data",   "wave": "zzzzzz8zzzz8|", "data": ["data", "data"] },
  ],
  config: { hscale: 2 }
}

 */

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
    wire [31:0] pmAddress;
    wire [2:0] pmFunc3;
    wire pmWrite;
    wire [31:0] pmDataCOut;
    wire [31:0] pmDataCIn;
    wire [31:0] dmAddress;
    wire [2:0] dmFunc3;
    wire dmWrite;
    wire [31:0] dmDataCOut;
    wire [31:0] dmDataCIn;
    wire [7:0] uart_char = dmDataCOut & 8'h7f;

    Clock cg0(clock);
    Memory pMemory (clock, pmAddress, pmFunc3, pmWrite, pmDataCOut, pmDataCIn);
    Memory dMemory (clock, dmAddress, dmFunc3, dmWrite, dmDataCOut, dmDataCIn);
    RV32I cpu(reset, clock, pmAddress, pmFunc3, pmWrite, pmDataCOut, pmDataCIn,
        dmAddress, dmFunc3, dmWrite, dmDataCOut, dmDataCIn);

    reg [7:0] temp[0:`MEM_SIZE];

    integer i;
    initial begin
        $dumpfile("vcd/tb.vcd");
        $dumpvars(0, tb);

        $write("Begin...\n");
        $readmemh("bin/main.hex", temp);
        for (i=0; i<`MEM_SIZE; i=i+4) begin
            pMemory.cells0[i>>2] = temp[i+0];
            pMemory.cells1[i>>2] = temp[i+1];
            pMemory.cells2[i>>2] = temp[i+2];
            pMemory.cells3[i>>2] = temp[i+3];
        end

        #0 reset=0; #25 reset=1; #100; reset=0;

        #10000;
        $write("All done!\n");
        $finish;
    end

    always @(posedge clock) begin
        if (dmWrite == 1 && dmAddress == 32'hf0000010) $write("%s", uart_char);
        `ifdef TRACE_WR
            if (dmWrite == 1) $write("WR %x: %d\n", dmAddress, uart_char);
        `endif
    end
endmodule
