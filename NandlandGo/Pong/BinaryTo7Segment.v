
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
