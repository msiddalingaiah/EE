
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
    reg [2:0] red, green, blue;
    reg [8:0] color;
    reg draw;

    reg [9:0] ball_x, ball_y, dx, dy;

    initial begin
        row = 0;
        column = 0;
        color = 9'b111111000;
        ball_x = 43;
        ball_y = 71;
        dx = 1;
        dy = 1;
        draw = 0;
    end

    localparam H_ACTIVE = 640;
    localparam H_FPORCH = 16;
    localparam H_PULSE = 96;
    localparam H_MAX = 800;

    localparam V_ACTIVE = 480;
    localparam V_FPORCH = 10;
    localparam V_PULSE = 2;
    localparam V_MAX = 525;
    
    // See https://vanhunteradams.com/DE1/VGA_Driver/Driver.html
    assign o_VGA_HSync = (column < H_ACTIVE+H_FPORCH || column >= H_ACTIVE+H_FPORCH+H_PULSE) ? 1 : 0;
    assign o_VGA_VSync = (row < V_ACTIVE+V_FPORCH || row >= V_ACTIVE+V_FPORCH+V_PULSE) ? 1 : 0;
    assign { o_VGA_Red_2, o_VGA_Red_1, o_VGA_Red_0 } = (column < H_ACTIVE && row < V_ACTIVE) ? red : 0;
    assign { o_VGA_Grn_2, o_VGA_Grn_1, o_VGA_Grn_0 } = (column < H_ACTIVE && row < V_ACTIVE) ? green : 0;
    assign { o_VGA_Blu_2, o_VGA_Blu_1, o_VGA_Blu_0  } = (column < H_ACTIVE && row < V_ACTIVE) ? blue : 0;

    assign { red, green, blue } = draw ? color : 0;

    always @(*) begin
        draw = 0;
        if ((ball_y - row) < 5 && (ball_x - column) < 5) begin
            draw = 1;
        end
    end

    always @(posedge i_Clk) begin
        led_count <= led_count + 1;
        if (led_count == 0) begin
            digitCount <= digitCount + 1;
        end

        if (led_count[16:0] == 0) begin
            ball_x <= ball_x + dx;
            ball_y <= ball_y + dy;
            if (ball_x == H_ACTIVE) begin
                ball_x <= H_ACTIVE-1;
                dx <= ~dx + 1;
                color <= 9'b111000000;
            end
            if (ball_x == 0) begin
                ball_x <= 1;
                dx <= ~dx + 1;
                color <= 9'b000111000;
            end
            if (ball_y == V_ACTIVE) begin
                ball_y <= V_ACTIVE-1;
                dy <= ~dy + 1;
                color <= 9'b000000111;
            end
            if (ball_y == 0) begin
                ball_y <= 1;
                dy <= ~dy + 1;
                color <= 9'b000111111;
            end
        end

        column <= column + 1;
        if (column == H_MAX-1) begin
            column <= 0;
            row <= row + 1;
            if (row == V_MAX-1) begin
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
