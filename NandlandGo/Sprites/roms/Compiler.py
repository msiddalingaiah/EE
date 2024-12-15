

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
        while self.index < len(self.input) and self.input[self.index].isspace():
            if self.input[self.index] == '\n':
                self.lineNumber += 1
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
        patterns.append(Pattern('>>', r'\>\>'))
        patterns.append(Pattern('<=', r'\<\='))
        patterns.append(Pattern('>=', r'\>\='))
        patterns.append(Pattern('==', r'\=\='))
        patterns.append(Pattern('!=', r'\!\='))
        patterns.append(Pattern('&', r'\&'))
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
        self.prec = [('&','|','^'), ('>>', '<<'), ('==','!=','>','<','>=','<='), ('+','-')]

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

OPS_LOAD_MEM = '01'
OPS_STORE_MEM = '10'
OPS_ALU_ADD = '20'
OPS_ALU_SUB = '21'
OPS_ALU_AND = '22'
OPS_ALU_OR = '23'
OPS_ALU_XOR = '24'
OPS_ALU_SL = '25'
OPS_ALU_LSR = '26'
OPS_ALU_ASR = '27'
OPS_ALU_SL6 = '28'

OPS_ALU_NEG = '28'
OPS_SYS_PRINT = '41'
OPS_JUMP = '30'
OPS_JUMP_ZERO = '31'
OPS_JUMP_NOT_ZERO = '32'

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
        self.genStatList(main)

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
        for stat in tree:
            s0_name = stat.value.name
            if s0_name == 'call':
                func = stat[0].value.value
                raise Exception(f"line {func.value.lineNumber}, call {func} does not exist")
            elif s0_name == 'print':
                self.genEval(stat[0])
                self.opcodes.append(OPS_SYS_PRINT)
            elif s0_name == 'while':
                top = len(self.opcodes)
                self.genEval(stat[0])
                jump = len(self.opcodes)
                self.opcodes.append('80')
                self.opcodes.append(OPS_JUMP_ZERO)
                self.genStatList(stat[1])
                pc = 0x80 | ((top - len(self.opcodes) - 2) & 0x7f)
                self.opcodes.append(f'{pc:02x}')
                self.opcodes.append(OPS_JUMP)
                pc = 0x80 | ((len(self.opcodes) - jump - 2) & 0x7f)
                self.opcodes[jump] = f'{pc:02x}'
            elif s0_name == '=':
                var_name = stat[0].value.value
                if var_name not in self.variables:
                    raise Exception(f"line {stat[1].value.lineNumber}, undefined variable {var_name}")
                self.genEval(stat[1])
                self.genLoadImm(stat[0], self.variables[var_name])
                self.opcodes.append(OPS_STORE_MEM)
            else:
                raise Exception(f'{s0_name} not yet support')

    def genLoadImm(self, tree, value):
        if value < 64:
            self.opcodes.append(f"{0x80 | value:02x}")
        else:
            self.opcodes.append(f"{0x80 | (value>>6):02x}")
            self.opcodes.append(OPS_ALU_SL6)
            self.opcodes.append(f"{0x80 | (value&0x3f):02x}")
            self.opcodes.append(OPS_ALU_OR)

    def genEval(self, tree):
        if tree.value.name == 'INT':
            self.genLoadImm(tree, tree.value.value)
            return
        if tree.value.name == 'ID':
            name = tree.value.value
            if name in self.variables:
                self.genLoadImm(tree, self.variables[name])
                self.opcodes.append(OPS_LOAD_MEM)
                return
            elif name in self.constants:
                self.genLoadImm(tree, self.constants[name])
                return
            raise Exception(f"line {tree.value.lineNumber}, No such constant '{name}'")
        op = tree.value.name
        self.genEval(tree.children[0])
        if op == 'NEG':
            self.opcodes.append(OPS_ALU_NEG)
            return
        self.genEval(tree.children[1])
        if op == '+':
            self.opcodes.append(OPS_ALU_ADD)
            return
        if op == '-':
            self.opcodes.append(OPS_ALU_SUB)
            return
        raise Exception(f"line {tree.value.lineNumber}, Unknown operator '{op}'")

    def write(self, fname):
        print(f'Code size {len(self.opcodes)} bytes')
        with open(fname, "wt") as f:
            for op in self.opcodes:
                f.write(f"{op}\n")
            for i in range(512-len(self.opcodes)):
                f.write("00\n")

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
