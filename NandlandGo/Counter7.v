
`include "BinaryTo7Segment.v"
`include "DebounceSwitch.v"

module Counter7
  (input  clock,      // Main Clock (25 MHz)
   input  Switch_1, 
   output Segment2_A,
   output Segment2_B,
   output Segment2_C,
   output Segment2_D,
   output Segment2_E,
   output Segment2_F,
   output Segment2_G,
   output LED_1,
   output LED_2,
   output LED_3,
   output LED_4
   );
 
  wire w_Switch_1;
  reg  r_Switch_1 = 1'b0;
  reg [3:0] r_Count = 4'b0000;
  reg [23:0] led_count = 0;
  wire [6:0] digit2;

  assign { LED_1, LED_2, LED_3, LED_4 } = led_count[23:20];
  assign { Segment2_A, Segment2_B, Segment2_C, Segment2_D, Segment2_E, Segment2_F, Segment2_G } = ~digit2;
 
  DebounceSwitch db1(.clock(clock), .i_Switch(Switch_1), .o_Switch(w_Switch_1));
  BinaryTo7Segment inst(.clock(clock), .bcd(r_Count), .digit(digit2));

  always @(posedge clock) begin
    r_Switch_1 <= w_Switch_1;
       
      // Increment Count when switch is pushed down
      if (w_Switch_1 == 1'b1 && r_Switch_1 == 1'b0) begin
        if (r_Count == 15)
          r_Count <= 0;
        else
          r_Count <= r_Count + 1;
      end

      led_count <= led_count + 1;
  end   
endmodule
