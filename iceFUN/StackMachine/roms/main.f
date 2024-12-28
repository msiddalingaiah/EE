
ioport led_row: 0xc000;
ioport led_column: 0xc001;
ioport slow_int: 0xc003;

var int_count;
var direction;

var i, j, k;

def main {
    print 1 + (2 + (3 + (4 + 5)));
    i = 11;
    j = 21;
    k = 31;
    print i;
    print j;
    print k;
    direction = 1;
    int_count = 8;
    led_row = 0x1;
    led_column = 0x1;
    print led_row;
    print led_column;
    loop {
        while 1 - slow_int {
        }
        slow_int = 0;
        if direction {
            if led_row {
                led_row = led_row << 1;
            } else {
                led_row = 0x80;
                direction = 0;
            }
        } else {
            if led_row {
                led_row = led_row >> 1;
            } else {
                led_row = 0x01;
                direction = 1;
            }
        }
        if int_count != 0 {
            int_count = int_count - 1;
        } else {
            int_count = 8;
            led_column = led_column << 1;
        }
        if led_column & 0xf {
        } else {
            led_column = 1;
        }
    }
    print 99;
}
