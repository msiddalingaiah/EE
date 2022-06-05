
from pyAP import *

class DScanner(object):
    def __init__(self, input):
        self.input = input
        self.index = 0
        self.terminal = None
        self.lookAhead = self.next()

    def next(self):
        drv = None
        while self.index < len(self.input):
            drv = Directive(p, self.input[self.index])
            self.index += 1
            if not drv.isBlank():
                break
        #print(drv.cf[0].value.value)
        return drv
        
    def matches(self, *types):
        if self.lookAhead == None:
            return False
        for t in types:
            if t == '*' or t == self.lookAhead.getCF0():
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

class DParser(object):
    def __init__(self, scanner):
        self.sc = scanner

    def parse(self):
        tree = self.parseList()
        if not self.sc.atEnd():
            raise Exception('Unexpected input: %s' % self.sc.terminal)
        return tree

    def parseList(self):
        tree = Tree()
        while not self.sc.atEnd():
            if self.sc.matches('do1'):
                drv = Do1DRV(self.sc.terminal, self.sc.expect('*'))
            elif self.sc.matches('set'):
                drv = SetDRV(self.sc.terminal)
            elif self.sc.matches('com'):
                drv = ComDRV(self.sc.terminal)
            elif self.sc.matches('print'):
                drv = PrintDRV(self.sc.terminal)
            else:
                drv = self.sc.expect('*')
            tree.add(drv)
        return tree

class Directive(object):
    def __init__(self, parser, line):
        self.parser = parser
        self.lf = Tree()
        self.cf = Tree()
        self.af = Tree()
        self.parse(line)

    def isBlank(self):
        return self.cf.isLeaf()

    def getCF0(self):
        return self.cf[0].value.value

    def exec(self, symbols):
        name = self.getCF0()
        if name in symbols.directives:
            symbols.directives[name].exec(symbols)
        else:
            raise Exception(f'No such directive {name}')

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

class PrintDRV(object):
    def __init__(self, drv):
        self.lf, self.cf, self.af = drv.lf, drv.cf, drv.af

    def exec(self, symbols):
        af = symbols.drv.af
        result = []
        for tree in af:
            result.append(str(symbols.eval(tree)))
        print(','.join(result))

class SetDRV(object):
    def __init__(self, drv):
        self.lf, self.cf, self.af = drv.lf, drv.cf, drv.af

    def exec(self, symbols):
        if len(self.af) == 1:
            symbols.variables[self.lf[0].value.value] = symbols.eval(self.af[0])
        else:
            symbols.variables[self.lf[0].value.value] = self.af

class ComDRV(object):
    def __init__(self, drv):
        self.lf, self.cf, self.af = drv.lf, drv.cf, drv.af

    def exec(self, symbols):
        name = self.lf[0].value.value
        varname = self.cf[1].value.value
        bitlist = self.cf.children[1:]
        if len(self.cf) == 2 and varname in symbols.variables:
            bitlist = symbols.variables[varname]
        bitfields = [symbols.eval(e) for e in bitlist]
        symbols.directives[name] = ComInstDRV(name, bitfields, self.af)

class ComInstDRV(object):
    def __init__(self, name, bitfields, com_af):
        self.name = name
        self.bitfields = bitfields
        self.com_af = com_af

    def exec(self, symbols):
        drv = symbols.drv
        result = 0
        fieldwidth = 0
        for i, bitfield in enumerate(self.bitfields):
            result <<= bitfield
            value = symbols.eval(self.com_af[i])
            mask = ~(-1<<bitfield)
            result |= value & mask
            fieldwidth += bitfield
        if len(drv.lf) > 0:
            symbols.variables[drv.lf[0].value.value] = symbols.variables['PC']
        symbols.variables['PC'] += 1
        fieldwidth = int((fieldwidth+1)/4)
        format = f'%0{fieldwidth}x'
        print(format % result)

class Do1DRV(object):
    def __init__(self, drv, next):
        self.drv = drv
        self.next = next

    def exec(self, symbols):
        drv = self.next
        symbols.drv = drv
        index = 0
        end = symbols.eval(self.drv.af[0])
        while index < end:
            if len(drv.lf) > 0:
                symbols.variables[self.drv.lf[0].value.value] = index
            drv.exec(symbols)
            index += 1

class LFFunc(object):
    def eval(self, symbols, args):
        result = symbols.drv.lf
        for arg in args:
            result = result[arg]
        return symbols.eval(result)

class CFFunc(object):
    def eval(self, symbols, args):
        result = symbols.drv.cf
        for arg in args:
            result = result[arg]
        return symbols.eval(result)

class AFFunc(object):
    def eval(self, symbols, args):
        result = symbols.drv.af
        for arg in args:
            result = result[arg]
        return symbols.eval(result)

class Symbols(object):
    def __init__(self):
        self.drv = None
        self.directives = {}
        self.functions = {}
        self.functions['lf'] = LFFunc()
        self.functions['cf'] = CFFunc()
        self.functions['af'] = AFFunc()
        self.variables = {}
        self.variables['PC'] = 0

    def eval(self, tree):
        op = tree.value.name
        if op == 'INT':
            return int(tree.value.value)
        if op == 'ID':
            value = self.variables[tree.value.value]
            if isinstance(value, int):
                return value
            raise Exception(f'Cannot evaluate list {tree.value.value}')
        if op == 'call':
            func = self.functions[tree.value.value]
            args = [self.eval(e) for e in tree.children]
            return func.eval(self, args)
        if op == '+':
            return self.eval(tree[0]) + self.eval(tree[1])
        if op == '-':
            return self.eval(tree[0]) - self.eval(tree[1])
        if op == '&':
            return self.eval(tree[0]) & self.eval(tree[1])
        if op == '|':
            return self.eval(tree[0]) | self.eval(tree[1])
        if op == '^':
            return self.eval(tree[0]) ^ self.eval(tree[1])

if __name__ == '__main__':
    p = Parser()
    symbols = Symbols()
    with open('traffic.ap') as f:
        lines = f.readlines()
    
    parser = DParser(DScanner(lines))
    tree = parser.parse()
    for t in tree.children:
        drv = t.value
        symbols.drv = drv
        drv.exec(symbols)
