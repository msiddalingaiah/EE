
module blinky (clock, led1, led2, led3, led4, led5, led6, led7, led8, lcol1, lcol2, lcol3, lcol4 );
    input clock;
    output led1;
    output led2;
    output led3;
    output led4;
    output led5;
    output led6;
    output led7;
    output led8;
    output lcol1;
    output lcol2;
    output lcol3;
    output lcol4;

    /* Counter register */
    reg [31:0] counter = 32'b0;

    /* LED drivers - counter is inverted for display because leds are active low */
    assign {led8, led7, led6, led5, led4, led3, led2, led1} = counter[26:19] ^ 8'hff; 
    assign {lcol4, lcol3, lcol2, lcol1} = 4'b1110;


    /* Count up on every edge of the incoming 12MHz clock */
    always @ (posedge clock) begin
        counter <= counter + 1;
    end

endmodule
