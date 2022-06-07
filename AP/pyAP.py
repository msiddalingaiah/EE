
from Directives import *

if __name__ == '__main__':
    symbols = Symbols()
    with open('traffic.ap') as f:
        lines = f.readlines()
    
    parser = DParser(DScanner(lines))
    tree = parser.parse()
    for t in tree.children:
        t.value.exec(symbols)

    # Second pass to resolve forward references
    symbols.variables['PC'] = 0
    symbols.object_code = []
    for t in tree.children:
        t.value.exec(symbols)

    with open('../iCEBlink40/traffic/roms/traffic_rom.txt', 'wt') as f:
        f.write('\n'.join(symbols.object_code) + '\n')
