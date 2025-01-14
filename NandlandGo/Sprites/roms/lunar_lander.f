
ioport sprite_num: 0x4000

# x, y are 8 bits

const X_LIMIT = 248
const Y_LIMIT = 232

# Sprites
const SPR_DESCEND = 1
const SPR_ASCEND = 2
const SPR_LEFT = 4
const SPR_RIGHT = 3
const SPR_LAND = 7
const SPR_CRASH = 17

ioport sprite_x: 0x4001
ioport sprite_y: 0x4002
ioport leds_on_off: 0xc000
ioport leds_numeric: 0xc001
ioport switches: 0xc002
ioport vertical_int: 0xc003

var x_frac, dv_x_frac
var y_frac, dv_y_frac
var gravity

def main:
    x_frac = 0
    dv_x_frac = 1
    y_frac = 0
    dv_y_frac = 1
    gravity = 1

    sprite_x = 8
    sprite_y = 8
    sprite_num = SPR_DESCEND
    loop:
        if switches & 2:
            x_frac = 0
            y_frac = 0
            dv_x_frac = 1
            dv_y_frac = 1
            sprite_num = SPR_DESCEND
            sprite_x = 8
            sprite_y = 8
        if sprite_x < X_LIMIT:
            x_frac = x_frac + dv_x_frac
            sprite_x = (x_frac >> 6) + sprite_x
            x_frac = x_frac & 0x3f
        if sprite_y < Y_LIMIT:
            dv_y_frac = dv_y_frac + gravity
            if switches & 8:
                dv_y_frac = dv_y_frac - 2
                sprite_num = SPR_ASCEND
            else:
                sprite_num = SPR_DESCEND
            if switches & 4:
                dv_x_frac = dv_x_frac - 1
                sprite_num = SPR_LEFT
            if switches & 1:
                dv_x_frac = dv_x_frac + 1
                sprite_num = SPR_RIGHT
            y_frac = y_frac + dv_y_frac
            sprite_y = (y_frac >> 6) + sprite_y
            y_frac = y_frac & 0x3f
        else:
            sprite_num = SPR_LAND
            if dv_y_frac > 32:
                sprite_num = SPR_CRASH
            if (sprite_x > 144) | (sprite_x < 128):
                sprite_num = SPR_CRASH
            if (dv_x_frac > 32) | (dv_x_frac < -32):
                sprite_num = SPR_CRASH
            dv_x_frac = 0
        while 1 - vertical_int: pass
        vertical_int = 0
        leds_numeric = dv_y_frac
        leds_on_off = leds_on_off + 1
    print 99
