
module CodeROM(input wire [3:0] address, output wire [23:0] data);
    reg [23:0] memory[0:15];
    initial begin
        $readmemh("roms/traffic_rom.txt", memory);
    end

    assign data = memory[address];
endmodule
