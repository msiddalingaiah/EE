
'''
assign opcode_type          = rom_data[30:28];
assign opcode_dst_sel       = rom_data[27:24];
assign opcode_op0_sel       = rom_data[23:20];
assign opcode_op1_sel       = rom_data[19:16];
assign opcode_immediate     = rom_data[15:0];

assign opcode_jump_call     = rom_data[24];
assign opcode_jump_src      = rom_data[22:20];
assign opcode_jump_cond     = rom_data[19:16];

// Destination                  Operand0                         Operand1
// -----------------------------------------------------------------------------------------------
// 0    r0                      0   r0                              0   r0              
// 1    r1                      1   r1                              1   r1              
// 2    r2                      2   r2                              2   r2              
// 3    r3                      3   r3                              3   r3              
// 4    A                       4   A                               4   A               
// 5    X                       5   X                               5   X               
// 6    Y                       6   Y                               6   Y               
// 7    PC                      7   PC                              7   PC_Byte_Swapped         
// 8    SP                      8   SP                              8   SP              
// 9    Flags                   9   Flags                           9   Flags           
// A    Address_out             A   Address_out                     A   Address_out      
// B    Data_Out                B   Data_In[7:0] , Data_In[7:0]     B   Data_In[7:0] , Data_In[7:0] 
// C                            C   System_Status                   C   System_Status
// D    System_Output           D   System_Output                   D   System_Output   
// E                            E                                   E                   
// F    Dummy                   F   16'h0000                        F  Opcode_Immediate

'''

DEST = ['r0', 'r1', 'r2', 'r3', 'A', 'X', 'Y', 'PC',    'SP', 'Flags', 'AddrOut', 'DataOut', '',        'SysOut', '', 'Dummy']
OP0 =  ['r0', 'r1', 'r2', 'r3', 'A', 'X', 'Y', 'PC',    'SP', 'Flags', 'AddrOut', 'DataIn',  'SysStat', 'SysOut', '', '0']
OP1 =  ['r0', 'r1', 'r2', 'r3', 'A', 'X', 'Y', 'PC_BS', 'SP', 'Flags', 'AddrOut', 'DataIn',  'SysStat', 'SysOut', '', 'Imm']

OP = ['', '', '+', '&', '|', '^', '>>']
JMP = ['J', 'JNZ', 'JZ']
JMP_SRC = ['', 'DataIn', 'RET']
CALL = ['', 'CALL']

if __name__ == '__main__':
    rom = [0]*2048
    opcode_map = { 0x7d0: 'Reset' }
    with open('Microcode_MCL65.txt') as f:
        line = f.readline()
        while len(line) > 0:
            # @7D0 4DFF_0019
            if line[0] == '@':
                parts = line[1:].split()
                addr = int(parts[0], 16)
                value = (int(parts[1][0:4], 16)<<16) | int(parts[1][5:], 16)
                rom[addr] = value
                if addr < 256:
                    parts = line.split('//')
                    opcode_map[value & 0x7ff] = parts[1].strip()
            line = f.readline()
    
    for addr, value in enumerate(rom):
        if addr in opcode_map:
            print(f'\n// {opcode_map[addr]}\n')
        opcode_type = (value >> 28) & 7
        opcode_dst_sel = (value >> 24) & 0xf
        opcode_op0_sel = (value >> 20) & 0xf
        opcode_op1_sel = (value >> 16) & 0xf
        opcode_immediate = value & 0xffff
        
        opcode_jump_call = (value >> 24) & 1
        opcode_jump_src = (value >> 20) & 0x7
        opcode_jump_cond = (value >> 16) & 0xf

        if opcode_op1_sel == 15:
            OP1[15] = f'0x{opcode_immediate:x}'
        if opcode_type >= 2:
            print(f'{addr:3x}  {DEST[opcode_dst_sel]} = {OP0[opcode_op0_sel]} {OP[opcode_type]} {OP1[opcode_op1_sel]}')
        elif opcode_type == 1:
            call = f'{CALL[opcode_jump_call]}'
            if opcode_jump_src == 0:
                print(f'{addr:3x}  {JMP[opcode_jump_cond]} {call} 0x{opcode_immediate:x}')
            elif opcode_jump_cond < 3 and opcode_jump_src < 3:
                #print(f'opcode_jump_cond: {opcode_jump_cond}, opcode_jump_src: {opcode_jump_src}')
                print(f'{addr:3x}  {JMP[opcode_jump_cond]} {call} {JMP_SRC[opcode_jump_src]}')
            elif opcode_jump_cond == 3 and opcode_jump_src == 3:
                print(f'{addr:3x}  Wait Clock Hi')
            elif opcode_jump_cond == 4 and opcode_jump_src == 3:
                print(f'{addr:3x}  Wait Clock Lo')
            else:
                print(f'{addr:3x}  opcode_jump_cond: {opcode_jump_cond}, opcode_jump_src: {opcode_jump_src}')
