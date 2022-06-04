
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
            if t == '*' or t == self.lookAhead.cf[0].value.value:
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
                drv = self.sc.terminal
                drv.next = self.sc.expect('*')
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
    def exec(self, symbols):
        drv = symbols['CURRENT_DRV']
        result = []
        for tree in drv.af:
            result.append(str(eval(symbols, tree)))
        print(','.join(result))

class SetDRV(object):
    def exec(self, symbols):
        drv = symbols['CURRENT_DRV']
        symbols['VARS'][drv.lf[0].value.value] = eval(symbols, drv.af[0])

class ComDRV(object):
    def exec(self, symbols):
        drv = symbols['CURRENT_DRV']
        name = drv.lf[0].value.value
        bitfields = [eval(symbols, e) for e in drv.cf.children[1:]]
        symbols['DRVS'][name] = ComInstDRV(name, bitfields, drv.af)

class ComInstDRV(object):
    def __init__(self, name, bitfields, com_af):
        self.name = name
        self.bitfields = bitfields
        self.com_af = com_af

    def exec(self, symbols):
        drv = symbols['CURRENT_DRV']
        result = 0
        fieldwidth = 0
        for i, bitfield in enumerate(self.bitfields):
            result <<= bitfield
            value = eval(symbols, self.com_af[i])
            mask = ~(-1<<bitfield)
            result |= value & mask
            fieldwidth += bitfield
        if len(drv.lf) > 0:
            symbols['VARS'][drv.lf[0].value.value] = symbols['VARS']['PC']
        symbols['VARS']['PC'] += 1
        fieldwidth = int((fieldwidth+1)/4)
        format = f'%0{fieldwidth}x'
        print(format % result)

class Do1DRV(object):
    def exec(self, symbols):
        do1 = symbols['CURRENT_DRV']
        drv = do1.next

        symbols['CURRENT_DRV'] = drv
        ds = drv.cf[0].value.value
        drv_syms = symbols['DRVS']
        if ds not in drv_syms:
            raise Exception(f'No such directive {ds}')
        op = drv_syms[ds]

        index = 0
        end = eval(symbols, do1.af[0])
        while index < end:
            if len(drv.lf) > 0:
                symbols['VARS'][do1.lf[0].value.value] = index
            op.exec(symbols)
            index += 1

class LFFunc(object):
    def eval(self, symbols, args):
        drv = symbols['CURRENT_DRV']
        result = drv.lf
        for arg in args:
            result = result[arg]
        return eval(symbols, result)

class CFFunc(object):
    def eval(self, symbols, args):
        drv = symbols['CURRENT_DRV']
        result = drv.cf
        for arg in args:
            result = result[arg]
        return eval(symbols, result)

class AFFunc(object):
    def eval(self, symbols, args):
        drv = symbols['CURRENT_DRV']
        result = drv.af
        for arg in args:
            result = result[arg]
        return eval(symbols, result)

if __name__ == '__main__':
    p = Parser()
    symbols = defaultdict(dict)
    symbols['DRVS']['print'] = PrintDRV()
    symbols['DRVS']['set'] = SetDRV()
    symbols['DRVS']['com'] = ComDRV()
    symbols['DRVS']['do1'] = Do1DRV()
    symbols['FUNC']['af'] = AFFunc()
    symbols['VARS']['PC'] = 0
    with open('traffic.ap') as f:
        lines = f.readlines()
    
    drvs = []
    for line in lines:
        drv = Directive(p, line)
        if not drv.isBlank():
            drvs.append(drv)

    parser = DParser(DScanner(lines))
    tree = parser.parse()
    for t in tree.children:
        drv = t.value
        symbols['CURRENT_DRV'] = drv
        ds = drv.cf[0].value.value
        drv_syms = symbols['DRVS']
        if ds in drv_syms:
            drv_syms[ds].exec(symbols)
        else:
            raise Exception(f'No such directive {ds}')
