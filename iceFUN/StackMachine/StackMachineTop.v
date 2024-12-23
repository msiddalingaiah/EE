
`define CPU_WIDTH 12
`define CPU_WIDTHm1 (`CPU_WIDTH-1)

`include "StackMachine.v"

module StackMachineTop(clock, led1, led2, led3, led4, led5, led6, led7, led8, lcol1, lcol2, lcol3, lcol4);
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

    reg reset, reset_inhibit;
    reg [19:0] counter;
    reg [7:0] led_row;
    reg [3:0] led_column;

    wire [`CPU_WIDTHm1:0] cpu_addr, cpu_wr_data;
    reg [`CPU_WIDTHm1:0] cpu_rd_data;
    wire [7:0] cpu_op;
    reg cpu_decode_io;
    wire cpu_write;
    reg slow_int;

    assign {led8, led7, led6, led5, led4, led3, led2, led1} = ~led_row;
    assign {lcol4, lcol3, lcol2, lcol1} = ~led_column;

    initial begin
        reset = 1'b0;
        reset_inhibit = 1'b0;
        counter = 20'b0;
    end

    StackMachine cpu(reset, clock, cpu_addr, cpu_rd_data, cpu_write, cpu_wr_data, cpu_op);

    always @(*) begin
        cpu_decode_io = cpu_addr[`CPU_WIDTHm1:`CPU_WIDTHm1-1] != 2'h0 ? 1'b1 : 1'b0;

        cpu_rd_data = {`CPU_WIDTH{1'b0}};
        if (cpu_decode_io) begin
            case (cpu_addr[`CPU_WIDTHm1:`CPU_WIDTHm1-1])
                2'h1: begin
                end
                2'h2: begin
                end
                2'h3: begin
                    if (cpu_addr[1:0] == 2'h0) cpu_rd_data = { {`CPU_WIDTH-8{1'b0}}, led_row };
                    if (cpu_addr[1:0] == 2'h1) cpu_rd_data = { {`CPU_WIDTH-4{1'b0}}, led_column };
                    if (cpu_addr[1:0] == 2'h3) cpu_rd_data = { {`CPU_WIDTH-1{1'b0}}, slow_int };
                end
            endcase
        end
    end

    always @(posedge clock) begin
`ifdef TESTBENCH
        // Short reset is enough for simulation
        reset <= 0;
`endif
        if (~reset & ~reset_inhibit) begin reset <= 1'b1; reset_inhibit <= 1'b1; end
        if (counter[18]) reset <= 1'b0;
        counter <= counter + 1;
        if (counter == 0) slow_int <= 1'b1;

        if (cpu_write & cpu_decode_io) begin
            case (cpu_addr[`CPU_WIDTHm1:`CPU_WIDTHm1-1])
                2'h1: begin
                end
                2'h2: begin
                end
                2'h3: begin
                    if (cpu_addr[1:0] == 2'h0) led_row <= cpu_wr_data[7:0];
                    if (cpu_addr[1:0] == 2'h1) led_column <= cpu_wr_data[3:0];
                    if (cpu_addr[1:0] == 2'h3) slow_int <= cpu_wr_data[0];
                end
            endcase
        end
    end
endmodule