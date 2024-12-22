
`define CPU_WIDTH 12
`define CPU_WIDTHm1 (`CPU_WIDTH-1)

`include "StackMachine.v"

module MotionSpriteROM(input wire clock, input wire [5:0] sprite_num, input wire [2:0] row_num, input wire [2:0] col_num, output reg [1:0] pixel);
    reg [1:0] memory[0:2047];
    initial begin
        $readmemb("sprites.txt", memory);
        pixel = 0;
    end

    wire [10:0] mem_address = { sprite_num[5:0], row_num, col_num };

    always @(posedge clock) begin
        pixel <= memory[mem_address];
    end
endmodule

module PlayfieldSpriteROM(input wire clock, input wire [5:0] sprite_num, input wire [2:0] row_num, input wire [2:0] col_num, output reg [1:0] pixel);
    reg [1:0] memory[0:2047];
    initial begin
        $readmemb("sprites.txt", memory);
        pixel = 0;
    end

    wire [10:0] mem_address = { sprite_num[5:0], row_num, col_num };

    always @(posedge clock) begin
        pixel <= memory[mem_address];
    end
endmodule

module LineRAM(input wire clock, input wire write, input wire [10:0] write_addr, input wire [1:0] wr_data,
    input wire [10:0] read_addr, output reg [1:0] rd_data);

    reg[1:0] memory[0:2047];
    integer i;
    initial begin
        for (i=0; i<2048; i=i+1) begin
            memory[i] = i & 3;
        end
    end

    always @(posedge clock) begin
        if (write) memory[write_addr] <= wr_data;
        rd_data <= memory[read_addr];
    end
endmodule

// 32 rows x 32 columns playfield sprites
module PlayfieldRAM(input wire clock, input wire write, input wire [9:0] write_addr, input wire [7:0] wr_data,
    input wire [9:0] read_addr, output reg [7:0] rd_data);

    reg[7:0] memory[0:1023];
    integer i;
    initial begin
        for (i=0; i<1024; i=i+1) begin
            memory[i] = 0;
        end
        memory[(29 << 5) | 15] = 26;
        memory[(29 << 5) | 16] = 26;
        memory[(29 << 5) | 17] = 26;
    end

    always @(posedge clock) begin
        if (write) memory[write_addr] <= wr_data;
        rd_data <= memory[read_addr];
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

    reg [25:0] led_count = 0;
    wire [6:0] left_digit_segments, right_digit_segments;
    wire [3:0] switches = { i_Switch_1, i_Switch_2, i_Switch_3, i_Switch_4 };

    // Beam row/column positions
    reg [9:0] column, row;

    // VGA RGB 3-bit DAC signals
    wire [2:0] red, green, blue;

    // 9-bit beam color (RGB)
    reg [8:0] color;
    reg hsync, vsync;

    wire [1:0] motion_sprite_pixel, playfield_sprite_pixel;
    reg [1:0] out_pixel;
    reg [5:0] sprite_num;
    reg [2:0] sprite_row_num;
    reg [2:0] sprite_col_num;
    reg [9:0] sprite_x, sprite_y, sprite_dx, sprite_dy;
    // Ping-pong every other line
    reg lr_write;
    wire [10:0] lr_read_addr = { 2'b00, ~row[1], column[8:1] };
    wire [10:0] lr_write_addr = { 2'b00, row[1], column[8:1] };
    wire [1:0] lr_rd_data;
    reg [1:0] lr_wr_data;
    // Playfield RAM
    reg pf_write;
    wire [9:0] pf_read_addr = { row[8:4], column[8:4] };
    wire [9:0] pf_write_addr = 10'h00;
    wire [7:0] pf_sprite;
    wire [7:0] pf_wr_data = 8'h00;
    reg reset, reset_inhibit;
    wire cpu_write;
    wire [`CPU_WIDTHm1:0] cpu_addr, cpu_wr_data;
    reg [`CPU_WIDTHm1:0] cpu_rd_data;
    reg cpu_decode_io;
    reg [3:0] leds_on_off;
    reg [7:0] leds_numeric;
    reg vertical_int;
    wire [7:0] cpu_op;

    // LEDs are for operational display only, it's a nice sanity check
    // assign { LED_1, LED_2, LED_3, LED_4 } = led_count[23:20];
    assign { LED_1, LED_2, LED_3, LED_4 } = leds_on_off;

    // 7-segment displays are used to display left/right score
    assign { Segment1_A, Segment1_B, Segment1_C, Segment1_D, Segment1_E, Segment1_F, Segment1_G } = ~left_digit_segments;
    assign { Segment2_A, Segment2_B, Segment2_C, Segment2_D, Segment2_E, Segment2_F, Segment2_G } = ~right_digit_segments;

    BinaryTo7Segment bcd71(leds_numeric[7:4], left_digit_segments);
    BinaryTo7Segment bcd72(leds_numeric[3:0], right_digit_segments);

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
        sprite_num = 1;
        sprite_x = 10'h00;
        sprite_y = 10'h00;
        leds_on_off = 4'h0;
        leds_numeric = 8'h0;
        vertical_int = 1'b0;
        reset = 1'b0;
        reset_inhibit = 1'b0;
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

    MotionSpriteROM motion_rom(i_Clk, sprite_num, sprite_row_num, sprite_col_num, motion_sprite_pixel);
    PlayfieldSpriteROM playfield_rom(i_Clk, pf_sprite[5:0], sprite_row_num, sprite_col_num, playfield_sprite_pixel);
    LineRAM line_ram(i_Clk, lr_write, lr_write_addr, lr_wr_data, lr_read_addr, lr_rd_data);
    PlayfieldRAM playfield_ram(i_Clk, pf_write, pf_write_addr, pf_wr_data, pf_read_addr, pf_sprite);
    StackMachine cpu(reset, i_Clk, cpu_addr, cpu_rd_data, cpu_write, cpu_wr_data, cpu_op);

`ifdef TESTBENCH
    assign tb_pixel = lr_rd_data;
    assign tb_row = row;
    assign tb_column = column;
`endif

    // Combinational logic to generate color for each "pixel", e.g. "Racing the Beam"
    always @(*) begin
        cpu_decode_io = cpu_addr[`CPU_WIDTHm1:`CPU_WIDTHm1-1] != 2'h0 ? 1'b1 : 1'b0;

        sprite_row_num = row[3:1];
        sprite_col_num = column[3:1];
        out_pixel = playfield_sprite_pixel;
        lr_write = 1'b0;
        lr_wr_data = motion_sprite_pixel;
        sprite_dx = column - sprite_x;
        sprite_dy = row - sprite_y;
        if (sprite_dy[9:4] == 6'h3f) begin
            if (sprite_dx < 10'd16) begin
                sprite_row_num = sprite_dy[3:1];
                sprite_col_num = sprite_dx[3:1];
                lr_write = 1'b1;
            end
        end else begin
            lr_wr_data <= 0;
            lr_write = 1'b1;
        end

        pf_write = 0;

        if (lr_rd_data != 0) out_pixel = lr_rd_data;
        color = 0;
        case (out_pixel)
            0: color = 9'b000000000;
            1: color = 9'b111111100;
            2: color = 9'b111000000;
            3: color = 9'b000111000;
        endcase

        cpu_rd_data = {`CPU_WIDTH{1'b0}};
        if (cpu_decode_io) begin
            case (cpu_addr[`CPU_WIDTHm1:`CPU_WIDTHm1-1])
                2'h1: begin
                    if (cpu_addr[3:0] == 4'h0) cpu_rd_data = { {`CPU_WIDTH-6{1'b0}}, sprite_num };
                    if (cpu_addr[3:0] == 4'h1) cpu_rd_data = { {`CPU_WIDTH-10{1'b0}}, sprite_x };
                    if (cpu_addr[3:0] == 4'h2) cpu_rd_data = { {`CPU_WIDTH-10{1'b0}}, sprite_y };
                end
                2'h2: begin
                end
                2'h3: begin
                    if (cpu_addr[1:0] == 2'h0) cpu_rd_data = { {`CPU_WIDTH-4{1'b0}}, leds_on_off };
                    if (cpu_addr[1:0] == 2'h1) cpu_rd_data = { {`CPU_WIDTH-8{1'b0}}, leds_numeric };
                    if (cpu_addr[1:0] == 2'h2) cpu_rd_data = { {`CPU_WIDTH-4{1'b0}}, switches };
                    if (cpu_addr[1:0] == 2'h3) cpu_rd_data = { {`CPU_WIDTH-1{1'b0}}, vertical_int };
                end
            endcase
        end
    end

    always @(posedge i_Clk) begin
`ifdef TESTBENCH
        // Short reset is enough for simulation
        reset <= 0;
`endif
        if (~reset & ~reset_inhibit) begin reset <= 1'b1; reset_inhibit <= 1'b1; end
        column <= column + 1;
        if (column == H_MAX-1) begin
            column <= 0;
            row <= row + 1;
            if (row == V_MAX-1) begin
                row <= 0;
                vertical_int <= 1'b1;
                // De-assert reset after ~16 ms for synthesis
                reset <= 0;
            end
        end
        if (column == H_ACTIVE+H_FPORCH-10'd1) hsync <= 1'b0;
        if (column == H_ACTIVE+H_FPORCH+H_PULSE-10'd1) hsync <= 1'b1;
        if (row == V_ACTIVE+V_FPORCH-10'd1) vsync <= 1'b0;
        if (row == V_ACTIVE+V_FPORCH+V_PULSE-10'd1) vsync <= 1'b1;

        led_count <= led_count + 1;

        if (cpu_write & cpu_decode_io) begin
            case (cpu_addr[`CPU_WIDTHm1:`CPU_WIDTHm1-1])
                2'h1: begin
                    if (cpu_addr[3:0] == 4'h0) sprite_num = cpu_wr_data[5:0];
                    if (cpu_addr[3:0] == 4'h1) sprite_x = cpu_wr_data[9:0];
                    if (cpu_addr[3:0] == 4'h2) sprite_y = cpu_wr_data[9:0];
                end
                2'h2: begin
                end
                2'h3: begin
                    if (cpu_addr[1:0] == 2'h0) leds_on_off <= cpu_wr_data[3:0];
                    if (cpu_addr[1:0] == 2'h1) leds_numeric <= cpu_wr_data[7:0];
                    if (cpu_addr[1:0] == 2'h3) vertical_int <= cpu_wr_data[0];
                end
            endcase
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
