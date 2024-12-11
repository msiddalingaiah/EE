
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


module I8CPU(input wire reset, input wire clock);
    integer i;
    initial begin
        pc = 0;
        cSP = 3;
        dSP = 3;
        codeAddress = 0;
        for (i=0;i<4;i=i+1) cStack[i] = 0;
        for (i=0;i<4;i=i+1) dStack[i] = 0;
        op = 0;
        offset = 0;
    end

    reg [11:0] pc, offset;
    reg [1:0] cSP, cSP1;
    reg [1:0] dSP, dSP1, dSPm1;
    reg [11:0] codeAddress;
    reg [11:0] cStack[0:3];
    reg [15:0] dStack[0:3];
    wire [7:0] opcode;
    reg [1:0] op;
    wire [3:0] op_fam = opcode[7:4];
    wire [3:0] op_op = opcode[3:0];
    wire [7:0] S0 = dStack[dSP];
    wire [7:0] S1 = dStack[dSPm1];

    localparam OPS_LOAD  = 4'b0000;
    localparam OPS_STORE = 4'b0001;
    localparam OPS_ALU   = 4'b0010;
    localparam OPS_JUMP  = 4'b0011;
    localparam OPS_SYS   = 4'b0100;

    localparam OPS_ALU_ADD   = 4'b0000;
    localparam OPS_ALU_SUB   = 4'b0001;

    localparam OPS_SYS_HALT   = 4'b0100;
    localparam OPS_SYS_PRINT   = 4'b0001;

    CodeROM rom(clock, codeAddress, opcode);

    // Guideline #3: When modeling combinational logic with an "always" 
    //              block, use blocking assignments.
    always @(*) begin        
        cSP1 = cSP + 1'b1;
        case (op)
            0: codeAddress = pc;  // next
            1: begin codeAddress = pc+offset; end // jump
            2: begin codeAddress = pc+offset; end // call
            3: codeAddress = cStack[cSP1]; // return
        endcase

        dSP1 = dSP + 1'b1;
        dSPm1 = dSP - 1'b1;
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
                0: ;  // next
                1: ;  // jump
                2: begin cStack[cSP1] <= pc; cSP <= cSP + 1'b1; end // call
                3: cSP <= cSP - 1; // return
            endcase
            pc <= codeAddress + 1;

            if (opcode[7] == 1'b1) begin dStack[dSP1] <= { {9{opcode[6]}}, opcode[6:0] }; dSP <= dSP1; end
            if (op_fam == OPS_ALU) begin
                if (op_op == OPS_ALU_ADD) begin dStack[dSPm1] <= S1 + S0; dSP <= dSPm1; end
                if (op_op == OPS_ALU_SUB) begin dStack[dSPm1] <= S1 - S0; dSP <= dSPm1; end
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
