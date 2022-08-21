
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
    def __init__(self, patterns):
        self.patterns = patterns

    def setInput(self, input):
        self.lineNumber = 1
        self.input = input
        self.index = 0
        self.terminal = None
        self.lookAhead = self.next()

    def next(self):
        while self.index < len(self.input) and self.input[self.index].isspace():
            self.index += 1
        if self.index >= len(self.input):
            return None
        for p in self.patterns:
            match = p.match(self.input, self.index)
            if match:
                self.index = match.end()
                return Terminal(p.name, match.group())
        raise Exception('Unrecognized input: %s' % (self.input[self.index]))
        
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
        raise Exception('Expected %s, found %s' % (','.join(types), self.lookAhead))

    def atEnd(self):
        return self.lookAhead == None

ESCAPE_CHARS = {'n': '\n', 'r': '\r', 't': '\t', 'f': '\f'}

class Parser(object):
    def __init__(self):
        patterns = []
        patterns.append(Pattern('define', r'define'))
        patterns.append(Pattern('field', r'field'))
        patterns.append(Pattern('if', r'if'))
        patterns.append(Pattern('else', r'else'))
        patterns.append(Pattern('do', r'do'))
        patterns.append(Pattern('while', r'while'))
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
        self.sc = CScanner(patterns)
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
            if self.sc.matches('define'):
                tree.add(self.parseDefine())
            elif self.sc.matches('field'):
                tree.add(self.parseField())
            else:
                tree.add(self.parseStatement())
        return tree

    # define ID = EXP ;
    def parseDefine(self):
        tree = Tree(self.sc.terminal)
        tree.add(self.sc.expect('ID'))
        self.sc.expect('=')
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

    # # if | do | ID = EXP [, ID = EXP]* ;
    def parseStatement(self):
        if self.sc.matches('if'):
            return self.parseIf()
        if self.sc.matches('do'):
            return self.parseDo()
        tree = Tree(Terminal(',', ','))
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

grammar = '''
CODE -> DEFLIST STATLIST
DEFLIST -> DEF+ | FIELD+
DEF -> 'def' ID = EXP ;
FIELD -> 'field' ID = EXP : EXP ;
STATLIST -> STAT+
STAT -> MULTI_ASSIGN | IF | SWITCH | { STAT+ }
MULTI_ASSIGN -> ASSIGN [, ASSIGN]+ ;
ASSIGN -> ID = EXP
IF -> 'if' ( ASSIGN ) STAT [ 'else' STAT]
'''

input = '''
define x = 1;
field constant = 7:0;
field alu_op = 10:8;
x = 1, y = 2;
if (mux = foo) {
    x = 2, y = 3;
} else {
    x = 3, y = 4;
}
x = 1, y = 2;
do {
    z = 1, a = 2;
} while (mux = bar);
'''

if __name__ == '__main__':
    cp = Parser()
    print(cp.parse(input))
