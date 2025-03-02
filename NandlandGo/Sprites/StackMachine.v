
/*
 * Copyright (c) 2025 Madhu Siddalingaiah
 * See https://github.com/msiddalingaiah/EE/blob/main/LICENSE
 */

module CodeROM(input wire clock, input wire [11:0] rd_address, output reg [7:0] rd_data);
    reg [7:0] memory[0:511];
    integer i;
    initial begin
        $readmemh("roms/code.txt", memory);
    end

    always @(posedge clock) begin
        rd_data <= memory[rd_address[8:0]];
    end
endmodule

module CPURAM(input wire clock, input wire [11:0] address, output reg [`CPU_WIDTHm1:0] rd_data, input wire write,
    input wire [`CPU_WIDTHm1:0] wr_data);

    reg [`CPU_WIDTHm1:0] memory[0:255];
    integer i;
    initial begin
        for (i=0; i<256; i=i+1) begin
            memory[i] = 0;
        end
    end

    always @(posedge clock) begin
        rd_data <= memory[address[7:0]];
        if (write == 1'b1) memory[address[7:0]] <= wr_data;
    end
endmodule

module Stack(input wire reset, input wire clock, input wire push, input wire [`CPU_WIDTHm1:0] push_data,
    input wire[7:0] pop_num, output reg [`CPU_WIDTHm1:0] top);

    reg read_shadow;
    reg [7:0] sp;
    reg [`CPU_WIDTHm1:0] shadow, rd_data;
    reg [`CPU_WIDTHm1:0] memory[0:255];

    integer i;
    initial begin
        for (i=0; i<256; i=i+1) begin
            memory[i] = 0;
        end
        sp = 8'hff;
        read_shadow = 1'b0;
        shadow = 0;
        rd_data = 0;
    end

    always @(*) begin
        top = rd_data;
        if (read_shadow) top = shadow;
    end

    always @(posedge clock) begin
        read_shadow = 1'b0;
        rd_data <= memory[sp + {7'b0, push} - pop_num];
        if (push) begin
            memory[sp + {7'b0, push} - pop_num] <= push_data;
            shadow <= push_data;
            read_shadow = 1'b1;
        end
        sp <= sp + {7'b0, push} - pop_num;
        if (reset) begin
            sp <= 8'hff;
            read_shadow <= 0;
            shadow <= 0;
            rd_data <= 0;
        end
    end
endmodule

module StackMachine(input wire reset, input wire clock, output reg [`CPU_WIDTHm1:0] io_addr, input wire [`CPU_WIDTHm1:0] io_rd_data,
    output reg io_write, output reg [`CPU_WIDTHm1:0] io_wr_data, output wire [7:0] cpu_op);

    reg [11:0] pc;
    reg [1:0] cSP, cSP1;
    reg [11:0] codeAddress;
    reg [11:0] cStack[0:3];
    wire [7:0] opcode;
    reg [1:0] op;
    reg [3:0] op_fam, op_op;
    wire [`CPU_WIDTHm1:0] ram_rd_data;
    reg ram_write;
    reg decode_ram_io;
    reg [11:0] ram_address;

    reg [`CPU_WIDTHm1:0] S0, result;
    wire [`CPU_WIDTHm1:0] S1;
    reg [7:0] pop_num;
    reg push;


    assign cpu_op = opcode;

    integer i;
    initial begin
        pc = 0;
        cSP = 3;
        for (i=0;i<4;i=i+1) cStack[i] = 0;
        S0 = 0;
    end

    localparam OPS_LOAD  = 4'b0000;
    localparam OPS_STORE = 4'b0001;
    localparam OPS_ALU   = 4'b0010;
    localparam OPS_JUMP  = 4'b0011;

    localparam OPS_LOAD_MEM = 4'b0001;
    localparam OPS_LOAD_SWAP = 4'b0010;

    localparam OPS_STORE_MEM = 4'b0000;
    localparam OPS_STORE_PRINT = 4'b0001;

    localparam OPS_ALU_ADD   = 4'b0000;
    localparam OPS_ALU_SUB   = 4'b0001;
    localparam OPS_ALU_AND   = 4'b0010;
    localparam OPS_ALU_OR    = 4'b0011;
    localparam OPS_ALU_XOR   = 4'b0100;
    localparam OPS_ALU_SL    = 4'b0101;
    localparam OPS_ALU_LSR   = 4'b0110;
    localparam OPS_ALU_ASR   = 4'b0111;
    localparam OPS_ALU_LT    = 4'b1000;

    localparam OPS_JUMP_JUMP = 4'b0000;
    localparam OPS_JUMP_ZERO = 4'b0001;
    localparam OPS_JUMP_NOT_ZERO = 4'b0010;


    CodeROM rom(clock, codeAddress, opcode);
    CPURAM ram(clock, ram_address, ram_rd_data, ram_write, S1);
    Stack dstack(reset, clock, push, S0, pop_num, S1);

    // Guideline #3: When modeling combinational logic with an "always" 
    //              block, use blocking assignments.
    always @(*) begin
        op_fam = opcode[7:4];
        op_op = opcode[3:0];

        decode_ram_io = S0[`CPU_WIDTHm1:`CPU_WIDTHm1-1] == 2'h0 ? 1'b0 : 1'b1;

        io_wr_data = S1;
        io_addr = S0;
        io_write = 1'b0;
        ram_write = 1'b0;
        if (op_fam == OPS_STORE) begin
            if (op_op == OPS_STORE_MEM) begin
                if (decode_ram_io == 1'b0) ram_write = 1'b1;
                else io_write = 1'b1;
            end
        end

        op = 2'd0;
        if (op_fam == OPS_JUMP) begin
            case (op_op)
                OPS_JUMP_JUMP: op = 2'd1;
                OPS_JUMP_ZERO: if (S1 == {`CPU_WIDTH{1'b0}}) op = 2'd1;
                OPS_JUMP_NOT_ZERO: if (S1 != {`CPU_WIDTH{1'b0}}) op = 2'd1;
            endcase
        end

        cSP1 = cSP + 1'b1;
        codeAddress = pc;
        case (op)
            2'd0: codeAddress = pc;  // next
            2'd1: begin codeAddress = pc+S0[11:0]; end // jump
            2'd2: begin codeAddress = pc+S0[11:0]; end // call
            2'd3: codeAddress = cStack[cSP1]; // return
        endcase

        push = 1'b0;
        pop_num = 7'h0;
        result = {`CPU_WIDTH{1'b0}};
        if (opcode[7] == 1'b1) begin result = { {9{opcode[6]}}, opcode[6:0] }; push = 1'b1; end
        if (opcode[7:6] == 2'b01) begin result = { S0[`CPU_WIDTHm1-6:0], opcode[5:0] }; end
        if (op_fam == OPS_ALU) begin
            if (op_op == OPS_ALU_ADD) begin result = S1 + S0; pop_num = 8'd1; end
            if (op_op == OPS_ALU_SUB) begin result = S1 - S0; pop_num = 8'd1; end
            if (op_op == OPS_ALU_AND) begin result = S1 & S0; pop_num = 8'd1; end
            if (op_op == OPS_ALU_OR)  begin result = S1 | S0; pop_num = 8'd1; end
            if (op_op == OPS_ALU_XOR) begin result = S1 ^ S0; pop_num = 8'd1; end
            if (op_op == OPS_ALU_SL)  begin result = { S0[`CPU_WIDTH-2:0], 1'b0 }; end
            if (op_op == OPS_ALU_LSR) begin result = { 1'b0, S0[`CPU_WIDTHm1:1] }; end
            if (op_op == OPS_ALU_ASR) begin result = { S0[`CPU_WIDTHm1], S0[`CPU_WIDTHm1:1] }; end
            if (op_op == OPS_ALU_LT) begin result = { {`CPU_WIDTH-1{1'b0}}, S0[`CPU_WIDTH-1] }; end
        end

        if (op_fam == OPS_LOAD) begin
            if (op_op == OPS_LOAD_SWAP) begin
                push = 1'b1;
                pop_num = 8'd1;
            end
        end
        if (op_fam == OPS_STORE) begin
            if (op_op == OPS_STORE_MEM) begin
                pop_num = 8'd2;
            end
            if (op_op == OPS_STORE_PRINT) begin
                pop_num = 8'd1;
            end
        end
        if (op_fam == OPS_JUMP) begin
            case (op_op)
                OPS_JUMP_JUMP: pop_num = 8'd1;
                OPS_JUMP_ZERO: pop_num = 8'd2;
                OPS_JUMP_NOT_ZERO: pop_num = 8'd2;
            endcase
        end

        // Address forwarding to account for RAM pipelining
        ram_address = ram_write ? S0[11:0] : result;
    end

    // Guideline #1: When modeling sequential logic, use nonblocking 
    //              assignments.
    always @(posedge clock) begin
        case (op)
            2'd0: ;  // next
            2'd1: ;  // jump
            2'd2: begin cStack[cSP1] <= pc; cSP <= cSP + 1'b1; end // call
            2'd3: cSP <= cSP - 1; // return
        endcase
        pc <= codeAddress + 1;

        if (opcode[7] == 1'b1) begin S0 <= result; end
        if (opcode[7:6] == 2'b01) begin S0 <= result; end
        if (op_fam == OPS_ALU) begin
            if (op_op == OPS_ALU_ADD) begin S0 <= result; end
            if (op_op == OPS_ALU_SUB) begin S0 <= result; end
            if (op_op == OPS_ALU_AND) begin S0 <= result; end
            if (op_op == OPS_ALU_OR)  begin S0 <= result; end
            if (op_op == OPS_ALU_XOR) begin S0 <= result; end
            if (op_op == OPS_ALU_SL)  begin S0 <= result; end
            if (op_op == OPS_ALU_LSR) begin S0 <= result; end
            if (op_op == OPS_ALU_ASR) begin S0 <= result; end
            if (op_op == OPS_ALU_LT) begin S0 <= result; end
        end
        if (op_fam == OPS_LOAD) begin
            if (op_op == OPS_LOAD_MEM) begin
                if (decode_ram_io == 1'b0) S0 <= ram_rd_data;
                else S0 <= io_rd_data;
            end
            if (op_op == OPS_LOAD_SWAP) begin
                S0 <= S1;
            end
        end
        if (op_fam == OPS_STORE) begin
            if (op_op == OPS_STORE_PRINT) begin
`ifdef TESTBENCH
                $display("%d, %d", S1, S0);
`endif
            end
        end

        // https://blog.award-winning.me/2017/11/resetting-reset-handling.html
        // Synchronous reset saves routing resources
		if (reset == 1'b1) begin
            pc <= 0;
            cSP <= 3;
            S0 <= 0;
		end 
    end
endmodule
