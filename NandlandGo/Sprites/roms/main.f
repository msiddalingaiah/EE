
var int_count;
var x_y;
var sprite_num = 0x400;
var sprite_x = 0x401;
var sprite_y = 0x402;
var leds_on_off = 0xc00;
var leds_numeric = 0xc01;
var switches = 0xc02;
var vertical_int = 0xc03;

def main {
    int_count = 0;
    x_y = 0;
    sprite_num = 1;
    sprite_x = 50;
    sprite_y = 30;
    print sprite_num;
    loop {
        if switches & 1 {
            if x_y {
                sprite_x = sprite_x + 1;
            } else {
                sprite_y = sprite_y + 1;
            }
        }
        if switches & 2 {
            if x_y {
                sprite_x = sprite_x - 1;
            } else {
                sprite_y = sprite_y - 1;
            }
        }
        if int_count < 1 {
            if switches & 4 {
                sprite_num = sprite_num + 1;
            }
            if switches & 8 {
                x_y = 1 - x_y;
            }
        }
        while 1 - vertical_int {
        }
        vertical_int = 0;
        leds_numeric = x_y;
        leds_on_off = leds_on_off + 1;
        if int_count < 15 {
            int_count = int_count + 1;
        } else {
            int_count = 0;
        }
    }
    print 99;
}
