
var sprite_num = 0x400;
var sprite_x = 0x401;
var sprite_y = 0x402;
var leds_on_off = 0xc00;
var leds_numeric = 0xc01;
var switches = 0xc02;
var vertical_int = 0xc03;

# Memory corruption?
var x_frac;
var dv_x_frac;
var y_frac;
var dv_y_frac;
var g = 1;

def main {
    x_frac = 0;
    dv_x_frac = 1;
    y_frac = 0;
    dv_y_frac = 1;
    sprite_num = 13;
    sprite_x = 50;
    sprite_y = 30;           
    print sprite_num;
    loop {
        dv_y_frac = dv_y_frac + g;
        if switches & 2 {
            x_frac = 0;
            y_frac = 0;
            dv_x_frac = 1;
            dv_y_frac = 1;
            sprite_num = 13;
            sprite_x = 50;
            sprite_y = 30;           
        }
        if sprite_x < 500 {
            x_frac = x_frac + dv_x_frac;
            sprite_x = (x_frac >> 6) + sprite_x;
            x_frac = x_frac & 0x3f;
        }
        if sprite_y < 400 {
            if switches & 8 {
                dv_y_frac = dv_y_frac - 2;
                sprite_num = 14;
            } else {
                sprite_num = 13;
            }
            if switches & 4 {
                # This decreases Y for some reason...
                dv_x_frac = dv_x_frac - 1;
            }
            if switches & 1 {
                # This increases Y for some reason...
                dv_x_frac = dv_x_frac + 1;
            }
            y_frac = y_frac + dv_y_frac;
            sprite_y = (y_frac >> 6) + sprite_y;
            y_frac = y_frac & 0x3f;
        } else {
            g = 0;
            dv_x_frac = 0;
            if dv_y_frac > 128 {
                sprite_num = 30;
            } else {
                sprite_num = 15;
            }
        }
        while 1 - vertical_int {
        }
        vertical_int = 0;
        leds_numeric = dv_y_frac;
        leds_on_off = leds_on_off + 1;
    }
    print 99;
}
