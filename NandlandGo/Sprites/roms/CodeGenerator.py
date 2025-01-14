
OPS_NOP = 0x00

OPS_LOAD_MEM = 0x01
OPS_LOAD_SWAP = 0x02

OPS_STORE_MEM = 0x10
OPS_STORE_PRINT = 0x11

OPS_ALU_ADD = 0x20
OPS_ALU_SUB = 0x21
OPS_ALU_AND = 0x22
OPS_ALU_OR = 0x23
OPS_ALU_XOR = 0x24
OPS_ALU_SL = 0x25
OPS_ALU_LSR = 0x26
OPS_ALU_ASR = 0x27
OPS_ALU_LT = 0x28

OPS_JUMP = 0x30
OPS_JUMP_ZERO = 0x31
OPS_JUMP_NOT_ZERO = 0x32

OP_SP_SIZE_MAP = { OPS_STORE_MEM: -2, OPS_STORE_PRINT: -1, OPS_JUMP: -1, OPS_JUMP_ZERO: -2, OPS_JUMP_NOT_ZERO: -2,
    OPS_ALU_ADD: -1, OPS_ALU_SUB: -1, OPS_ALU_AND: -1, OPS_ALU_OR: -1, OPS_ALU_XOR: -1, }

class OpCode(object):
    def __init__(self, code, comment, offset=0):
        self.code = code
        self.comment = comment
        self.offset = offset
        self.lineNumber = 0

    def getSP(self):
        if self.code & 0x80:
            return 1
        return OP_SP_SIZE_MAP.get(self.code, 0)

    def __str__(self):
        return f"{self.code:02x} // {self.comment}"

class CodeGenerator(object):
    def __init__(self, tree):
        self.tree = tree
        self.procedureTrees = {}
        self.constants = {}
        self.variable_address = 0
        self.variables = {}
        for t in tree.children:
            if t.value == 'const':
                name = t[0].value.value
                self.constants[name] = self.eval(t[1])
            if t.value == 'ioport':
                name = t[0].value.value
                self.variables[name] = self.eval(t[1])
            if t.value == 'var':
                for i in range(len(t)):
                    name = t[i].value.value
                    self.variables[name] = self.variable_address
                    self.variable_address += 1
            if t.value == 'def':
                name = t[0].value.value
                self.procedureTrees[name] = t[1]
        main = self.procedureTrees["main"]
        self.opcodes = []
        # Reset location must contain a NOP!
        self.opcodes.append(OpCode(OPS_NOP, 'No operation'))
        self.opcodes.append(OpCode(OPS_NOP, 'No operation'))
        self.opcodes.extend(self.genStatList(main))

    def eval(self, tree):
        if tree.value.name == 'INT':
            return tree.value.value
        if tree.value.name == 'ID':
            name = tree.value.value
            if name not in self.constants:
                raise Exception(f"line {tree.value.lineNumber}, No such constant '{name}'")
            return self.constants[name]
        op = tree.value.name
        a = self.eval(tree.children[0])
        if op == 'NEG':
            return -a
        b = self.eval(tree.children[1])
        if op == '+':
            return a + b
        if op == '-':
            return a - b
        if op == '*':
            return a * b
        if op == '/':
            return a / b
        raise Exception(f"line {tree.value.lineNumber}, Unknown operator '{op}'")

    def genStatList(self, tree):
        opcodes = []
        for stat in tree:
            s0_name = stat.value.name
            if s0_name == 'call':
                func = stat[0].value.value
                raise Exception(f"line {func.value.lineNumber}, call {func} does not exist")
            elif s0_name == 'print':
                opcodes.extend(self.genEval(stat[0]))
                opcodes.append(OpCode(OPS_STORE_PRINT, 'print'))
                opcodes[-1].lineNumber = tree.value.lineNumber
            elif s0_name == 'while':
                opcodes.extend(self.genWhile(stat))
            elif s0_name == 'loop':
                opcodes.extend(self.genLoop(stat))
            elif s0_name == 'if':
                opcodes.extend(self.genIf(stat))
            elif s0_name == '=':
                var_name = stat[0].value.value
                if var_name not in self.variables:
                    raise Exception(f"line {stat[1].value.lineNumber}, undefined variable {var_name}")
                opcodes.extend(self.genEval(stat[1]))
                opcodes.extend(self.genLoadImm(self.variables[var_name]))
                opcodes.append(OpCode(OPS_STORE_MEM, 'Store'))
                opcodes[-1].lineNumber = stat[1].value.lineNumber
            elif s0_name == 'pass':
                pass
            else:
                raise Exception(f'{s0_name} not yet supported')
        return opcodes

    def genWhile(self, stat):
        exp_ops = self.genEval(stat[0])
        stat_ops = self.genStatList(stat[1])
        short = True
        jump_len = 2
        offset = len(stat_ops)
        if offset+3 > 60:
            short = False
            jump_len = 3
        exp_ops.extend(self.genLoadImm(offset+jump_len, short))
        exp_ops.append(OpCode(OPS_JUMP_ZERO, 'Jump if zero', offset=offset+jump_len))
        exp_ops[-1].lineNumber = stat.value.lineNumber
        offset = -(len(exp_ops)+len(stat_ops)+jump_len)
        stat_ops.extend(self.genLoadImm(offset, short))
        stat_ops.append(OpCode(OPS_JUMP, f'Jump', offset=offset))
        stat_ops[-1].lineNumber = stat.value.lineNumber
        exp_ops.extend(stat_ops)
        return exp_ops

    def genLoop(self, stat):
        stat_ops = self.genStatList(stat[0])
        short = True
        jump_len = 2
        offset = len(stat_ops)
        if offset+3 > 60:
            short = False
            jump_len = 3
        offset = -(len(stat_ops)+jump_len)
        stat_ops.extend(self.genLoadImm(offset, short))
        stat_ops.append(OpCode(OPS_JUMP, 'Jump', offset=offset))
        stat_ops[-1].lineNumber = stat.value.lineNumber
        return stat_ops

    def genIf(self, stat):
        exp_ops = self.genEval(stat[0])
        stat_ops = self.genStatList(stat[1])
        if len(stat) > 2:
            else_ops = self.genStatList(stat[2])
            offset = len(else_ops)
            stat_ops.extend(self.genLoadImm(offset, offset < 60))
            stat_ops.append(OpCode(OPS_JUMP, 'Jump', offset=offset))
            stat_ops[-1].lineNumber = stat.value.lineNumber
        offset = len(stat_ops)
        exp_ops.extend(self.genLoadImm(offset, offset < 60))
        exp_ops.append(OpCode(OPS_JUMP_ZERO, 'Jump if zero', offset=offset))
        exp_ops[-1].lineNumber = stat.value.lineNumber
        exp_ops.extend(stat_ops)
        if len(stat) > 2:
            exp_ops.extend(else_ops)
        return exp_ops

    def genLoadImm(self, value, short=True):
        display_value = value
        opcodes = []
        negative = value < 0
        opcodes = []
        opcodes.append(value & 0x3f)
        value >>= 6
        if not short:
            opcodes.append(value & 0x3f)
            value >>= 6
        while value != 0 and value != -1:
            opcodes.append(value & 0x3f)
            value >>= 6
        opcodes.reverse()
        opcodes[0] |= 0x80
        if negative:
            opcodes[0] |= 0x40
        opcodes[0] = OpCode(opcodes[0], f'Load immediate, sign extended {display_value}')
        for i in range(1, len(opcodes)):
            opcodes[i] |= 0x40
            opcodes[i] = OpCode(opcodes[i], f'Load immediate, shift left 6 bits {display_value}')
        return opcodes

    def genShift(self, tree, opcodes, op, op_text):
        if tree.children[1].value.name == 'INT':
            n = tree.children[1].value.value
            for i in range(n):
                opcodes.append(OpCode(op, op_text))
            opcodes[-1].lineNumber = tree.value.lineNumber
            return opcodes
        if tree.children[1].value.name == 'ID':
            n = tree.children[1].value.value
            if n not in self.constants:
                raise Exception(f"line {tree.value.lineNumber}, no such constant {n}")
            n = self.constants[n]
            for i in range(n):
                opcodes.append(OpCode(op, op_text))
            opcodes[-1].lineNumber = tree.value.lineNumber
            return opcodes
        raise Exception(f"line {tree.value.lineNumber}, shift amount must be a constant")

    def genEval(self, tree):
        if tree.value.name == 'INT':
            return self.genLoadImm(tree.value.value)
        if tree.value.name == 'ID':
            name = tree.value.value
            if name in self.variables:
                addr = self.variables[name]
                opcodes = self.genLoadImm(addr)
                opcodes.append(OpCode(OPS_LOAD_MEM, f'load mem[0x{addr:x}]'))
                opcodes[-1].lineNumber = tree.value.lineNumber
                return opcodes
            elif name in self.constants:
                return self.genLoadImm(self.constants[name])
            raise Exception(f"line {tree.value.lineNumber}, No such constant '{name}'")
        op = tree.value.name

        if op == '>':
            # reverse operands
            opcodes = self.genEval(tree.children[1])
            opcodes.extend(self.genEval(tree.children[0]))
            opcodes.append(OpCode(OPS_ALU_SUB, 'SUB'))
            opcodes.append(OpCode(OPS_ALU_LT, 'LT'))
            opcodes[-1].lineNumber = tree.value.lineNumber
            return opcodes

        if op == 'NEG':
            if tree.children[0].value.name == 'INT':
                return self.genLoadImm(-tree.children[0].value.value)
            opcodes = self.genEval(tree.children[0])
            opcodes.extend(self.genLoadImm(0))
            opcodes.append(OpCode(OPS_LOAD_SWAP, 'Swap'))
            opcodes.append(OpCode(OPS_ALU_SUB, 'SUB'))
            opcodes[-1].lineNumber = tree.value.lineNumber
            return opcodes
        opcodes = self.genEval(tree.children[0])
        if op == '>>':
            return self.genShift(tree, opcodes, OPS_ALU_ASR, 'Arithmetic shift right')
        if op == '>>>':
            return self.genShift(tree, opcodes, OPS_ALU_LSR, 'Logical shift right')
        if op == '<<':
            return self.genShift(tree, opcodes, OPS_ALU_SL, 'Shift left')

        opcodes.extend(self.genEval(tree.children[1]))
        if op == '+':
            opcodes.append(OpCode(OPS_ALU_ADD, 'ADD'))
            opcodes[-1].lineNumber = tree.value.lineNumber
            return opcodes
        if op == '-':
            opcodes.append(OpCode(OPS_ALU_SUB, 'SUB'))
            opcodes[-1].lineNumber = tree.value.lineNumber
            return opcodes
        if op == '&' or op == '&&':
            opcodes.append(OpCode(OPS_ALU_AND, 'AND'))
            opcodes[-1].lineNumber = tree.value.lineNumber
            return opcodes
        if op == '|' or op == '||':
            opcodes.append(OpCode(OPS_ALU_OR, 'OR'))
            opcodes[-1].lineNumber = tree.value.lineNumber
            return opcodes
        if op == '!=':
            opcodes.append(OpCode(OPS_ALU_SUB, 'SUB'))
            opcodes[-1].lineNumber = tree.value.lineNumber
            return opcodes
        if op == '<':
            opcodes.append(OpCode(OPS_ALU_SUB, 'SUB'))
            opcodes.append(OpCode(OPS_ALU_LT, 'LT'))
            opcodes[-1].lineNumber = tree.value.lineNumber
            return opcodes
        raise Exception(f"line {tree.value.lineNumber}, Unknown operator '{op}'")

    def write(self, fname):
        code_limit = 512
        print(f'Code size {len(self.opcodes)} bytes, {100.0*len(self.opcodes)/code_limit:.1f}% utilization')
        assert len(self.opcodes) < code_limit, f"Code size exceeds limit of {code_limit} bytes by {len(self.opcodes)-code_limit}"
        stack_size = 0
        max_stack = 0
        pc = 0
        loop_sizes = []
        with open(fname, "wt") as f:
            for op in self.opcodes:
                stack_size += op.getSP()
                op_line = ''
                if op.lineNumber != 0:
                    op_line = f'line {op.lineNumber}'
                if op.offset != 0:
                    target_pc = pc+op.offset+1
                    if op.offset < 0:
                        loop_sizes.append([pc, -op.offset])
                    f.write(f"{op.code:02x} // {pc:4d}: SP: {stack_size:1d}, {op.comment} {target_pc}, {op_line}\n")
                else:
                    f.write(f"{op.code:02x} // {pc:4d}: SP: {stack_size:1d}, {op.comment}, {op_line}\n")
                if stack_size > max_stack:
                    max_stack = stack_size
                assert stack_size < 4, "Stack overflow"
                assert stack_size >= 0, "Stack underflow"
                pc += 1
            for i in range(512-len(self.opcodes)):
                f.write("00\n")
        print(f'Max stack size: {max_stack}')
        if len(loop_sizes):
            print(f"{len(loop_sizes)} loops detected:")
            for ls in sorted(loop_sizes, key=lambda x: x[1]):
                print(f'    {ls[0]}: {ls[1]} operations, {ls[1]/25.0:.2f} microseconds')
        else:
            print("No loops detected.")
