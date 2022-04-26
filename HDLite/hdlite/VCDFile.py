
# See https://en.wikipedia.org/wiki/Value_change_dump
# See https://zipcpu.com/blog/2017/07/31/vcd.html
class VCDFile(object):
    def __init__(self, fileName, timeScale):
        if fileName != None:
            self.file = open(fileName, 'wt')
        else:
            self.file = None
        self.tagIndex = 0
        # map tag name to signals
        self.tagMap = {}
        header = '''$date
   Date text. For example: November 11, 2009.
$end
$version
   VCD generator tool version info text.
$end
$comment
   Any comment text.
$end
$timescale %s $end''' % (timeScale)
        self.println(header)

    def addSignals(self, component, indent=0):
        moduleName = component.getName()
        tab = '    '*indent
        self.println(f'  {tab}$scope module {moduleName} $end')
        for signalName in component.signalMap:
            tag = f't{self.tagIndex:x}'
            self.tagIndex += 1
            signal = component.signalMap[signalName]
            self.tagMap[tag] = signal
            self.println(f'    {tab}$var wire {len(signal)} {tag} {moduleName}_{signalName} $end')
        for name in component.componentMap:
            self.addSignals(component.componentMap[name], indent+1)
        self.println(f'  {tab}$upscope $end')
    
    def addInitialValues(self):
        dv = '''$enddefinitions $end
$dumpvars'''
        self.println(dv)
        self.writeSignals()
        self.println('$end')
    
    def addTime(self, time):
        self.println('#%d' % time)
    
    def writeSignals(self):
        for tag in self.tagMap:
            signal = self.tagMap[tag]
            if len(signal) == 1:
                self.println('%s%s' % (str(signal.getIntValue()), tag))
            else:
                self.println('%s %s' % (bin(signal.getIntValue())[1:], tag))
    
    def println(self, line):
        if self.file != None:
            self.file.write(line + '\n')
        
    def close(self):
        if self.file != None:
            self.file.close()
