
from collections import defaultdict
import re

class APError(Exception):
    def __init__(self, message, lineNumber):
        super().__init__(message)
        # 1-based line number
        self.lineNumber = lineNumber

class Pattern(object):
    def __init__(self, name, regex):
        self.name = name
        self.pattern = re.compile(regex)
        
    def match(self, input, index):
        return self.pattern.match(input, index)
    
class Terminal(object):
    def __init__(self, name, value):
        self.name = name
        self.value = value

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

class CScanner(object):
    def __init__(self, patterns, keywordName, keywordList):
        self.patterns = patterns
        self.keywordName = keywordName
        self.keywordList = keywordList

    def setInput(self, input):
        self.lineNumber = 1
        self.input = input
        self.index = 0
        self.terminal = None
        self.lookAhead = self.next()

    def next(self):
        while self.index < len(self.input) and self.input[self.index].isspace():
            if self.input[self.index] == '\n':
                self.lineNumber += 1
            self.index += 1
        if self.index >= len(self.input):
            return None
        if self.input[self.index] == '#':
            while self.index < len(self.input) and self.input[self.index] != '\n':
                self.index += 1
            self.index += 1
            self.lineNumber += 1
        if self.index >= len(self.input):
            return None
        for p in self.patterns:
            match = p.match(self.input, self.index)
            if match:
                self.index = match.end()
                name, value = p.name, match.group()
                if name == self.keywordName and value in self.keywordList:
                    name = value
                return Terminal(name, value)
        raise Exception(f'{self.lineNumber}: Unrecognized input: {self.input[self.index]}')
        
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
        expected = ','.join(types)
        raise Exception(f'{self.lineNumber}: Expected {expected}, found {self.lookAhead}')

    def atEnd(self):
        return self.lookAhead == None

ESCAPE_CHARS = {'n': '\n', 'r': '\r', 't': '\t', 'f': '\f'}

class Parser(object):
    def __init__(self):
        patterns = []
        patterns.append(Pattern('ID', r'[a-zA-Z][a-zA-Z0-9_]*'))
        patterns.append(Pattern('INT', r'(0x)?[0-9a-fA-F]+'))
        patterns.append(Pattern(';', r'\;'))
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
        patterns.append(Pattern("'", r"'(?:[^'\\]|\\.)'"))
        patterns.append(Pattern('"', r'"(?:[^"\\]|\\.)*"'))
        keywords = ['const', 'condition', 'field', 'if', 'else', 'do', 'while', 'def', 'return', 'call']
        self.sc = CScanner(patterns, 'ID', keywords)
        self.prec = [('&','|','^'), ('>>', '<<'), ('==','!=','>','<','>=','<='), ('+','-'), ('*','/','%')]

    def parse(self, input):
        self.sc.setInput(input)
        tree = self.parseProgram()
        if not self.sc.atEnd():
            raise Exception('Unexpected input: %s' % self.sc.terminal)
        return tree

    def parseProgram(self):
        tree = Tree(Terminal('program', 'program'))
        while not self.sc.atEnd():
            if self.sc.matches('const'):
                tree.add(self.parseConst())
            elif self.sc.matches('condition'):
                tree.add(self.parseCondField())
            elif self.sc.matches('field'):
                tree.add(self.parseField())
            elif self.sc.matches('def'):
                tree.add(self.parseDef())
            else:
                tree.add(self.parseStatement())
        return tree

    # const ID = EXP ;
    def parseConst(self):
        tree = Tree(self.sc.terminal)
        tree.add(self.sc.expect('ID'))
        self.sc.expect('=')
        tree.add(self.parseExp())
        self.sc.expect(';')
        return tree

    # condition field ID = EXP : EXP ;
    def parseCondField(self):
        tree = Tree(self.sc.terminal)
        self.sc.expect('field')
        tree.add(self.sc.expect('ID'))
        self.sc.expect('=')
        tree.add(self.parseExp())
        self.sc.expect(':')
        tree.add(self.parseExp())
        self.sc.expect(';')
        return tree

    # field ID = EXP : EXP ;
    def parseField(self):
        tree = Tree(self.sc.terminal)
        tree.add(self.sc.expect('ID'))
        self.sc.expect('=')
        tree.add(self.parseExp())
        self.sc.expect(':')
        tree.add(self.parseExp())
        self.sc.expect(';')
        return tree

    # def ID { }
    def parseDef(self):
        tree = Tree(self.sc.terminal)
        tree.add(self.sc.expect('ID'))
        tree.add(self.parseStatlist())
        return tree

    # # if | do | return | call | ID = EXP [, ID = EXP]* ;
    def parseStatement(self):
        if self.sc.matches('if'):
            return self.parseIf()
        if self.sc.matches('do'):
            return self.parseDo()
        if self.sc.matches('return'):
            tree = Tree(self.sc.terminal)
            self.sc.expect(';')
            return tree
        if self.sc.matches('call'):
            tree = Tree(self.sc.terminal)
            tree.add(self.sc.expect('ID'))
            self.sc.expect(';')
            return tree
        tree = Tree(Terminal('assign', 'assign'))
        while True:
            eq = Tree(Terminal('=', '='))
            eq.add(self.sc.expect('ID'))
            self.sc.expect('=')
            eq.add(self.parseExp())
            tree.add(eq)
            if self.sc.matches(';'):
                break
            self.sc.expect(',')
        return tree

    # if (ID = EXP) { }
    def parseIf(self):
        tree = Tree(self.sc.terminal)
        self.sc.expect('(')
        tree.add(self.sc.expect('ID'))
        self.sc.expect('=')
        tree.add(self.parseExp())
        self.sc.expect(')')
        tree.add(self.parseStatlist())
        if self.sc.matches('else'):
            tree.add(self.parseStatlist())
        return tree

    # do { } while (ID = EXP);
    def parseDo(self):
        tree = Tree(self.sc.terminal)
        tree.add(self.parseStatlist())
        self.sc.expect('while')
        self.sc.expect('(')
        tree.add(self.sc.expect('ID'))
        self.sc.expect('=')
        tree.add(self.parseExp())
        self.sc.expect(')')
        self.sc.expect(';')
        return tree

    def parseStatlist(self):
        tree = Tree(self.sc.expect('{'))
        while not self.sc.matches('}'):
            tree.add(self.parseStatement())
        return tree

    def parseExp(self):
        return self.parseHead(0)

    def parseHead(self, index):
        result = self.parseTail(index)
        while self.sc.matches(*self.prec[index]):
            result = Tree(self.sc.terminal, result, self.parseTail(index))
        return result
        
    def parseTail(self, index):
        if index >= len(self.prec)-1:
            return self.parsePrim()
        return self.parseHead(index + 1)

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
        return Tree(self.sc.expect('ID'))

input = '''
# d2d3 DPBus selects
const dp_sel_swap_register = 0;
const dp_sel_reg_ram_data_out = 1;
const dp_sel_mem_addr_hi = 2;
const dp_sel_mem_addr_lo = 3;
const dp_sel_cc = 9;
const dp_sel_bus_read = 10;
const dp_sel_ilr = 11;
const dp_sel_constant = 13;

# FBus selects
const f_sel_map_rom = 6;

# e6
const e6_wr_result_register = 1;
const e6_wr_register_index = 2;
const e6_wr_interrupt_level = 3;
const e6_wr_page_table_base = 4;
const e6_wr_memory_address = 5;
const e6_wr_condition_codes = 7;

const e7_wr_flags_register = 2;
const e7_wr_bus_read = 3;

const h11_wr_work_address_hi = 3;
const h11_inc_work_address = 4;
const h11_inc_memory_address = 5;
const h11_wr_swap_register = 7;

const k11_wr_work_address_lo = 6;

const branch_always = 3;

const alu_src_aq = 0;
const alu_src_ab = 1;
const alu_src_zq = 2;
const alu_src_zb = 3;
const alu_src_za = 4;
const alu_src_da = 5;
const alu_src_dq = 6;
const alu_src_dz = 7;

const alu_op_add = 0;
const alu_op_subr = 1;
const alu_op_subs = 2;
const alu_op_or = 3;
const alu_op_and = 4;
const alu_op_notrs = 5;
const alu_op_xor = 6;
const alu_op_xnor = 7;

field d2d3_dp_sel = 3:0;
field e6 = 6:4;
field k11 = 9:7;
field h11 = 12:10;
field e7 = 14:13;
field k9_enable = 15:15;

field j12 = 17:16;
field k9 = 18:16;
field constant = 23:16;
field seq_din = 26:16;
field j11_enable = 18:18;
field j13 = 21:20;
field branch_mux = 21:20;
field j10_enable = 21:21;
field k13 = 23:22;
field j10 = 24:22;

field alu_src = 36:34;
field alu_op = 39:37;
field alu_dest = 42:40;
field alu_b = 46:43;
field alu_a = 50:47;
field f6h6 = 52:51;

call reset;

do {
    
} while (branch_mux = branch_always);

def reset {
    constant = 0, d2d3_dp_sel = dp_sel_constant, alu_src = alu_src_dz, e6 = e6_wr_result_register;
    constant = 0xf8, d2d3_dp_sel = dp_sel_constant, alu_src = alu_src_dz, e6 = e6_wr_result_register; k11 = k11_wr_work_address_lo;
    h11 = h11_wr_work_address_hi;
}
'''

if __name__ == '__main__':
    cp = Parser()
    print(cp.parse(input))
