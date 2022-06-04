
from collections import defaultdict
import re

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

class Scanner(object):
    def __init__(self, patterns):
        self.patterns = patterns

    def setInput(self, input):
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

class Parser(object):
    def __init__(self):
        patterns = []
        patterns.append(Pattern('INT', r'[0-9]+'))
        patterns.append(Pattern('ID', r'[a-zA-Z][a-zA-Z0-9_]*'))
        patterns.append(Pattern(';', r'\;'))
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
        self.sc = Scanner(patterns)
        self.prec = [('&','|','^'), ('==','!=','>','<','>=','<='), ('+','-'), ('*','/','%')]

    def parse(self, input):
        self.sc.setInput(input)
        tree = self.parseList()
        if not self.sc.atEnd():
            raise Exception('Unexpected input: %s' % self.sc.terminal)
        return tree

    def parseList(self):
        tree = Tree(Terminal('(', '('))
        tree.add(self.parseTree())
        while self.sc.matches(','):
            tree.add(self.parseTree())
        return tree

    def parseTree(self):
        if self.sc.matches('('):
            if self.sc.matches(')'):
                return Tree()
            tree = self.parseList()
            self.sc.expect(')')
            return tree
        return self.parseExp()

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

    def parsePrim(self):
        if self.sc.matches('('):
            tree = self.parseExp()
            self.sc.expect(')')
            return tree
        if self.sc.matches('-'):
            return Tree(self.sc.terminal, self.parsePrim())
        if self.sc.matches('INT'):
            return Tree(self.sc.terminal)
        id = self.sc.expect('ID')
        if self.sc.matches('('):
            tree = Tree(Terminal('call', id.value))
            if self.sc.matches(')'):
                return tree
            tree.add(self.parseExp())
            while self.sc.matches(','):
                tree.add(self.parseExp())
            self.sc.expect(')')
            return tree
        return Tree(id)

class Directive(object):
    def __init__(self, parser, line):
        self.parser = parser
        self.lf = Tree()
        self.cf = Tree()
        self.af = Tree()
        self.parse(line)

    def isBlank(self):
        return self.cf.isLeaf()

    def parse(self, line):
        if ';' in line:
            semi = line.index(';')
            line = line[0:semi]
        if len(line) == 0:
            return
        if line[0].isspace():
            fields = line.split()
            if len(fields) > 0:
                self.cf = self.parser.parse(fields[0])
            if len(fields) > 1:
                self.af = self.parser.parse(fields[1])
            if len(fields) > 2:
                raise Exception(f'Too many fields: {line}')
            return
        fields = line.split()
        if len(fields) > 0:
            self.lf = self.parser.parse(fields[0])
        if len(fields) > 1:
            self.cf = self.parser.parse(fields[1])
        if len(fields) > 2:
            self.af = self.parser.parse(fields[2])
        if len(fields) > 3:
            raise Exception(f'Too many fields: {line}')

def eval(symbols, tree):
    op = tree.value.name
    if op == 'INT':
        return int(tree.value.value)
    if op == 'ID':
        return symbols['VARS'][tree.value.value]
    if op == 'call':
        func = symbols['FUNC'][tree.value.value]
        args = [eval(symbols, e) for e in tree.children]
        return func.eval(symbols, args)
    if op == '+':
        return eval(symbols, tree[0]) + eval(symbols, tree[1])
    if op == '-':
        return eval(symbols, tree[0]) - eval(symbols, tree[1])
    if op == '&':
        return eval(symbols, tree[0]) & eval(symbols, tree[1])
    if op == '|':
        return eval(symbols, tree[0]) | eval(symbols, tree[1])
    if op == '^':
        return eval(symbols, tree[0]) ^ eval(symbols, tree[1])

class PrintDRV(object):
    def exec(self, symbols, drv):
        result = []
        for tree in drv.af:
            result.append(str(eval(symbols, tree)))
        print(','.join(result))

class SetDRV(object):
    def exec(self, symbols, drv):
        symbols['VARS'][drv.lf[0].value.value] = eval(symbols, drv.af[0])

class AFFunc(object):
    def eval(self, symbols, args):
        drv = symbols['CURRENT_DRV']
        result = drv.af
        for arg in args:
            result = result[arg]
        return eval(symbols, result)

# [19:16 LEDs] | [12:12 loadc] | [11:8 fe, pup, s1, s0] | [7:0 Di/constant]
if __name__ == '__main__':
    p = Parser()
    symbols = defaultdict(dict)
    symbols['DRVS']['print'] = PrintDRV()
    symbols['DRVS']['set'] = SetDRV()
    symbols['FUNC']['af'] = AFFunc()
    drvs = []
    drvs.append(Directive(p, 'x set 6-3'))
    drvs.append(Directive(p, ' print af(2,1),2,(x,4)'))
    for drv in drvs:
        symbols['CURRENT_DRV'] = drv
        ds = drv.cf[0].value.value
        drv_syms = symbols['DRVS']
        if ds in drv_syms:
            drv_syms[ds].exec(symbols, drv)
        else:
            raise Exception(f'No such directive {ds}')
