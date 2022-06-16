
from logging import raiseExceptions
from CParser import *

class AP(object):
    def __init__(self, srcFile):
        self.symbols = Symbols()
        with open(srcFile) as f:
            lines = f.readlines()
        
            try:
                parser = DParser(DScanner(lines))
                drvs = parser.parse()
                for t in drvs:
                    t.exec(self.symbols)

                # Second pass to resolve forward references
                self.symbols.variables['PC'] = 0
                self.symbols.object_code = []
                for t in drvs:
                    t.exec(self.symbols)
            except APError as e:
                raise Exception(f'File {srcFile}, line {e.lineNumber}: {e}')

    def save(self, destFile):
        with open(destFile, 'wt') as f:
            f.write('\n'.join(self.symbols.object_code) + '\n')

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
            return Directive(lf, cf, af, self.index)
        if line[0].isspace():
            fields = line.split()
            if len(fields) > 0:
                cf = self.parser.parse(fields[0])
            if len(fields) > 1:
                af = self.parser.parse(fields[1])
            if len(fields) > 2:
                raise APError(f'Too many fields', self.index)
            return Directive(lf, cf, af, self.index+1)
        fields = line.split()
        if len(fields) > 0:
            lf = self.parser.parse(fields[0])
        if len(fields) > 1:
            cf = self.parser.parse(fields[1])
        if len(fields) > 2:
            af = self.parser.parse(fields[2])
        if len(fields) > 3:
            raise APError(f'Too many fields', self.index)
        return Directive(lf, cf, af, self.index)

    def peek(self, *types):
        if self.lookAhead == None:
            return False
        for t in types:
            if t == '*' or t == self.lookAhead.name:
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
        raise APError('Expected %s, found %s' % (','.join(types), self.lookAhead), self.index)

    def atEnd(self):
        return self.lookAhead == None

class DParser(object):
    def __init__(self, scanner):
        self.sc = scanner

    def parse(self):
        tree = self.parseList()
        if not self.sc.atEnd():
            raise APError('Unexpected input: %s' % self.sc.terminal, self.sc.index)
        return tree

    def parseList(self):
        result = []
        while not self.sc.atEnd():
            if self.sc.matches('cname'):
                self.parseCName(result, CNameDEFDRV(self.sc.terminal, self.sc.index))
            else:
                result.append(self.parseDo())
        return result

    def parseCName(self, result, cname):
        cnames = []
        cnames.append(cname)
        result.append(cname)
        while self.sc.matches('cname'):
            cname = CNameDEFDRV(self.sc.terminal, self.sc.index)
            cnames.append(cname)
            result.append(cname)
        body = []
        self.sc.expect('proc')
        while True:
            if self.sc.matches('pend'):
                break
            if self.sc.atEnd():
                raise APError('Missing PEND directive', self.sc.index)
            body.append(self.parseDo())
        for cname in cnames:
            cname.body = body

    def parseDo(self):
        if self.sc.matches('do'):
            do = DoDRV(self.sc.terminal, self.sc.index)
            inElse = False
            while True:
                if self.sc.matches('else'):
                    if inElse:
                        raise APError('ELSE not allowed here', self.sc.index)
                    inElse = True
                if self.sc.matches('fin'):
                    break
                if self.sc.atEnd():
                    raise APError('Missing FIN directive', self.sc.index)
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
                raise APError('Missing directive after do1', self.sc.index)
            next = self.parsePrim0()
            return Do1DRV(do1, next, self.sc.index)
        return self.parsePrim0()

    def parsePrim0(self):
        if self.sc.matches('set'):
            return SetDRV(self.sc.terminal, self.sc.index)
        if self.sc.matches('com'):
            return ComDEFDRV(self.sc.terminal, self.sc.index)
        if self.sc.matches('print'):
            return PrintDRV(self.sc.terminal, self.sc.index)
        if self.sc.matches('gen'):
            return GenDRV(self.sc.terminal, self.sc.index)
        if self.sc.matches('do', 'do1', 'else', 'fin', 'cname'):
            name = self.sc.terminal.name
            raise APError(f'{name} not allowed here', self.sc.index)
        return self.sc.expect('*')

class Directive(object):
    def __init__(self, lf, cf, af, lineNumber):
        self.lf = lf
        self.cf = cf
        self.af = af
        self.lineNumber = lineNumber
        self.name = ''
        if len(cf) > 0:
            self.name = cf[0].value.value

    def isBlank(self):
        return self.name == ''

    def exec(self, symbols):
        symbols.setLineNumber(self.lineNumber)
        if self.name in symbols.directives:
            drv = symbols.directives[self.name]
            drv.exec(symbols, self)
        else:
            raise APError(f'No such directive {self.name}', self.lineNumber)

    def __str__(self):
        return f'{self.name}'

class PrintDRV(Directive):
    def __init__(self, drv, lineNumber):
        super().__init__(drv.lf, drv.cf, drv.af, lineNumber)
        self.lineNumber = lineNumber

    def exec(self, symbols):
        symbols.setLineNumber(self.lineNumber)
        result = []
        for tree in self.af:
            result.append(str(symbols.eval(tree)))
        print(','.join(result))

class SetDRV(Directive):
    def __init__(self, drv, lineNumber):
        super().__init__(drv.lf, drv.cf, drv.af, lineNumber)
        self.lineNumber = lineNumber

    def exec(self, symbols):
        symbols.setLineNumber(self.lineNumber)
        if len(self.af) == 1:
            symbols.variables[self.lf[0].value.value] = symbols.eval(self.af[0])
        else:
            symbols.variables[self.lf[0].value.value] = self.af

class ComDEFDRV(Directive):
    def __init__(self, drv, lineNumber):
        super().__init__(drv.lf, drv.cf, drv.af, lineNumber)
        self.lineNumber = lineNumber

    def exec(self, symbols):
        symbols.setLineNumber(self.lineNumber)
        name = self.lf[0].value.value
        varname = self.cf[1].value.value
        bitlist = self.cf.children[1:]
        if len(self.cf) == 2 and varname in symbols.variables:
            bitlist = symbols.variables[varname]
        bitfields = [symbols.eval(e) for e in bitlist]
        symbols.directives[name] = ComREFDRV(name, bitfields, self.af)

class ComREFDRV(object):
    def __init__(self, name, bitfields, com_af):
        self.name = name
        self.bitfields = bitfields
        self.com_af = com_af

    def exec(self, symbols, ref):
        symbols.setLineNumber(ref.lineNumber)
        symbols.pushFields(ref.cf, ref.af)
        result = 0
        fieldwidth = 0
        for i, bitfield in enumerate(self.bitfields):
            result <<= bitfield
            value = symbols.eval(self.com_af[i])
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
        symbols.popFields()

class Do1DRV(Directive):
    def __init__(self, drv, next, lineNumber):
        super().__init__(drv.lf, drv.cf, drv.af, lineNumber)
        self.next = next
        self.lineNumber = lineNumber

    def exec(self, symbols):
        symbols.setLineNumber(self.lineNumber)
        varName = None
        if len(self.lf) > 0:
            varName = self.lf[0].value.value
        index = 0
        end = symbols.eval(self.af[0])
        while index < end:
            if varName != None:
                symbols.variables[varName] = index
            self.next.exec(symbols)
            index += 1

class DoDRV(Directive):
    def __init__(self, drv, lineNumber):
        super().__init__(drv.lf, drv.cf, drv.af, lineNumber)
        self.doList = []
        self.elseList = []
        self.lineNumber = lineNumber

    def add(self, drv):
        self.doList.append(drv)

    def addElse(self, drv):
        self.elseList.append(drv)

    def exec(self, symbols):
        symbols.setLineNumber(self.lineNumber)
        varName = None
        if len(self.lf) > 0:
            varName = self.lf[0].value.value
        index = 0
        end = symbols.eval(self.af[0])
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
    def __init__(self, drv, lineNumber):
        super().__init__(drv.lf, drv.cf, drv.af, lineNumber)
        self.lineNumber = lineNumber

    def exec(self, symbols):
        symbols.setLineNumber(self.lineNumber)
        varname = self.cf[1].value.value
        bitlist = self.cf.children[1:]
        if len(self.cf) == 2 and varname in symbols.variables:
            bitlist = symbols.variables[varname]
        bitfields = [symbols.eval(e) for e in bitlist]
        result = 0
        fieldwidth = 0
        if len(self.lf) > 0:
            symbols.variables[self.lf[0].value.value] = symbols.variables['PC']
        for i, bitfield in enumerate(bitfields):
            result <<= bitfield
            value = symbols.eval(self.af[i])
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
    def __init__(self, drv, lineNumber):
        super().__init__(drv.lf, drv.cf, drv.af, lineNumber)
        self.body = None
        self.lineNumber = lineNumber

    def exec(self, symbols):
        symbols.setLineNumber(self.lineNumber)
        name = self.lf[0].value.value
        symbols.directives[name] = CNameREFDRV(name, self.body)

class CNameREFDRV(object):
    def __init__(self, name, drvs):
        self.name = name
        self.drvs = drvs

    def exec(self, symbols, ref):
        symbols.setLineNumber(ref.lineNumber)
        if len(ref.lf) > 0:
            symbols.variables[ref.lf[0].value.value] = symbols.variables['PC']
        symbols.pushFields(ref.cf, ref.af)
        for drv in self.drvs:
            if drv.name in symbols.directives:
                af = symbols.eval(drv.af)
                d = Directive(drv.lf, drv.cf, af, ref.lineNumber)
                d.exec(symbols)
            else:
                drv.exec(symbols)
        symbols.popFields()

class NumFunc(object):
    def __init__(self):
        self.name = 'num'

    def eval(self, symbols, args):
        return len(args[0])

class Symbols(object):
    def __init__(self):
        self.object_code = None
        self.directives = {}
        self.functions = {'num':NumFunc()}
        self.variables = {}
        self.variables['PC'] = 0
        self.stack = []
        self.fieldMap = {'lf':None, 'cf':None, 'af':None}
    
    def setLineNumber(self, lineNumber):
        self.variables['lineNumber'] = lineNumber

    def setAF(self, af):
        if isinstance(af, int):
            taf = Tree(Terminal('(', '('))
            taf.add(af)
            af = taf
        self.fieldMap['af'] = af

    def pushFields(self, cf, af):
        ecf = self.eval(cf)
        eaf = self.eval(af)
        self.stack.append(self.fieldMap['cf'])
        self.stack.append(self.fieldMap['af'])
        self.fieldMap['cf'] = ecf
        self.fieldMap['af'] = eaf
        self.variables['cf'] = ecf
        self.variables['af'] = eaf

    def popFields(self):
        af = self.stack.pop()
        cf = self.stack.pop()
        self.fieldMap['af'] = af
        self.fieldMap['cf'] = cf
        self.variables['cf'] = cf
        self.variables['af'] = af

    def eval(self, tree):
        if isinstance(tree, int):
            return tree
        if isinstance(tree.value, int):
            return tree.value
        if tree.value == None:
            return None
        if tree.value.name == '"':
            return tree
        if tree.value.name == '(':
            result = Tree(Terminal('(', '('))
            result.children = [self.eval(x) for x in tree.children]
            while isinstance(result, Tree) and len(result) == 1:
                result = result[0]
            return result
        return self.evalPrim(tree)
    
    def evalPrim(self, tree):
        op = tree.value.name
        if op == 'INT':
            return tree.value.value
        if op == 'ID':
            name = tree.value.value
            # Forward reference hack
            if name not in self.variables:
                self.variables[name] = 0
            return self.variables[name]
        if op == 'call':
            fname = tree.value.value
            args = [self.eval(e) for e in tree.children]
            if fname in self.fieldMap:
                result = self.fieldMap[fname]
                for arg in args:
                    result = result[arg]
                x = self.eval(result)
                return x
            func = self.functions[fname]
            return func.eval(self, args)
        if op == 'NEG':
            return -self.evalPrim(tree[0])
        if op == '+':
            return self.evalPrim(tree[0]) + self.evalPrim(tree[1])
        if op == '-':
            return self.evalPrim(tree[0]) - self.evalPrim(tree[1])
        if op == '*':
            return self.evalPrim(tree[0]) * self.evalPrim(tree[1])
        if op == '/':
            return int(self.evalPrim(tree[0]) / self.evalPrim(tree[1]))
        if op == '%':
            return self.evalPrim(tree[0]) % self.evalPrim(tree[1])
        if op == '&':
            return self.evalPrim(tree[0]) & self.evalPrim(tree[1])
        if op == '|':
            return self.evalPrim(tree[0]) | self.evalPrim(tree[1])
        if op == '^':
            return self.evalPrim(tree[0]) ^ self.evalPrim(tree[1])
        if op == '<':
            return int(self.evalPrim(tree[0]) < self.evalPrim(tree[1]))
        if op == '<=':
            return int(self.evalPrim(tree[0]) <= self.evalPrim(tree[1]))
        if op == '==':
            return int(self.evalPrim(tree[0]) == self.evalPrim(tree[1]))
        if op == '>=':
            return int(self.evalPrim(tree[0]) >= self.evalPrim(tree[1]))
        if op == '>':
            return int(self.evalPrim(tree[0]) > self.evalPrim(tree[1]))
        if op == '>>':
            return int(self.evalPrim(tree[0]) >> self.evalPrim(tree[1]))
        if op == '<<':
            return int(self.evalPrim(tree[0]) << self.evalPrim(tree[1]))
        raise APError(f'Unexpected operator {op}', self.variables['lineNumber'])
