
var x;
var sprite_num = 0x400;
var sprite_x = 0x401;
var sprite_y = 0x402;
var leds_on_off = 0xc00;
var leds_numeric = 0xc01;
var switches = 0xc02;
var vertical_int = 0xc03;

def main {
    leds_on_off = 1;
    sprite_num = 7;
    x = 0;
    sprite_x = 50;
    sprite_y = 30;
    print sprite_num;
    print (sprite_x + 1) & 0x7f;
    print sprite_y;
    loop {
        x = x + 1;
        x = x & 0x7f;
        sprite_y = x + 30;
        while 1 - vertical_int {
        }
        vertical_int = 0;
        leds_on_off = leds_on_off + 1;
        leds_numeric = leds_numeric + 1;
    }
    print 99;
}
