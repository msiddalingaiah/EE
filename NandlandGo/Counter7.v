
`include "BinaryTo7Segment.v"
`include "DebounceSwitch.v"

module Counter7(
  input  clock,      // Main Clock (25 MHz)
  input  Switch_1,
  input  Switch_2,
  input  Switch_3,
  input  Switch_4,
  output Segment1_A,
  output Segment1_B,
  output Segment1_C,
  output Segment1_D,
  output Segment1_E,
  output Segment1_F,
  output Segment1_G,
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
  output LED_4);
 
  wire w_switch1, w_switch2;
  reg  sense1 = 1'b0;
  reg  sense2 = 1'b0;
  reg [3:0] digitCount1 = 4'b0000;
  reg [3:0] digitCount2 = 4'b0000;
  reg [23:0] led_count = 0;
  wire [6:0] digit1, digit2;

  assign { LED_1, LED_2, LED_3, LED_4 } = led_count[23:20];
  assign { Segment1_A, Segment1_B, Segment1_C, Segment1_D, Segment1_E, Segment1_F, Segment1_G } = ~digit1;
  assign { Segment2_A, Segment2_B, Segment2_C, Segment2_D, Segment2_E, Segment2_F, Segment2_G } = ~digit2;
 
  DebounceSwitch db1(clock, Switch_1, w_switch1);
  DebounceSwitch db2(clock, Switch_2, w_switch2);
  BinaryTo7Segment bcd71(clock, digitCount1, digit1);
  BinaryTo7Segment bcd72(clock, digitCount2, digit2);

  always @(posedge clock) begin
    sense1 <= w_switch1;
    sense2 <= w_switch2;
    // Increment Count when switch is pushed down
    if (w_switch1 == 1'b1 && sense1 == 1'b0) begin
      if (digitCount1 == 15)
        digitCount1 <= 0;
      else
        digitCount1 <= digitCount1 + 1;
    end

    if (w_switch2 == 1'b1 && sense2 == 1'b0) begin
      if (digitCount2 == 15)
        digitCount2 <= 0;
      else
        digitCount2 <= digitCount2 + 1;
    end

    led_count <= led_count + 1;
  end   
endmodule
