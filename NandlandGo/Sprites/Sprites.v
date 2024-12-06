
module SpriteROM(input wire clock, input wire [5:0] sprite_num, input wire [2:0] row_num, input wire [2:0] col_num, output reg [1:0] pixel);
    reg [1:0] memory[0:2047];
    initial begin
        $readmemb("sprites.txt", memory);
        pixel = 0;
    end

    wire [10:0] mem_address = { sprite_num[5:0], row_num, col_num };

    always @(posedge clock) begin
        // if (pixel === 2'bxx) begin
        //     $display("X pixel at 0x%x, %d\n", mem_address, mem_address);
        //     $finish;
        // end
        pixel <= memory[mem_address];
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
    output LED_4
`ifdef TESTBENCH
    , output wire [9:0] tb_row,
    output wire [9:0] tb_column,
    output wire [1:0] tb_pixel);
`else
	);
`endif

    reg [23:0] led_count = 0;
    wire [6:0] left_digit_segments, right_digit_segments;

    // LEDs are for operational display only, it's a nice sanity check
    assign { LED_1, LED_2, LED_3, LED_4 } = led_count[23:20];

    // 7-segment displays are used to display left/right score
    assign { Segment1_A, Segment1_B, Segment1_C, Segment1_D, Segment1_E, Segment1_F, Segment1_G } = ~left_digit_segments;
    assign { Segment2_A, Segment2_B, Segment2_C, Segment2_D, Segment2_E, Segment2_F, Segment2_G } = ~right_digit_segments;

    BinaryTo7Segment bcd71({2'b00, sprite_num[5:4]}, left_digit_segments);
    BinaryTo7Segment bcd72(sprite_num[3:0], right_digit_segments);

    // Beam row/column positions
    reg [9:0] column, row;

    // VGA RGB 3-bit DAC signals
    wire [2:0] red, green, blue;

    // 9-bit beam color (RGB)
    reg [8:0] color;
    reg hsync, vsync;

    localparam H_ACTIVE = 10'd640;
    localparam H_FPORCH = 10'd16;
    localparam H_PULSE = 10'd96;
    localparam H_MAX = 10'd800;

    localparam V_ACTIVE = 10'd480;
    localparam V_FPORCH = 10'd10;
    localparam V_PULSE = 10'd2;
    localparam V_MAX = 10'd525;

    initial begin
        row = 0;
        column = 0;
        color = 0;
        hsync = 1'b1;
        vsync = 1'b1;
        sprite_num = 0;
    end

    // See https://vanhunteradams.com/DE1/VGA_Driver/Driver.html
    // Generate horizontal and vertical sync pulses based on row/column position
    assign o_VGA_HSync = hsync;
    assign o_VGA_VSync = vsync;

    // Generate beam color in active area only
    assign { o_VGA_Red_2, o_VGA_Red_1, o_VGA_Red_0 } = (column < H_ACTIVE && row < V_ACTIVE) ? red : 0;
    assign { o_VGA_Grn_2, o_VGA_Grn_1, o_VGA_Grn_0 } = (column < H_ACTIVE && row < V_ACTIVE) ? green : 0;
    assign { o_VGA_Blu_2, o_VGA_Blu_1, o_VGA_Blu_0  } = (column < H_ACTIVE && row < V_ACTIVE) ? blue : 0;

    // 9-bit beam color
    assign { red, green, blue } = color;

    wire [1:0] sprite_pixel;
    reg [5:0] sprite_num;
    wire [2:0] sprite_row_num = row[3:1];
    wire [2:0] sprite_col_num = column[3:1];

    SpriteROM sr(i_Clk, sprite_num, sprite_row_num, sprite_col_num, sprite_pixel);

`ifdef TESTBENCH
    assign tb_pixel = sprite_pixel;
    assign tb_row = row;
    assign tb_column = column;
`endif

    // Combinational logic to generate color for each "pixel", e.g. "Racing the Beam"
    always @(*) begin
        color = 0;
        case (sprite_pixel)
            0: color = 9'b000000000;
            1: color = 9'b111111100;
            2: color = 9'b111000000;
            3: color = 9'b000111000;
        endcase
    end

    always @(posedge i_Clk) begin
        column <= column + 1;
        if (column[4:0] == 5'd0) begin
            // sprite_num <= sprite_num + 1'b1;
        end
        if (column == H_MAX-1) begin
            column <= 0;
            row <= row + 1;
            if (row == V_MAX-1) begin
                row <= 0;
            end
        end
        if (column == H_ACTIVE+H_FPORCH-10'd1) hsync <= 1'b0;
        if (column == H_ACTIVE+H_FPORCH+H_PULSE-10'd1) hsync <= 1'b1;
        if (row == V_ACTIVE+V_FPORCH-10'd1) vsync <= 1'b0;
        if (row == V_ACTIVE+V_FPORCH+V_PULSE-10'd1) vsync <= 1'b1;

        led_count <= led_count + 1;

        // led_count is used for game refresh rate
        if (led_count[16:0] == 0) begin
        end
        if (led_count == 0) begin
            sprite_num <= sprite_num + 1;
            if (sprite_num == 6'd31) sprite_num <= 0;
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
