
var int_count;
var sprite_num = 0x400;
var sprite_x = 0x401;
var sprite_y = 0x402;
var leds_on_off = 0xc00;
var leds_numeric = 0xc01;
var switches = 0xc02;
var vertical_int = 0xc03;

var dv_x;
var dv_y;
var g = 1;

def main {
    int_count = 0;
    dv_x = 1;
    dv_y = 1;
    sprite_num = 13;
    sprite_x = 50;
    sprite_y = 30;           
    print sprite_num;
    loop {
        if int_count < 1 {
            dv_y = dv_y + g;
            if switches & 2 {
                dv_x = 1;
                dv_y = 1;
                sprite_num = 13;
                sprite_x = 50;
                sprite_y = 30;           
            }
            if sprite_x < 500 {
                sprite_x = sprite_x + dv_x;
            }
            if sprite_y < 400 {
                if switches & 8 {
                    dv_y = dv_y - 2;
                    sprite_num = 14;
                } else {
                    sprite_num = 13;
                }
                if switches & 4 {
                    dv_x = dv_x - 1;
                }
                if switches & 1 {
                    dv_x = dv_x + 1;
                }
                sprite_y = sprite_y + dv_y;
            } else {
                g = 0;
                dv_x = 0;
                if dv_y > 5 {
                    sprite_num = 30;
                } else {
                    sprite_num = 15;
                }
            }
        }
        while 1 - vertical_int {
        }
        vertical_int = 0;
        leds_numeric = dv_y;
        leds_on_off = leds_on_off + 1;
        if int_count < 2 {
            int_count = int_count + 1;
        } else {
            int_count = 0;
        }
    }
    print 99;
}
