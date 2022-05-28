
// Default clock is 3.33 MHz
module blinker(input clock, output LED2, output LED3, output LED4, output LED5);
	reg [20:0] counter;

	always @ (posedge clock)
		begin
			counter = counter + 21'd1;
		end

	assign {LED2, LED3, LED4, LED5} = counter[20:17];
endmodule
