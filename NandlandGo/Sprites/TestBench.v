
`timescale 1 ns/10 ps  // time-unit = 1 ns, precision = 10 ps

`define TESTBENCH

`include "Sprites.v"

module Clock(output reg clock);
    initial begin
        #0 clock = 0;
    end

    always begin
        #20 clock <= ~clock;
    end
endmodule

module TestBench;
    integer fd;
    initial begin
        // $dumpfile("vcd/TestBench.vcd");
        // $dumpvars(0, TestBench);
        cycle_count = 0;
        pixel_shift_reg = 0;
        pixel_sr_count = 0;
        fd = $fopen("vcd/image.txt", "w");
    end

    reg [31:0] cycle_count;

    wire i_Clk;

    Clock cg0(i_Clk);

    wire  i_Switch_1;
    wire  i_Switch_2;
    wire  i_Switch_3;
    wire  i_Switch_4;

    // VGA
    wire o_VGA_HSync;
    wire o_VGA_VSync;
    wire o_VGA_Red_0;
    wire o_VGA_Red_1;
    wire o_VGA_Red_2;
    wire o_VGA_Grn_0;
    wire o_VGA_Grn_1;
    wire o_VGA_Grn_2;
    wire o_VGA_Blu_0;
    wire o_VGA_Blu_1;
    wire o_VGA_Blu_2;

    wire Segment1_A;
    wire Segment1_B;
    wire Segment1_C;
    wire Segment1_D;
    wire Segment1_E;
    wire Segment1_F;
    wire Segment1_G;
    wire Segment2_A;
    wire Segment2_B;
    wire Segment2_C;
    wire Segment2_D;
    wire Segment2_E;
    wire Segment2_F;
    wire Segment2_G;
    wire LED_1;
    wire LED_2;
    wire LED_3;
    wire LED_4;
    wire [9:0] tb_row;
    wire [9:0] tb_column;
    wire [1:0] tb_pixel;

    reg [31:0] pixel_shift_reg;
    reg [4:0] pixel_sr_count;

    Sprites sp(
        i_Clk,
        i_Switch_1,
        i_Switch_2,
        i_Switch_3,
        i_Switch_4,

        // VGA
        o_VGA_HSync,
        o_VGA_VSync,
        o_VGA_Red_0,
        o_VGA_Red_1,
        o_VGA_Red_2,
        o_VGA_Grn_0,
        o_VGA_Grn_1,
        o_VGA_Grn_2,
        o_VGA_Blu_0,
        o_VGA_Blu_1,
        o_VGA_Blu_2,

        Segment1_A,
        Segment1_B,
        Segment1_C,
        Segment1_D,
        Segment1_E,
        Segment1_F,
        Segment1_G,
        Segment2_A,
        Segment2_B,
        Segment2_C,
        Segment2_D,
        Segment2_E,
        Segment2_F,
        Segment2_G,
        LED_1,
        LED_2,
        LED_3,
        LED_4,
        tb_row,
        tb_column,
        tb_pixel);
    
    always @(posedge i_Clk) begin
        cycle_count <= cycle_count + 1;
        if (cycle_count > 810*64) begin
            $fclose(fd);
            $finish;
        end
        if (tb_row < 256 && tb_column >= 16 && tb_column < 16+256) begin
            pixel_shift_reg <= { pixel_shift_reg[29:0], tb_pixel };
            pixel_sr_count <= pixel_sr_count + 1;
            if (pixel_sr_count == 31) begin
                $fdisplayh(fd, pixel_shift_reg);
            end
        end
    end
endmodule
