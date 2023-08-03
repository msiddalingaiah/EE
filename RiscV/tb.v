
`define MEM_SIZE 1024

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

module CPU32 (input wire reset, input wire clock,
    output wire [31:0] pmAddress, output reg [3:0] pmWidth,
    output reg pmWrite,
    output reg [31:0] pmDataOut, input wire [31:0] pmDataIn,
    output wire [31:0] dmAddress, output reg [3:0] dmWidth,
    output reg dmWrite,
    output reg [31:0] dmDataOut, input wire [31:0] dmDataIn);

    reg [31:0] pc;
    reg [31:0] rx[0:31];
    assign pmAddress = pc;
    wire [6:0] opcode = pmDataIn[6:0];
    wire [4:0] rd = pmDataIn[11:7];
    wire [2:0] funct3 = pmDataIn[14:12];
    wire [4:0] rs1 = pmDataIn[19:15];
    wire [4:0] rs2 = pmDataIn[24:20];
    wire [19:0] imm20 = pmDataIn[31:12];
    wire [31:0] imm12 = { {20{pmDataIn[31]}}, pmDataIn[31:20] };
    wire [6:0] imm7 = pmDataIn[31:25];
    wire [31:0] jal_offset = { pmDataIn[31] ? 11'h7ff : 11'h0, pmDataIn[31], pmDataIn[19:12], pmDataIn[20], pmDataIn[30:21], 1'b0 };

    always @(posedge clock, posedge reset) begin
        if (reset == 1) begin
            pc <= 0;
            pmWidth <= 4;
            pmWrite <= 0;
            dmWidth <= 4;
            dmWrite <= 0;
            rx[0] <= 0;
            rx[2] <= 0;
            rx[8] <= 0;
            rx[15] <= 0;
        end else begin
            $write("    0: %x %x %x %x %x %x %x %x\n", rx[0], rx[1], rx[3], rx[3], rx[4], rx[5], rx[6], rx[7]);
            $write("    8: %x %x %x %x %x %x %x %x\n", rx[8], rx[9], rx[10], rx[11], rx[12], rx[13], rx[14], rx[15]);
            $write("   16: %x %x %x %x %x %x %x %x\n", rx[16], rx[17], rx[18], rx[19], rx[20], rx[21], rx[22], rx[23]);
            $write("   24: %x %x %x %x %x %x %x %x\n", rx[24], rx[25], rx[26], rx[27], rx[28], rx[29], rx[30], rx[31]);
            pc <= pc + 4;
            case (opcode)
                7'h3: case (funct3)
                    2: begin    // lw
                        rx[rd] <= rx[rs1] + imm12;
                        $write("%x: lw r%d, offset(rs%d)\n", pc-4, rd, rs1);
                    end
                endcase
                7'h13: case (funct3)
                    0: begin    // addi
                        rx[rd] <= rx[rs1] + imm12;
                        $write("%x: addi r%d, rs%d, %d\n", pc-4, rd, rs1, imm12);
                    end
                endcase
                7'h23: case (funct3)
                    2: begin    // sw
                        $write("%x: sw rs%d, offset(rs%d)\n", pc-4, rs2, rs1);
                    end
                endcase
                7'h6f: begin    // jal
                    pc <= pc + jal_offset;
                    $write("%x: jal %x\n", pc-4, pc + jal_offset);
                end
                default:
                    $write("%x: %x, funct3: %x, opcode: %x, rd: %x, rs1: %x, imm12: %d\n", pc-4, pmDataIn, funct3, opcode, rd, rs1, imm12);
            endcase
        end
    end
endmodule

`timescale 1ns / 1ns
module tb;
    reg clock;
    reg reset;
    wire [31:0] pmAddress;
    wire [3:0] pmWidth;
    wire pmWrite;
    wire [31:0] pmDataCOut;
    wire [31:0] pmDataCIn;
    wire [31:0] dmAddress;
    wire [3:0] dmWidth;
    wire dmWrite;
    wire [31:0] dmDataCOut;
    wire [31:0] dmDataCIn;

    Memory pMemory (clock, pmAddress, pmWidth, pmWrite, pmDataCOut, pmDataCIn);
    Memory dMemory (clock, dmAddress, dmWidth, dmWrite, dmDataCOut, dmDataCIn);
    CPU32 cpu(reset, clock, pmAddress, pmWidth, pmWrite, pmDataCOut, pmDataCIn,
        dmAddress, dmWidth, dmWrite, dmDataCOut, dmDataCIn);

    reg [7:0] temp[0:`MEM_SIZE];

    initial begin
        clock = 0;
        forever #50 clock = ~clock;
    end
    integer i;
    initial begin
        $dumpfile("vcd/tb.vcd");
        $dumpvars(0, cpu);

        $write("Begin...\n");
        $readmemh("main.hex", temp);
        for (i=0; i<`MEM_SIZE; i=i+4) begin
            pMemory.cells0[i>>2] = temp[i+0];
            pMemory.cells1[i>>2] = temp[i+1];
            pMemory.cells2[i>>2] = temp[i+2];
            pMemory.cells3[i>>2] = temp[i+3];
        end

        #0 reset=0; #25 reset=1; #100; reset=0;

        #2000;
        $write("All done!\n");
        $finish;
    end
endmodule
