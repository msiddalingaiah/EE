
import sys

from hdlite import Signal as sig

from hdlite.Component import *

class IO(Component):
    def __init__(self, reset, clock, char, write):
        super().__init__()
        self.reset = reset
        self.clock = clock
        self.char = char
        self.write = write

    def run(self):
        if self.clock.isRisingEdge():
            if self.write == 1:
                value = self.char.getIntValue()
                c = chr(value)
                if c.isprintable() or c == '\n':
                    sys.stdout.write(c)
                    sys.stdout.flush()
                else:
                    print(f'({value})', end='')
