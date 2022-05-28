
# A trivial traffic light microcode assembler
# line -> [<label>:] led-list, action
# led-list -> [color] ['|' color]*
# action -> count <N> | untilzero <label> | goto <label>
# color -> 'red' | 'yellow' | 'green'

ucode = '''
top: , count 8
wait4: green, untilzero wait4
, count 4
wait3: yellow, untilzero wait3
, count 8
wait2: red, untilzero wait2
, goto top
'''

led_names = {'LED5': 1, 'green': 2, 'yellow': 4, 'red': 8, '': 0}

# [19:16 LEDs] | [12:12 loadc] | [11:8 fe, pup, s1, s0] | [7:0 Di/constant]
def create_rom(ucode, fname):
    lines = ucode.split('\n')
    labels = {}
    pc = 0
    for line in lines:
        if len(line):
            cols = line.split(':')
            label = ''
            if len(cols) == 2:
                label, line = cols
            label = label.strip()
            if len(label):
                labels[label] = pc
            pc += 1
    mcode = ['01b00' for i in range(16)]
    pc = 0
    for line in lines:
        if len(line):
            word = 0x00800
            cols = line.split(':')
            line = cols[-1]
            leds, action = line.split(',')
            leds = leds.split('|')
            ln = 0
            for led in leds:
                ln |= led_names[led.strip()]
            word |= ln << 16
            action = action.strip()
            key, value = action.split(' ')
            if key == 'count':
                word |= 1 << 12
                word |= int(value)
            elif key == 'untilzero':
                word |= labels[value]
            elif key == 'goto':
                word |= labels[value]
                word |= 3 << 8
                word |= 1 << 12
            mcode[pc] = f'{word:05x}'
            pc += 1

    with open(fname, 'wt') as f:
        for mc in mcode:
            f.write(f'{mc}\n')

if __name__ == '__main__':
    create_rom(ucode, 'roms/traffic_rom.txt')
