
module VGA (
    input  i_Clk,
    input  i_Switch_1,
    input  i_Switch_2,
    input  i_Switch_3,
    input  i_Switch_4,

    // VGA
    output o_VGA_HSync,
    output o_VGA_VSync,
    output o_VGA_Red_0,
    output o_VGA_Red_1,
    output o_VGA_Red_2,
    output o_VGA_Grn_0,
    output o_VGA_Grn_1,
    output o_VGA_Grn_2,
    output o_VGA_Blu_0,
    output o_VGA_Blu_1,
    output o_VGA_Blu_2,

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

    reg [7:0] digitCount = 0;
    reg [23:0] led_count = 0;
    wire [6:0] digit1, digit2;

    assign { LED_1, LED_2, LED_3, LED_4 } = led_count[23:20];
    assign { Segment1_A, Segment1_B, Segment1_C, Segment1_D, Segment1_E, Segment1_F, Segment1_G } = ~digit1;
    assign { Segment2_A, Segment2_B, Segment2_C, Segment2_D, Segment2_E, Segment2_F, Segment2_G } = ~digit2;

    BinaryTo7Segment bcd71(digitCount[7:4], digit1);
    BinaryTo7Segment bcd72(digitCount[3:0], digit2);

    reg [9:0] column, row;

    initial begin
        row = 0;
        column = 0;
    end
    
    // See https://vanhunteradams.com/DE1/VGA_Driver/Driver.html
    assign o_VGA_HSync = (column < 640+16 || column >= 640+16+96) ? 1 : 0;
    assign o_VGA_VSync = (row < 480+10 || row >= 480+10+2) ? 1 : 0;
    assign o_VGA_Blu_2 = 0;
    assign o_VGA_Blu_1 = 0;
    assign o_VGA_Blu_0 = 0;
    assign o_VGA_Grn_2 = (column < 640 && row < 480) ? 1 : 0;
    assign o_VGA_Grn_1 = (column < 640 && row < 480) ? 1 : 0;
    assign o_VGA_Grn_0 = (column < 640 && row < 480) ? 1 : 0;
    assign o_VGA_Red_2 = 0;
    assign o_VGA_Red_1 = 0;
    assign o_VGA_Red_0 = 0;

    always @(posedge i_Clk) begin
        led_count <= led_count + 1;
        if (led_count == 0) begin
            digitCount <= digitCount + 1;
        end

        column <= column + 1;
        if (column == 799) begin
            column <= 0;
            row <= row + 1;
            if (row == 524) begin
                row <= 0;
            end
        end
    end
endmodule

module BinaryTo7Segment (input [3:0] bcd, output reg [6:0] segments);
    always @(*) begin
        case (bcd)
            4'b0000 : segments <= 7'h7E;
            4'b0001 : segments <= 7'h30;
            4'b0010 : segments <= 7'h6D;
            4'b0011 : segments <= 7'h79;
            4'b0100 : segments <= 7'h33;          
            4'b0101 : segments <= 7'h5B;
            4'b0110 : segments <= 7'h5F;
            4'b0111 : segments <= 7'h70;
            4'b1000 : segments <= 7'h7F;
            4'b1001 : segments <= 7'h7B;
            4'b1010 : segments <= 7'h77;
            4'b1011 : segments <= 7'h1F;
            4'b1100 : segments <= 7'h4E;
            4'b1101 : segments <= 7'h3D;
            4'b1110 : segments <= 7'h4F;
            4'b1111 : segments <= 7'h47;
        endcase
    end
endmodule
