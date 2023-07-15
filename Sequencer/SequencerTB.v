
`timescale 1 ns/10 ps  // time-unit = 1 ns, precision = 10 ps
`include "Sequencer.v"

module Clock(output reg clock);
    initial begin
        #0 clock = 0;
    end

    always begin
        #100 clock <= ~clock;
    end
endmodule

module CodeROM(input wire [11:0] address, output wire [55:0] data);
    reg [55:0] memory[0:4095];
    initial begin
        $readmemh("roms/CodeROM.txt", memory);
    end

    assign data = memory[address];
endmodule

module SequencerTB;
    initial begin
		reset = 1;
        $dumpfile("vcd/SequencerTB.vcd");
        $dumpvars(0, SequencerTB);

        $display("All done!");
        $finish;
    end

	reg reset;
    wire clock;
    Clock cg0(clock);
    wire [1:0] seq_op;
    wire [11:0] seq_din = pipeline[11:0];
    wire [11:0] seq_yout;
    Sequencer seq0(reset, clock, seq_op, seq_din, seq_yout);

    wire [55:0] uc_rom_data;
    CodeROM uc_rom(seq_yout, uc_rom_data);
    reg [55:0] pipeline;

	always @(posedge clock) begin
		if (reset == 1) begin
			reset <= 0;
		end else begin
    		pipeline <= uc_rom_data;
		end
	end
endmodule
