
`define MEM_SIZE 1024

module Memory(input wire clock, input wire [9:0] address, input[3:0] width, input wire write_en, input wire [31:0] data_in,
    output reg [31:0] data_out);

    parameter ADDRESS_MASK = 17'h7f;
    parameter MEM_SIZE_W = `MEM_SIZE >> 2;

    reg [7:0] cells0[0:MEM_SIZE_W-1];
    reg [7:0] cells1[0:MEM_SIZE_W-1];
    reg [7:0] cells2[0:MEM_SIZE_W-1];
    reg [7:0] cells3[0:MEM_SIZE_W-1];
    wire [7:0] address_w = address[9:2];
    wire [2:0] two_bits = address[1:0];

    integer i;
    initial begin
        for (i=0; i<MEM_SIZE_W; i=i+1) begin
            cells0[i] = 0;
            cells1[i] = 0;
            cells2[i] = 0;
            cells3[i] = 0;
        end
        data_out = 0;
    end

    always @(*) begin
    end

    always @(posedge clock) begin
        data_out <= 0;
        case (width)
            1: begin
                case (two_bits)
                    0: data_out <= { 24'h0, cells0[address_w] };
                    1: data_out <= { 24'h0, cells1[address_w] };
                    2: data_out <= { 24'h0, cells2[address_w] };
                    3: data_out <= { 24'h0, cells3[address_w] };
                endcase
            end
            2: begin
                case (two_bits)
                    0: data_out <= { 16'h0, cells1[address_w], cells0[address_w] };
                    2: data_out <= { 16'h0, cells3[address_w], cells2[address_w] };
                endcase
            end
            4: data_out <= { cells3[address_w], cells2[address_w], cells1[address_w], cells0[address_w] };
        endcase
        if (write_en == 1) begin
            case (width)
                1: begin
                    case (two_bits)
                        0: cells0[address_w] <= data_in[7:0];
                        1: cells1[address_w] <= data_in[7:0];
                        2: cells2[address_w] <= data_in[7:0];
                        3: cells3[address_w] <= data_in[7:0];
                    endcase
                end
                2: begin
                    case (two_bits)
                        0: { cells1[address_w], cells0[address_w] } <= data_in[15:0];
                        2: { cells3[address_w], cells3[address_w] } <= data_in[15:0];
                    endcase
                end
                4: { cells3[address_w], cells2[address_w], cells1[address_w], cells0[address_w] } <= data_in;
            endcase
        end
    end
endmodule

`timescale 1ns / 1ns
module tb;
    reg clock;
    reg reset;
    reg [9:0] address;
    reg [3:0] width;
    reg write_en;
    reg [31:0] data_in;
    wire [31:0] data_out;

    Memory uut (clock, address, width, write_en, data_in, data_out);
    reg [7:0] temp[0:`MEM_SIZE];

    initial begin
        clock = 0;
        forever #50 clock = ~clock;
    end
    integer i;
    initial begin
        $dumpfile("vcd/tb.vcd");
        $dumpvars(0, uut);

        $write("Begin...\n");
        $readmemh("hello.hex", temp);
        for (i=0; i<`MEM_SIZE; i=i+4) begin
            uut.cells0[i>>2] = temp[i+0];
            uut.cells1[i>>2] = temp[i+1];
            uut.cells2[i>>2] = temp[i+2];
            uut.cells3[i>>2] = temp[i+3];
        end
        address = 0;
        write_en = 0;
        width = 4;
        data_in = 32'h12345678;

        #0 reset=0; #25 reset=1; #100; reset=0;

        #2000;
        $write("All done!\n");
        $finish;
    end

    always @(posedge clock) begin
        $write("%d: %x\n", address-4, data_out);
        address <= address + 4;
    end
endmodule
