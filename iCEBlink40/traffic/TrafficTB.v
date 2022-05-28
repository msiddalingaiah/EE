
`timescale 1 ns/10 ps  // time-unit = 1 ns, precision = 10 ps

`include "Clock.v"
`include "Traffic.v"

// Default clock is 3.33 MHz
module TrafficTB;
    initial begin
        $dumpfile("vcd/TrafficTB.vcd"); 
        $dumpvars(0, TrafficTB);
        #30000 $finish;
    end

    wire reset, clock;
    Clock c0(reset, clock);
    wire LED2, LED3, LED4, LED5;
    Traffic t0(clock, LED2, LED3, LED4, LED5);
endmodule
