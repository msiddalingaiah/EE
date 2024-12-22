

from collections import defaultdict
import re

class Pattern(object):
    def __init__(self, name, regex):
        self.name = name
        self.pattern = re.compile(regex)
        
    def match(self, input, index):
        return self.pattern.match(input, index)
    
class Terminal(object):
    def __init__(self, name, value, lineNumber=0):
        self.name = name
        self.value = value
        self.lineNumber = lineNumber

    def __eq__(self, other):
        return other == self.name

    def __str__(self):
        if self.name.lower() == self.value:
            return self.name
        return '%s(%s)' % (self.name, self.value)
        
class Tree(object):
    def __init__(self, *values):
        self.value = None
        if len(values) > 0:
            self.value = values[0]
        if len(values) > 1:
            self.children = [x for x in values[1:]]
        else:
            self.children = []

    def add(self, value):
        if isinstance(value, Tree):
            self.children.append(value)
        else:
            self.children.append(Tree(value))
        return self
        
    def __len__(self):
        return len(self.children)

    def __getitem__(self, index):
        return self.children[index]

    def isLeaf(self):
        return len(self.children) == 0

    def __str__(self):
        if self.isLeaf():
            return str(self.value)
        result = '(%s' % self.value
        for c in self.children:
            result = '%s %s' % (result, c)
        return '%s)' % result

class Scanner(object):
    def __init__(self, patterns):
        self.patterns = patterns

    def setInput(self, input):
        self.lineNumber = 1
        self.input = input
        self.index = 0
        self.terminal = None
        self.lookAhead = self.next()

    def skipWhiteSpace(self):
        comment = False
        while self.index < len(self.input) and (self.input[self.index].isspace() or self.input[self.index] == '#' or comment):
            if self.input[self.index] == '#':
                comment = True
            if self.input[self.index] == '\n':
                self.lineNumber += 1
                comment = False
            self.index += 1

    def skipComment(self):
        if self.index < len(self.input) and self.input[self.index] == '#':
            while self.index < len(self.input) and self.input[self.index] != '\n':
                self.index += 1
            self.lineNumber += 1
            return True
        return False

    def next(self):
        self.skipWhiteSpace()
        while self.skipComment():
            self.skipWhiteSpace()
        if self.index >= len(self.input):
            return None
        for p in self.patterns:
            match = p.match(self.input, self.index)
            if match:
                self.index = match.end()
                return Terminal(p.name, match.group(), self.lineNumber)
        raise Exception(f'line: {self.lineNumber}: unrecognized input: {self.input[self.index]}')
        
    def matches(self, *types):
        if self.lookAhead == None:
            return False
        for t in types:
            if t == self.lookAhead.name:
                self.terminal = self.lookAhead
                self.lookAhead = self.next()
                return True
        return False

    def expect(self, *types):
        if self.matches(*types):
            return self.terminal
        raise Exception(f'line: {self.lineNumber}: expected {",".join(types)}, found {self.lookAhead}')

    def atEnd(self):
        return self.lookAhead == None

ESCAPE_CHARS = {'n': '\n', 'r': '\r', 't': '\t', 'f': '\f'}

class Parser(object):
    def __init__(self):
        patterns = []
        patterns.append(Pattern('def', r'def'))
        patterns.append(Pattern('var', r'var'))
        patterns.append(Pattern('if', r'if'))
        patterns.append(Pattern('else', r'else'))
        patterns.append(Pattern('loop', r'loop'))
        patterns.append(Pattern('while', r'while'))
        patterns.append(Pattern('do', r'do'))
        patterns.append(Pattern('if', r'if'))
        patterns.append(Pattern('else', r'else'))
        patterns.append(Pattern('const', r'const'))
        patterns.append(Pattern('call', r'call'))
        patterns.append(Pattern('return', r'return'))
        patterns.append(Pattern('print', r'print'))
        patterns.append(Pattern('ID', r'[a-zA-Z_][a-zA-Z0-9_\.]*'))
        patterns.append(Pattern('INT', r'(0x)?[0-9a-fA-F]+'))
        patterns.append(Pattern(';', r'\;'))
        patterns.append(Pattern(',', r'\,'))
        patterns.append(Pattern(':', r'\:'))
        patterns.append(Pattern('{', r'\{'))
        patterns.append(Pattern('}', r'\}'))
        patterns.append(Pattern('[', r'\['))
        patterns.append(Pattern(']', r'\]'))
        patterns.append(Pattern('(', r'\('))
        patterns.append(Pattern(')', r'\)'))
        patterns.append(Pattern('+', r'\+'))
        patterns.append(Pattern('-', r'\-'))
        patterns.append(Pattern('*', r'\*'))
        patterns.append(Pattern('/', r'\/'))
        patterns.append(Pattern('<<', r'\<\<'))
        patterns.append(Pattern('>>>', r'\>\>\>'))
        patterns.append(Pattern('>>', r'\>\>'))
        patterns.append(Pattern('<=', r'\<\='))
        patterns.append(Pattern('>=', r'\>\='))
        patterns.append(Pattern('==', r'\=\='))
        patterns.append(Pattern('!=', r'\!\='))
        patterns.append(Pattern('&&', r'\&\&'))
        patterns.append(Pattern('&', r'\&'))
        patterns.append(Pattern('||', r'\|\|'))
        patterns.append(Pattern('|', r'\|'))
        patterns.append(Pattern('^', r'\^'))
        patterns.append(Pattern('=', r'\='))
        patterns.append(Pattern('<', r'\<'))
        patterns.append(Pattern('>', r'\>'))
        patterns.append(Pattern('%', r'\%'))
        patterns.append(Pattern(',', r'\,'))
        patterns.append(Pattern('!', r'\!'))
        patterns.append(Pattern("'", r"'(?:[^'\\]|\\.)'"))
        patterns.append(Pattern('"', r'"(?:[^"\\]|\\.)*"'))
        self.sc = Scanner(patterns)
        self.prec = [('&&','||'), ('<', '!=', '>'), ('<<', '>>>', '>>'), ('&','|'), ('+','-')]

    def parse(self, input):
        self.sc.setInput(input)
        tree = self.parseProgram()
        if not self.sc.atEnd():
            raise Exception('Unexpected input: %s' % self.sc.terminal)
        return tree

    def parseProgram(self):
        tree = Tree()
        tree.add(self.parseExternal())
        while not self.sc.atEnd():
            tree.add(self.parseExternal())
        return tree

    def parseExternal(self):
        if self.sc.matches('const'):
            tree = Tree(self.sc.terminal)
            tree.add(self.sc.expect('ID'))
            self.sc.expect('=')
            tree.add(self.parseExp())
            self.sc.expect(';')
            return tree
        if self.sc.matches('var'):
            tree = Tree(self.sc.terminal)
            tree.add(self.sc.expect('ID'))
            if self.sc.matches('='):
                tree.add(self.parseExp())
            self.sc.expect(';')
            return tree
        tree = Tree(self.sc.expect('def'))
        tree.add(self.sc.expect('ID'))
        tree.add(self.parseStatList())
        return tree

    def parseStatList(self):
        tree = Tree(self.sc.expect('{'))
        while not self.sc.matches('}'):
            tree.add(self.parseStatement())
        return tree

    def parseStatement(self):
        if self.sc.matches('loop'):
            tree = Tree(self.sc.terminal)
            tree.add(self.parseStatList())
            return tree
        if self.sc.matches('do'):
            tree = Tree(self.sc.terminal)
            tree.add(self.parseStatList())
            self.sc.expect('while')
            if self.sc.matches('not'):
                tree.add(self.sc.terminal)
            tree.add(self.parseExp())
            self.sc.expect(';')
            return tree
        if self.sc.matches('ID'):
            var = self.sc.terminal
            tree = Tree(self.sc.expect('='))
            tree.add(var)
            tree.add(self.parseExp())
            self.sc.expect(';')
            return tree
        if self.sc.matches('if'):
            tree = Tree(self.sc.terminal)
            tree.add(self.parseExp())
            tree.add(self.parseStatList())
            if self.sc.matches('else'):
                tree.add(self.parseStatList())
            return tree
        if self.sc.matches('while'):
            tree = Tree(self.sc.terminal)
            tree.add(self.parseExp())
            tree.add(self.parseStatList())
            return tree
        if self.sc.matches('call'):
            tree = Tree(self.sc.terminal)
            tree.add(self.sc.expect('ID'))
            self.sc.expect(';')
            return tree
        if self.sc.matches('return'):
            tree = Tree(self.sc.terminal)
            self.sc.expect(';')
            return tree
        if self.sc.matches('print'):
            tree = Tree(self.sc.terminal)
            tree.add(self.parseExp())
            self.sc.expect(';')
            return tree
        self.sc.expect('if', 'do', 'while', 'ID', 'call', 'return', 'continue', 'print')

    def parseExp(self, index=0):
        result = self.parseTail(index)
        while self.sc.matches(*self.prec[index]):
            result = Tree(self.sc.terminal, result, self.parseTail(index))
        return result

    def parseTail(self, index):
        if index >= len(self.prec)-1:
            return self.parsePrim()
        return self.parseExp(index + 1)

    def escape(self, string):
        result = ''
        esc = False
        for c in string:
            if esc:
                result += ESCAPE_CHARS.get(c, c)
                esc = False
            elif c == '\\':
                esc = True
            else:
                result += c
        return result

    def parsePrim(self):
        if self.sc.matches('('):
            tree = self.parseExp()
            self.sc.expect(')')
            return tree
        if self.sc.matches('-'):
            return Tree(Terminal('NEG', '-'), self.parsePrim())
        if self.sc.matches('!'):
            return Tree(self.sc.terminal, self.parsePrim())
        if self.sc.matches('INT'):
            t = self.sc.terminal
            if t.value.startswith('0x'):
                t.value = int(t.value[2:], 16)
            else:
                t.value = int(t.value)
            return Tree(t)
        if self.sc.matches("'"):
            t = self.sc.terminal
            t.name = 'INT'
            t.value = ord(self.escape(t.value[1:-1]))
            return Tree(t)
        if self.sc.matches('"'):
            t = self.sc.terminal
            t.value = self.escape(t.value[1:-1])
            return Tree(t)
        return Tree(self.sc.expect('ID'))

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

class Generator(object):
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
            if t.value == 'var':
                name = t[0].value.value
                if len(t) > 1:
                    self.variables[name] = self.eval(t[1])
                else:
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
                opcodes[-1].lineNumber = tree.value.lineNumber
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
                if addr < 0x400:
                    opcodes.append(OpCode(OPS_NOP, 'RAM read delay slot'))
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

import sys

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print('usage: python Compiler.py <source-file> <hex-file>')
        sys.exit(1)

    cp = Parser()
    with open(sys.argv[1]) as f:
        tree = cp.parse(f.read())
    g = Generator(tree)
    g.write(sys.argv[2])
