
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

    // Ball and paddle center positions
    reg [9:0] ball_x, ball_y, ball_dx, ball_dy;
    reg [9:0] paddle_left_y, paddle_right_y;

    reg [1:0] game_state;

    localparam H_ACTIVE = 10'd640;
    localparam H_FPORCH = 10'd16;
    localparam H_PULSE = 10'd96;
    localparam H_MAX = 10'd800;

    localparam V_ACTIVE = 10'd480;
    localparam V_FPORCH = 10'd10;
    localparam V_PULSE = 10'd2;
    localparam V_MAX = 10'd525;

    localparam PADDLE_HEIGHT_2 = 10'd30;
    localparam PADDLE_WIDTH = 10'd10;
    localparam BALL_SIZE_2 = 10'd3;

    localparam IDLE = 2'd0;
    localparam PLAY = 2'd1;

    initial begin
        row = 0;
        column = 0;
        color = 0;
        ball_x <= H_ACTIVE >> 1;
        ball_y <= V_ACTIVE >> 1;

        ball_dx = 1;
        ball_dy = 1;
        paddle_left_y = V_ACTIVE >> 1;
        paddle_right_y = V_ACTIVE >> 1;
        left_digit = 0;
        right_digit = 0;
        game_state = IDLE;
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

    // Combinational logic to generate color for each "pixel", e.g. "Racing the Beam"
    always @(*) begin
        color = 0;
        if ((ball_y - row < BALL_SIZE_2 || row - ball_y < BALL_SIZE_2)
                && (ball_x - column < BALL_SIZE_2 || column - ball_x < BALL_SIZE_2)) begin
            color = 9'b000111000;
        end
        if ((paddle_left_y - row < PADDLE_HEIGHT_2 || row - paddle_left_y < PADDLE_HEIGHT_2)
                && column < PADDLE_WIDTH) begin
            color = 9'b111111000;
        end
        if ((paddle_right_y - row < PADDLE_HEIGHT_2 || row - paddle_right_y < PADDLE_HEIGHT_2)
                && column > H_ACTIVE-PADDLE_WIDTH) begin
            color = 9'b000111111;
        end
    end

    always @(posedge i_Clk) begin
        column <= column + 1;
        if (column == H_MAX-1) begin
            column <= 0;
            row <= row + 1;
            if (row == V_MAX-1) begin
                row <= 0;
            end
        end

        led_count <= led_count + 1;

        // led_count is used for game refresh rate
        if (led_count[16:0] == 0) begin
            if (game_state == IDLE) begin
                ball_x <= H_ACTIVE >> 1;
                ball_y <= V_ACTIVE >> 1;
                if (i_Switch_1) game_state <= PLAY;
            end
            if (game_state == PLAY) begin
                ball_x <= ball_x + ball_dx;
                ball_y <= ball_y + ball_dy;
            end
            if (ball_x == H_ACTIVE) begin
                if (ball_y - paddle_right_y < PADDLE_HEIGHT_2 || paddle_right_y - ball_y < PADDLE_HEIGHT_2) begin
                    ball_x <= H_ACTIVE-1;
                    ball_dx <= ~ball_dx + 1;
                end else begin
                    // Left player wins..
                    left_digit <= left_digit + 1;
                    game_state <= IDLE;
                end
            end
            if (ball_x == 0) begin
                if (ball_y - paddle_left_y < PADDLE_HEIGHT_2 || paddle_left_y - ball_y < PADDLE_HEIGHT_2) begin
                    ball_x <= 1;
                    ball_dx <= ~ball_dx + 1;
                end else begin
                    // Right player wins..
                    right_digit <= right_digit + 1;
                    game_state <= IDLE;
                end
            end
            if (ball_y == V_ACTIVE) begin
                ball_y <= V_ACTIVE-1;
                ball_dy <= ~ball_dy + 1;
            end
            if (ball_y == 0) begin
                ball_y <= 1;
                ball_dy <= ~ball_dy + 1;
            end

            if (i_Switch_1 && paddle_left_y > PADDLE_HEIGHT_2) paddle_left_y <= paddle_left_y - 1;
            if (i_Switch_2 && paddle_left_y < V_ACTIVE-PADDLE_HEIGHT_2) paddle_left_y <= paddle_left_y + 1;
            if (i_Switch_3 && paddle_right_y > PADDLE_HEIGHT_2) paddle_right_y <= paddle_right_y - 1;
            if (i_Switch_4 && paddle_right_y < V_ACTIVE-PADDLE_HEIGHT_2) paddle_right_y <= paddle_right_y + 1;
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
