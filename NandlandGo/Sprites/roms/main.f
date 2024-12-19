
var x;
var dx;
var sp;
var sprite_num = 0x400;
var sprite_x = 0x401;
var sprite_y = 0x402;
var leds_on_off = 0xc00;
var leds_numeric = 0xc01;
var switches = 0xc02;
var vertical_int = 0xc03;

def main {
    if 1 != 1 {
    } else {
        print 7;
        print 8;
    }
    print 10;
    x = 30;
    dx = 5;
    leds_on_off = 1;
    sp = 7;
    sprite_num = sp;
    sprite_x = 50;
    sprite_y = 30;
    print sprite_num;
    print (sprite_x + 1) & 0x7f;
    print sprite_y;
    loop {
        if sprite_x < 500 {
            sprite_x = sprite_x + 1;
        } else {
            sprite_x = 50;
        }
        x = x + dx;
        if x < 400 {
        } else {
            dx = -5;
        }
        if x < 30 {
            dx = 5;
        }
        sprite_y = x;
        while 1 - vertical_int {
        }
        vertical_int = 0;
        leds_on_off = leds_on_off + 1;
        leds_numeric = sprite_x;
    }
    print 99;
}
