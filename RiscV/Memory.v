
module Memory(input wire clock, input wire [31:0] address, input[3:0] width, input wire write_en, input wire [31:0] data_in,
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
