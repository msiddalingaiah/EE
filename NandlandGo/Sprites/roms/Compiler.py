

from collections import defaultdict
import re
import tokenize as tkn
import io

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

ESCAPE_CHARS = {'n': '\n', 'r': '\r', 't': '\t', 'f': '\f'}

class Scanner(object):
    def next(self):
        raise NotImplementedError()
        
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

class Pattern(object):
    def __init__(self, name, regex):
        self.name = name
        self.pattern = re.compile(regex)
        
    def match(self, input, index):
        return self.pattern.match(input, index)

class LineScanner(Scanner):
    def __init__(self, patterns):
        self.patterns = patterns
        self.spaces = Pattern('SPACES', r'[ \t]+')

    def setInput(self, input):
        self.lines = input.split('\n')
        self.index = 0
        self.indentStack = ['']
        self.terminal = None
        self.terminals = []
        self.collectTerminals()
        self.index = 0
        self.lookAhead = self.next()

    def next(self):
        if self.index < len(self.terminals):
            t = self.terminals[self.index]
            self.index += 1
            return t
        return None

    def collectTerminals(self):
        self.lineNumber = 1
        for line in self.lines:
            ls = line.strip()
            if len(ls) > 0 and ls[0] != '#':
                line = line.rstrip()
                self.index = 0
                while self.index < len(line):
                    self.nextLine(line)
                self.terminals.append(Terminal('EOL', '', self.lineNumber))
            self.lineNumber += 1
        while len(self.indentStack) > 1:
            self.terminals.append(Terminal('DEDENT', '', self.lineNumber))
            self.indentStack.pop()

    def nextLine(self, line):
        match = self.spaces.match(line, self.index)
        if match:
            if self.index == 0:
                self.index = match.end()
                text = match.group()
                if len(text) > len(self.indentStack[-1]):
                    self.indentStack.append(text)
                    self.terminals.append(Terminal('INDENT', text, self.lineNumber))
                    return
                if len(self.indentStack) and len(text) < len(self.indentStack[-1]):
                    while len(self.indentStack) and len(text) < len(self.indentStack[-1]):
                        self.terminals.append(Terminal('DEDENT', text, self.lineNumber))
                        self.indentStack.pop()
                    return
            self.index = match.end()
        if line[self.index] == '#':
            self.index = len(line)
            return
        for p in self.patterns:
            match = p.match(line, self.index)
            if match:
                self.index = match.end()
                self.terminals.append(Terminal(p.name, match.group(), self.lineNumber))
                return
        raise Exception(f'line: {self.lineNumber}: unrecognized input: {line[self.index:]}')

class TokenizeScanner(Scanner):
    def __init__(self, keywords):
        self.keywords = keywords

    def setInput(self, input):
        self.lineNumber = 1
        self.input = list(tkn.tokenize(io.BytesIO(input.encode()).readline))
        self.index = 0
        self.terminal = None
        self.lookAhead = self.next()

    def skipUnused(self):
        while self.index < len(self.input) and self.input[self.index].type not in [
            tkn.NAME,tkn.NUMBER, tkn.OP, tkn.INDENT, tkn.DEDENT, tkn.NEWLINE]:
            self.index += 1

    def next(self):
        self.skipUnused()
        if self.index >= len(self.input):
            return None
        t = self.input[self.index]
        self.index += 1
        self.lineNumber = t.start[0]
        if t.type == tkn.NAME:
            if t.string in self.keywords:
                return Terminal(t.string, t.string, t.start[0])
            return Terminal('ID', t.string, t.start[0])
        if t.type == tkn.NUMBER:
            # TODO: reject non-integers
            return Terminal('INT', t.string, t.start[0])
        if t.type == tkn.NEWLINE:
            return Terminal('EOL', t.string, t.start[0])
        if t.type == tkn.INDENT:
            return Terminal('INDENT', t.string, t.start[0])
        if t.type == tkn.DEDENT:
            return Terminal('DEDENT', t.string, t.start[0])
        if t.type == tkn.OP:
            # TODO: support &&, ||, >>>
            return Terminal(t.string, t.string, t.start[0])
        raise Exception(f'line: {t.start[0]}: unrecognized input: {t.string}')

class Parser(object):
    def __init__(self):
        patterns = []
        patterns.append(Pattern('def', r'def'))
        patterns.append(Pattern('var', r'var'))
        patterns.append(Pattern('ioport', r'ioport'))
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
        patterns.append(Pattern('pass', r'pass'))
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
        keywords = ['def', 'var', 'ioport', 'if', 'else', 'loop', 'while', 'do', 'const', 'call', 'return', 'print', 'not', 'pass']
        # self.sc = TokenizeScanner(keywords)
        self.sc = LineScanner(patterns)
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
            self.sc.expect('EOL')
            return tree
        if self.sc.matches('ioport'):
            tree = Tree(self.sc.terminal)
            tree.add(self.sc.expect('ID'))
            self.sc.expect(':')
            tree.add(self.parseExp())
            self.sc.expect('EOL')
            return tree
        if self.sc.matches('var'):
            tree = Tree(self.sc.terminal)
            tree.add(self.sc.expect('ID'))
            while self.sc.matches(','):
                tree.add(self.sc.expect('ID'))
            self.sc.expect('EOL')
            return tree
        tree = Tree(self.sc.expect('def'))
        tree.add(self.sc.expect('ID'))
        tree.add(self.parseStatList())
        return tree

    def parseStatList(self):
        colon = self.sc.expect(':')
        if self.sc.matches('EOL'):
            tree = Tree(self.sc.expect('INDENT'))
            while not self.sc.matches('DEDENT'):
                tree.add(self.parseStatement())
            return tree
        tree = Tree(Terminal('INDENT', '', colon.lineNumber))
        tree.add(self.parseStatement())
        return tree

    def parseStatement(self):
        if self.sc.matches('pass'):
            tree = Tree(self.sc.terminal)
            self.sc.expect('EOL')
            return tree
        if self.sc.matches('loop'):
            tree = Tree(self.sc.terminal)
            tree.add(self.parseStatList())
            return tree
        if self.sc.matches('do'):
            tree = Tree(self.sc.terminal)
            tree.add(self.parseStatList())
            self.sc.expect('while')
            tree.add(self.parseExp())
            self.sc.expect('EOL')
            return tree
        if self.sc.matches('ID'):
            var = self.sc.terminal
            tree = Tree(self.sc.expect('='))
            tree.add(var)
            tree.add(self.parseExp())
            self.sc.expect('EOL')
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
            self.sc.expect('EOL')
            return tree
        if self.sc.matches('return'):
            tree = Tree(self.sc.terminal)
            self.sc.expect('EOL')
            return tree
        if self.sc.matches('print'):
            tree = Tree(self.sc.terminal)
            tree.add(self.parseExp())
            self.sc.expect('EOL')
            return tree
        self.sc.expect('if', 'do', 'while', 'ID', 'call', 'return', 'print', 'pass')

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

import sys
from CodeGenerator import CodeGenerator

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print('usage: python Compiler.py <source-file> <hex-file>')
        sys.exit(1)

    cp = Parser()
    with open(sys.argv[1]) as f:
        tree = cp.parse(f.read())
    g = CodeGenerator(tree)
    g.write(sys.argv[2])
