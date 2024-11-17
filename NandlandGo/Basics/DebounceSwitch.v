
module DebounceSwitch (input clock, input sw_input, output debounced);
  parameter DEBOUNCE_COUNT = 25000;  // 1 ms at 25 MHz

  reg [17:0] count = DEBOUNCE_COUNT;
  reg state = 1'b0;
  assign debounced = state;

  always @(posedge clock) begin
    if (sw_input != state) begin
      if (count != 0) begin
        count <= count - 1;
      end else begin
        count <= DEBOUNCE_COUNT;
        state <= sw_input;
      end
    end
  end 
endmodule
