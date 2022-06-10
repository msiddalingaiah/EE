
from CParser import *

class DScanner(object):
    def __init__(self, input):
        self.input = input
        self.index = 0
        self.terminal = None
        self.parser = CParser()
        self.lookAhead = self.next()

    def next(self):
        drv = None
        while self.index < len(self.input):
            drv = self.parseDirective(self.input[self.index])
            self.index += 1
            if not drv.isBlank():
                break
        if drv and drv.isBlank():
            return None
        return drv

    def parseDirective(self, line):
        if ';' in line:
            semi = line.index(';')
            line = line[0:semi]
        lf = cf = af = Tree()
        if len(line) == 0:
            return Directive(lf, cf, af)
        if line[0].isspace():
            fields = line.split()
            if len(fields) > 0:
                cf = self.parser.parse(fields[0])
            if len(fields) > 1:
                af = self.parser.parse(fields[1])
            if len(fields) > 2:
                raise Exception(f'Too many fields: {line}')
            return Directive(lf, cf, af)
        fields = line.split()
        if len(fields) > 0:
            lf = self.parser.parse(fields[0])
        if len(fields) > 1:
            cf = self.parser.parse(fields[1])
        if len(fields) > 2:
            af = self.parser.parse(fields[2])
        if len(fields) > 3:
            raise Exception(f'Too many fields: {line}')
        return Directive(lf, cf, af)

    def peek(self, *types):
        if self.lookAhead == None:
            return False
        for t in types:
            if t == '*' or t == self.lookAhead.getCF0():
                return True
        return False

    def matches(self, *types):
        if self.peek(*types):
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
        result = []
        while not self.sc.atEnd():
            if self.sc.matches('cname'):
                self.parseCName(result, CNameDEFDRV(self.sc.terminal))
            else:
                result.append(self.parseDo())
        return result

    def parseCName(self, result, cname):
        cnames = []
        cnames.append(cname)
        result.append(cname)
        while self.sc.matches('cname'):
            cname = CNameDEFDRV(self.sc.terminal)
            cnames.append(cname)
            result.append(cname)
        body = []
        self.sc.expect('proc')
        while True:
            if self.sc.matches('pend'):
                break
            if self.sc.atEnd():
                raise Exception('Missing PEND directive')
            body.append(self.parseDo())
        for cname in cnames:
            cname.body = body

    def parseDo(self):
        if self.sc.matches('do'):
            do = DoDRV(self.sc.terminal)
            inElse = False
            while True:
                if self.sc.matches('else'):
                    if inElse:
                        raise Exception('ELSE not allowed here')
                    inElse = True
                if self.sc.matches('fin'):
                    break
                if self.sc.atEnd():
                    raise Exception('Missing FIN directive')
                if inElse:
                    do.addElse(self.parseDo())
                else:
                    do.add(self.parseDo())
            return do
        return self.parsePrim()

    def parsePrim(self):
        if self.sc.matches('do1'):
            do1 = self.sc.terminal
            if self.sc.atEnd():
                raise Exception('Missing directive after do1')
            next = self.parsePrim0()
            return Do1DRV(do1, next)
        return self.parsePrim0()

    def parsePrim0(self):
        if self.sc.matches('set'):
            return SetDRV(self.sc.terminal)
        if self.sc.matches('com'):
            return ComDEFDRV(self.sc.terminal)
        if self.sc.matches('print'):
            return PrintDRV(self.sc.terminal)
        if self.sc.matches('gen'):
            return GenDRV(self.sc.terminal)
        if self.sc.matches('do', 'do1', 'else', 'fin', 'cname'):
            name = self.sc.terminal.getCF0()
            raise Exception(f'{name} not allowed here')
        return self.sc.expect('*')

class Directive(object):
    def __init__(self, lf, cf, af):
        self.lf = lf
        self.cf = cf
        self.af = af
        self.fieldMap = {'lf':lf, 'cf':cf, 'af':af}

    def isBlank(self):
        return self.cf.isLeaf()

    def getCF0(self):
        return self.cf[0].value.value

    def exec(self, symbols):
        name = self.getCF0()
        if name in symbols.directives:
            drv = symbols.directives[name]
            drv.exec(symbols, self)
        else:
            raise Exception(f'No such directive {name}')

    def eval(self, symbols, tree):
        op = tree.value.name
        if op == 'INTI':
            return tree.value.value
        if op == 'INT':
            return int(tree.value.value)
        if op == 'ID':
            name = tree.value.value
            # Forward reference hack
            if name not in symbols.variables:
                symbols.variables[name] = 0
            value = symbols.variables[name]
            if isinstance(value, int):
                return value
            raise Exception(f'Cannot evaluate list {tree.value.value}')
        if op == 'call':
            fname = tree.value.value
            args = [self.eval(symbols, e) for e in tree.children]
            if fname in self.fieldMap:
                result = self.fieldMap[fname]
                for arg in args:
                    result = result[arg]
                return self.eval(symbols, result)
            func = symbols.functions[fname]
            return func.eval(self, symbols, args)
        if op == 'NEG':
            return -self.eval(symbols, tree[0])
        if op == '+':
            return self.eval(symbols, tree[0]) + self.eval(symbols, tree[1])
        if op == '-':
            return self.eval(symbols, tree[0]) - self.eval(symbols, tree[1])
        if op == '*':
            return self.eval(symbols, tree[0]) * self.eval(symbols, tree[1])
        if op == '/':
            return int(self.eval(symbols, tree[0]) / self.eval(symbols, tree[1]))
        if op == '%':
            return self.eval(symbols, tree[0]) % self.eval(symbols, tree[1])
        if op == '&':
            return self.eval(symbols, tree[0]) & self.eval(symbols, tree[1])
        if op == '|':
            return self.eval(symbols, tree[0]) | self.eval(symbols, tree[1])
        if op == '^':
            return self.eval(symbols, tree[0]) ^ self.eval(symbols, tree[1])
        if op == '<':
            return int(self.eval(symbols, tree[0]) < self.eval(symbols, tree[1]))
        if op == '<=':
            return int(self.eval(symbols, tree[0]) <= self.eval(symbols, tree[1]))
        if op == '==':
            return int(self.eval(symbols, tree[0]) == self.eval(symbols, tree[1]))
        if op == '>=':
            return int(self.eval(symbols, tree[0]) >= self.eval(symbols, tree[1]))
        if op == '>':
            return int(self.eval(symbols, tree[0]) > self.eval(symbols, tree[1]))

    def __str__(self):
        return f'{self.getCF0()}'

class PrintDRV(Directive):
    def __init__(self, drv):
        super().__init__(drv.lf, drv.cf, drv.af)

    def exec(self, symbols):
        result = []
        for tree in self.af:
            result.append(str(self.eval(symbols, tree)))
        print(','.join(result))

class SetDRV(Directive):
    def __init__(self, drv):
        super().__init__(drv.lf, drv.cf, drv.af)

    def exec(self, symbols):
        if len(self.af) == 1:
            symbols.variables[self.lf[0].value.value] = self.eval(symbols, self.af[0])
        else:
            symbols.variables[self.lf[0].value.value] = self.af

class ComDEFDRV(Directive):
    def __init__(self, drv):
        super().__init__(drv.lf, drv.cf, drv.af)

    def exec(self, symbols):
        name = self.lf[0].value.value
        varname = self.cf[1].value.value
        bitlist = self.cf.children[1:]
        if len(self.cf) == 2 and varname in symbols.variables:
            bitlist = symbols.variables[varname]
        bitfields = [self.eval(symbols, e) for e in bitlist]
        symbols.directives[name] = ComREFDRV(name, bitfields, self.af)

class ComREFDRV(object):
    def __init__(self, name, bitfields, com_af):
        self.name = name
        self.bitfields = bitfields
        self.com_af = com_af

    def exec(self, symbols, ref):
        result = 0
        fieldwidth = 0
        for i, bitfield in enumerate(self.bitfields):
            result <<= bitfield
            value = ref.eval(symbols, self.com_af[i])
            mask = ~(-1<<bitfield)
            result |= value & mask
            fieldwidth += bitfield
        if len(ref.lf) > 0:
            symbols.variables[ref.lf[0].value.value] = symbols.variables['PC']
        symbols.variables['PC'] += 1
        fieldwidth = int((fieldwidth+1)/4)
        format = f'%0{fieldwidth}x'
        if symbols.object_code != None:
            symbols.object_code.append(format % result)

class Do1DRV(Directive):
    def __init__(self, drv, next):
        super().__init__(drv.lf, drv.cf, drv.af)
        self.next = next

    def exec(self, symbols):
        varName = None
        if len(self.lf) > 0:
            varName = self.lf[0].value.value
        index = 0
        end = self.eval(symbols, self.af[0])
        while index < end:
            if varName != None:
                symbols.variables[varName] = index
            self.next.exec(symbols)
            index += 1

class DoDRV(Directive):
    def __init__(self, drv):
        super().__init__(drv.lf, drv.cf, drv.af)
        self.doList = []
        self.elseList = []

    def add(self, drv):
        self.doList.append(drv)

    def addElse(self, drv):
        self.elseList.append(drv)

    def exec(self, symbols):
        varName = None
        if len(self.lf) > 0:
            varName = self.lf[0].value.value
        index = 0
        end = self.eval(symbols, self.af[0])
        if index >= end:
            if varName != None:
                symbols.variables[varName] = index
            for drv in self.elseList:
                drv.exec(symbols)
            return
        while index < end:
            if varName != None:
                symbols.variables[varName] = index
            for drv in self.doList:
                drv.exec(symbols)
            index += 1

class GenDRV(Directive):
    def __init__(self, drv):
        super().__init__(drv.lf, drv.cf, drv.af)

    def exec(self, symbols):
        varname = self.cf[1].value.value
        bitlist = self.cf.children[1:]
        if len(self.cf) == 2 and varname in symbols.variables:
            bitlist = symbols.variables[varname]
        bitfields = [self.eval(symbols, e) for e in bitlist]
        result = 0
        fieldwidth = 0
        for i, bitfield in enumerate(bitfields):
            result <<= bitfield
            value = self.eval(symbols, self.af[i])
            mask = ~(-1<<bitfield)
            result |= value & mask
            fieldwidth += bitfield
        if len(self.lf) > 0:
            symbols.variables[self.drv.lf[0].value.value] = symbols.variables['PC']
        symbols.variables['PC'] += 1
        fieldwidth = int((fieldwidth+1)/4)
        format = f'%0{fieldwidth}x'
        if symbols.object_code != None:
            symbols.object_code.append(format % result)

class CNameDEFDRV(Directive):
    def __init__(self, drv):
        super().__init__(drv.lf, drv.cf, drv.af)
        self.body = None

    def exec(self, symbols):
        name = self.lf[0].value.value
        symbols.directives[name] = CNameREFDRV(name, self.body)

class CNameREFDRV(object):
    def __init__(self, name, drvs):
        self.name = name
        self.drvs = drvs

    def exec(self, symbols, ref):
        for drv in self.drvs:
            taf = drv.af
            af = Tree(Terminal('(', '('))
            for i in range(len(taf)):
                value = ref.eval(symbols, taf[i])
                af.add(Terminal('INTI', value))
            if drv.getCF0() in symbols.directives:
                d = Directive(drv.lf, drv.cf, af)
                d.exec(symbols)
            else:
                drv.af = af
                drv.exec(symbols)
                drv.af = taf

class Symbols(object):
    def __init__(self):
        self.object_code = None
        self.directives = {}
        self.functions = {}
        self.variables = {}
        self.variables['PC'] = 0
