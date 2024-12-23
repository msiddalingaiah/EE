
ioport led_row: 0xc00;
ioport led_column: 0xc01;
ioport slow_int: 0xc03;

var int_count;
var direction;

def main {
    direction = 1;
    led_row = 0x1;
    led_column = 0x1;
    int_count = 8;
    print led_row;
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
