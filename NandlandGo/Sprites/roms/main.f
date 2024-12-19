
var dy;
var sprite_num = 0x400;
var sprite_x = 0x401;
var sprite_y = 0x402;
var leds_on_off = 0xc00;
var leds_numeric = 0xc01;
var switches = 0xc02;
var vertical_int = 0xc03;

def main {
    dy = 5;
    sprite_num = 1;
    sprite_x = 50;
    sprite_y = 30;
    print sprite_num;
    loop {
        if sprite_x < 500 {
            sprite_x = sprite_x + 1;
        } else {
            sprite_x = 50;
        }
        sprite_y = sprite_y + dy;
        if sprite_y < 400 {
        } else {
            dy = -5;
            if sprite_num != 0 {
                sprite_num = sprite_num + 1;
            } else {
                sprite_num = 1;
            }
        }
        if sprite_y < 30 {
            dy = 5;
            if sprite_num != 0 {
                sprite_num = sprite_num + 1;
            } else {
                sprite_num = 1;
            }
        }
        while 1 - vertical_int {
        }
        vertical_int = 0;
        leds_on_off = leds_on_off + 1;
        leds_numeric = sprite_x;
    }
    print 99;
}
