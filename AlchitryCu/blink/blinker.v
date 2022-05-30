
`include "PLL.v"

// Default clock is 100 MHz
// icepll -m -f PLL.v -n PLL -i 100 -o 20
module blinker(input clock_100MHz, output LED1, output LED2, output LED3, output LED4, output LED5, output LED6, output LED7, output LED8);
	reg [29:0] counter;

	wire clock;
	PLL pll(clock_100MHz, clock);
	assign {LED1, LED2, LED3, LED4, LED5, LED6, LED7, LED8} = counter[29:29-7];

	always @ (posedge clock)
		begin
			counter = counter + 1;
		end

endmodule
