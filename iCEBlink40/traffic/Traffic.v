
`include "CodeROM.v"
`include "Am2911.v"

// Default clock is 3.33 MHz
module Traffic(input clock, output LED2, output LED3, output LED4, output LED5);
    initial begin
		reset = 1;
    end

	// [19:16 LEDs] | [12:12 loadc] | [11:8 fe, pup, s1, s0] | [7:0 Di/constant]
	reg [19:0] pipeline;
	reg [24:0] counter;
	reg reset;

    wire [3:0] uc_rom_address = yout;
    wire [23:0] uc_rom_data;
    CodeROM uc_rom(uc_rom_address, uc_rom_data);

	assign { LED2, LED3, LED4, LED5 } = pipeline[19:16];
	wire loadc = pipeline[12:12];
	wire fe, pup, p_s1, p_s0;
	assign { fe, pup, p_s1, p_s0 } = pipeline[11:8];
	wire [3:0] din = pipeline[3:0];
	wire [7:0] constant = pipeline[7:0];

	wire zero = ~reset;
	wire re = 1;
	wire cout;
	wire [3:0] yout;
	reg s0, s1;
	Am2911 seq(clock, din, s0, s1, zero, cin, re, fe, pup, yout, cout);

	wire count_zero = counter == 0;
	wire cin = 1;

	parameter PRE_SCALE = 19;

	always @(*) begin
		s0 = p_s0;
		s1 = p_s1;
		if (loadc == 0) begin
			s0 = ~count_zero;
			s1 = ~count_zero;
		end
	end

	always @ (posedge clock) begin
		if (reset == 1) begin
			reset <= 0;
			counter <= 0;
		end else begin
			counter <= counter - 1;
		end
		pipeline <= uc_rom_data;
		if (loadc == 1) counter <=  { constant, {PRE_SCALE{1'b0}} };
	end
endmodule
