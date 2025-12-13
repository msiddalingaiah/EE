
/*
 * Copyright (c) 2025 Madhu Siddalingaiah
 * See https://github.com/msiddalingaiah/EE/blob/main/LICENSE
 */

module ROM(input wire clock, input wire [15:0] address, output reg [15:0] data);
    reg [15:0] memory[0:1023];
    initial begin
        $readmemh("roms/rom.txt", memory);
    end

    wire [9:0] mem_address = address[9:0];

    always @(posedge clock) begin
        data <= memory[mem_address];
    end
endmodule

module RAM(input wire clock, input wire write, input wire [15:0] address, input wire [7:0] wr_data,
    output reg [7:0] rd_data);

    reg[7:0] memory[0:1023];
    integer i;
    initial begin
        for (i=0; i<1024; i=i+1) begin
            memory[i] = 0;
        end
    end

    wire [9:0] mem_address = address[9:0];

    always @(posedge clock) begin
        if (write) memory[mem_address] <= wr_data;
        rd_data <= memory[mem_address];
    end
endmodule

module Gigatron (
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

    wire [6:0] left_digit_segments, right_digit_segments;
    wire [3:0] switches = { i_Switch_1, i_Switch_2, i_Switch_3, i_Switch_4 };

    reg [3:0] leds_on_off;
    reg [7:0] leds_numeric;

    // LEDs are for operational display only, it's a nice sanity check
    assign { LED_1, LED_2, LED_3, LED_4 } = leds_on_off;

    // 7-segment displays are used to display left/right score
    assign { Segment1_A, Segment1_B, Segment1_C, Segment1_D, Segment1_E, Segment1_F, Segment1_G } = ~left_digit_segments;
    assign { Segment2_A, Segment2_B, Segment2_C, Segment2_D, Segment2_E, Segment2_F, Segment2_G } = ~right_digit_segments;

    BinaryTo7Segment bcd71(leds_numeric[7:4], left_digit_segments);
    BinaryTo7Segment bcd72(leds_numeric[3:0], right_digit_segments);

    reg reset, reset_inhibit;

    reg [7:0] a, x, y;
    reg [15:0] pc;

    // ROM
    wire [15:0] rom_rd_data;

    ROM rom(i_Clk, pc, rom_rd_data);

    // RAM
    reg ram_write;
    reg [15:0] ram_addr = 10'h00;
    reg [7:0] ram_wr_data = 8'h00;
    wire [7:0] ram_rd_data = 8'h00;

    RAM ram(i_Clk, ram_write, ram_addr, ram_wr_data, ram_rd_data);

    reg [7:0] source, alu;

    wire [7:0] ir = rom_rd_data[15:8];
    wire [7:0] d = rom_rd_data[7:0];

    wire [2:0] op = ir[7:5];
    wire [2:0] mode = ir[4:2];
    wire [1:0] bus = ir[1:0];

    initial begin
        reset = 1'b0;
        reset_inhibit = 1'b0;
        a = 0;
        x = 0;
        y = 0;
        pc = 0;
    end

    localparam OP_LOAD = 3'h0;
    localparam OP_AND = 3'h1;
    localparam OP_OR = 3'h2;
    localparam OP_XOR = 3'h3;
    localparam OP_ADD = 3'h4;
    localparam OP_SUB = 3'h5;
    localparam OP_STORE = 3'h6;
    localparam OP_JUMP = 3'h7;

    // Guideline #3: When modeling combinational logic with an "always" block, use blocking assignments ( = ).
    always @(*) begin
        ram_write = op == OP_STORE ? 1 : 0;
        source = 0;
        case (bus)
            0: source = d;
            1: source = ram_rd_data;
            2: source = a;
            3: source = 0; // IN not implemented
        endcase
        case (op)
            OP_LOAD: alu = source;
            OP_AND: alu = a & source;
            OP_OR: alu = a | source;
            OP_XOR: alu = a ^ source;
            OP_ADD: alu = a + source;
            OP_SUB: alu = a - source;
            OP_STORE: alu = a;
            OP_JUMP: alu = -a;
        endcase
        ram_addr = 15'h0;
        case (mode)
            1: ram_addr = { 8'h0, x };
            2: ram_addr = { y, d };
            3: ram_addr = { y, x };
            7: ram_addr = { y, x };
        endcase
    end

    // Guideline #1: When modeling sequential logic, use nonblocking assignments ( <= ).
    always @(posedge i_Clk) begin
`ifdef TESTBENCH
        // Short reset is enough for simulation
        reset <= 0;
`endif
        if (~reset & ~reset_inhibit) begin reset <= 1'b1; reset_inhibit <= 1'b1; end
        pc <= pc + 1;
        case (op)
            OP_STORE: ;
            OP_JUMP: begin
                    if (mode == 3'h7) pc <= source;
                end
            default:
                case (mode)
                    0: a <= alu;
                    1: a <= alu;
                    2: a <= alu;
                    3: a <= alu;
                    4: x <= alu;
                    5: y <= alu;
                    6: ; // OUT not implemented
                    7: x <= x + 1; // OUT not implemented
                endcase
        endcase
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
