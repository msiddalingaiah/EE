
module SpriteROM(input wire clock, input wire [6:0] row_address, output reg [255:0] row_data);
    reg [255:0] memory[0:127];
    initial begin
        $readmemh("sprites.txt", memory);
    end

    always @(posedge clock) begin
        row_data <= memory[row_address];
    end
endmodule

module Sprites (
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

    reg [23:0] led_count = 0;
    reg [3:0] left_digit, right_digit;
    wire [6:0] left_digit_segments, right_digit_segments;

    // LEDs are for operational display only, it's a nice sanity check
    assign { LED_1, LED_2, LED_3, LED_4 } = led_count[23:20];

    // 7-segment displays are used to display left/right score
    assign { Segment1_A, Segment1_B, Segment1_C, Segment1_D, Segment1_E, Segment1_F, Segment1_G } = ~left_digit_segments;
    assign { Segment2_A, Segment2_B, Segment2_C, Segment2_D, Segment2_E, Segment2_F, Segment2_G } = ~right_digit_segments;

    BinaryTo7Segment bcd71(left_digit, left_digit_segments);
    BinaryTo7Segment bcd72(right_digit, right_digit_segments);

    // Beam row/column positions
    reg [9:0] column, row;

    // VGA RGB 3-bit DAC signals
    wire [2:0] red, green, blue;

    // 9-bit beam color (RGB)
    reg [8:0] color;

    localparam H_ACTIVE = 640;
    localparam H_FPORCH = 16;
    localparam H_PULSE = 96;
    localparam H_MAX = 800;

    localparam V_ACTIVE = 480;
    localparam V_FPORCH = 10;
    localparam V_PULSE = 2;
    localparam V_MAX = 525;

    initial begin
        row = 0;
        column = 0;
        color = 0;
        left_digit = 0;
        right_digit = 0;
        shift_reg = { 32'hff00ff00, 32'hff00ff00, 32'hff00ff00, 32'hff00ff00, 32'hff00ff00, 32'hff00ff00, 32'hff00ff00, 32'hff00ff00 };
    end

    // See https://vanhunteradams.com/DE1/VGA_Driver/Driver.html
    // Generate horizontal and vertical sync pulses based on row/column position
    assign o_VGA_HSync = (column < H_ACTIVE+H_FPORCH || column >= H_ACTIVE+H_FPORCH+H_PULSE) ? 1 : 0;
    assign o_VGA_VSync = (row < V_ACTIVE+V_FPORCH || row >= V_ACTIVE+V_FPORCH+V_PULSE) ? 1 : 0;

    // Generate beam color in active area only
    assign { o_VGA_Red_2, o_VGA_Red_1, o_VGA_Red_0 } = (column < H_ACTIVE && row < V_ACTIVE) ? red : 0;
    assign { o_VGA_Grn_2, o_VGA_Grn_1, o_VGA_Grn_0 } = (column < H_ACTIVE && row < V_ACTIVE) ? green : 0;
    assign { o_VGA_Blu_2, o_VGA_Blu_1, o_VGA_Blu_0  } = (column < H_ACTIVE && row < V_ACTIVE) ? blue : 0;

    // 9-bit beam color
    assign { red, green, blue } = color;

    wire [255:0] sprite_row;
    wire [6:0] sprite_address = row[7:1];
    reg [255:0] shift_reg;

    SpriteROM sr(i_Clk, sprite_address, sprite_row);

    // Combinational logic to generate color for each "pixel", e.g. "Racing the Beam"
    always @(*) begin
        color = 0;
        case (shift_reg[255:254])
            0: color = 9'b000000000;
            1: color = 9'b111111100;
            2: color = 9'b111000000;
            3: color = 9'b000111000;
        endcase
    end

    always @(posedge i_Clk) begin
        column <= column + 1;
        if (column[0] == 0) shift_reg <= { shift_reg[253:0], shift_reg[255:254] };
        if (column == H_MAX-1) begin
            column <= 0;
            shift_reg <= sprite_row;
            row <= row + 1;
            if (row == V_MAX-1) begin
                row <= 0;
            end
        end

        led_count <= led_count + 1;

        // led_count is used for game refresh rate
        if (led_count[16:0] == 0) begin
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
