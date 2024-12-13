
module CodeROM(input wire clock, input wire [11:0] rd_address, output reg [7:0] rd_data);
    reg [7:0] memory[0:511];
    integer i;
    initial begin
        for (i=0; i<512; i=i+1) begin
            memory[i] = 0;
        end
        $readmemh("roms/code.txt", memory);
    end

    always @(posedge clock) begin
        rd_data <= memory[rd_address[8:0]];
    end
endmodule

module StackMachine(input wire reset, input wire clock, output reg write, output reg [15:0] wr_addr, output reg [15:0] wr_data);
    integer i;
    initial begin
        pc = 0;
        cSP = 3;
        dSP = 3;
        codeAddress = 0;
        for (i=0;i<4;i=i+1) cStack[i] = 0;
        for (i=0;i<4;i=i+1) dStack[i] = 0;
        op = 0;
    end

    reg [11:0] pc;
    reg [1:0] cSP, cSP1;
    reg [1:0] dSP, dSP1, dSPm1, dSPm2;
    reg [11:0] codeAddress;
    reg [11:0] cStack[0:3];
    reg [15:0] dStack[0:3];
    wire [7:0] opcode;
    reg [1:0] op;
    reg [3:0] op_fam, op_op;
    reg [15:0] S0, S1;

    localparam OPS_LOAD  = 4'b0000;
    localparam OPS_STORE = 4'b0001;
    localparam OPS_ALU   = 4'b0010;
    localparam OPS_JUMP  = 4'b0011;
    localparam OPS_SYS   = 4'b0100;

    localparam OPS_STORE_MEM = 4'b0010;

    localparam OPS_ALU_ADD   = 4'b0000;
    localparam OPS_ALU_SUB   = 4'b0001;

    localparam OPS_JUMP_JUMP = 4'b0000;
    localparam OPS_JUMP_ZERO = 4'b0001;
    localparam OPS_JUMP_NOT_ZERO = 4'b0010;

    localparam OPS_SYS_HALT   = 4'b0100;
    localparam OPS_SYS_PRINT   = 4'b0001;

    CodeROM rom(clock, codeAddress, opcode);

    // Guideline #3: When modeling combinational logic with an "always" 
    //              block, use blocking assignments.
    always @(*) begin
        op_fam = opcode[7:4];
        op_op = opcode[3:0];

        dSP1 = dSP + 1'b1;
        dSPm1 = dSP - 1'b1;
        dSPm2 = dSP - 2'b10;

        S0 = dStack[dSP];
        S1 = dStack[dSPm1];
        wr_data = S1;
        wr_addr = S0;
        write = 1'b0;
        if (op_fam == OPS_STORE) begin
            if (op_op == OPS_STORE_MEM) begin
                write = 1'b1;
            end
        end

        op = 2'd0;
        if (op_fam == OPS_JUMP) begin
            case (op_op)
                OPS_JUMP_JUMP: op = 2'd1;
                OPS_JUMP_ZERO: if (S1 == 16'd0) op = 2'd1;
                OPS_JUMP_NOT_ZERO: if (S1 != 16'd0) op = 2'd1;
            endcase
        end

        cSP1 = cSP + 1'b1;
        case (op)
            2'd0: codeAddress = pc;  // next
            2'd1: begin codeAddress = pc+S0[11:0]; end // jump
            2'd2: begin codeAddress = pc+S0[11:0]; end // call
            2'd3: codeAddress = cStack[cSP1]; // return
        endcase
    end

    // Guideline #1: When modeling sequential logic, use nonblocking 
    //              assignments.
    always @(posedge clock, posedge reset) begin
		if (reset == 1'b1) begin
            pc <= 0;
            cSP <= 3;
            dSP <= 3;
		end else begin
            case (op)
                2'd0: ;  // next
                2'd1: ;  // jump
                2'd2: begin cStack[cSP1] <= pc; cSP <= cSP + 1'b1; end // call
                2'd3: cSP <= cSP - 1; // return
            endcase
            pc <= codeAddress + 1;

            if (opcode[7] == 1'b1) begin dStack[dSP1] <= { {9{opcode[6]}}, opcode[6:0] }; dSP <= dSP1; end
            if (op_fam == OPS_ALU) begin
                if (op_op == OPS_ALU_ADD) begin dStack[dSPm1] <= S1 + S0; dSP <= dSPm1; end
                if (op_op == OPS_ALU_SUB) begin dStack[dSPm1] <= S1 - S0; dSP <= dSPm1; end
            end
            if (op_fam == OPS_STORE) begin
                if (op_op == OPS_STORE_MEM) begin
                    dSP <= dSPm2;
                end
            end
            if (op_fam == OPS_JUMP) begin
                case (op_op)
                    OPS_JUMP_JUMP: dSP <= dSPm1;
                    OPS_JUMP_ZERO: dSP <= dSPm2;
                    OPS_JUMP_NOT_ZERO: dSP <= dSPm2;
                endcase
            end
            if (op_fam == OPS_SYS) begin
                if (op_op == OPS_SYS_HALT) begin
                end
                if (op_op == OPS_SYS_PRINT) begin
`ifdef TESTBENCH
                    $display("%d, %d", S1, S0);
`endif
                    dSP <= dSPm1;
                end
            end
		end
    end
endmodule
