
import pandas as pd
from collections import defaultdict

'''
Flags:

BRK: B
BIT: N V Z
ADC SBC: N V Z C
AND DEC EOR INC LDA LDX LDY ORA Register: N Z
ASL CMP CPX CPY LSR ROL ROR: N Z C
RTI: all
Flag: as noted
Branch JMP JSR NOP RTS STA STX STY: none
'''

if __name__ == '__main__':
    sheet_id = '1qyLGqIjKDMJsN9bKOeyYNXZg_xGTqNLmVT-KvU2YOd4'
    sheet_name = 'Sheet1'
    url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/gviz/tq?tqx=out:csv&sheet={sheet_name}"
    df = pd.read_csv(url).fillna('')
    #print(df)
    opcodes = {}
    enables = defaultdict(list)
    for index, row in df.iterrows():
        name = row.Mnemonic
        opcode = row.opcode
        opcodes[name] = opcode
        for t in ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8']:
            ena = row[t]
            if len(ena) > 0:
                enables[ena].append(f'({name}&{t.lower()})')
    enable_names = sorted(enables.keys())
    defines = []
    logic_lines = []
    for i, name in enumerate(enable_names):
        defines.append(f'`define {name} {i}')
        logic = ' | '.join(enables[name])
        logic_lines.append(f'\tassign enables[`{name}] = {logic};')
    assign_opcodes = []
    names = sorted(opcodes.keys())
    for name in names:
        value = opcodes[name]
        assign_opcodes.append(f"\tassign {name} = opcode == {value};")

    head = """
/*
 * This module was automatically generated. Do not Edit.
 */
module DecodeLogic (input wire reset, input wire [7:0] timing, input wire [7:0] opcode,
    output wire [63:0] enables);

    assign t1 = timing[0];
    assign t2 = timing[1];
    assign t3 = timing[2];
    assign t4 = timing[3];
    assign t5 = timing[4];
    assign t6 = timing[5];

"""
    tail = """endmodule
"""

    with open('DecodeLogic.v', 'wt') as f:
        f.write('\n')
        for line in defines:
            f.write(line + '\n')
        f.write(head)
        for line in assign_opcodes:
            f.write(line + '\n')
        f.write('\n')
        for line in logic_lines:
            f.write(line + '\n')
        f.write(tail)
