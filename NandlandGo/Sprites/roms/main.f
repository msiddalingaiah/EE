
var i;
var sprite_num = 0x400;
var leds_on_off = 0xc00;
var leds_numeric = 0xc01;
var switches = 0xc02;

def main {
    print 99;
    i = 3;
    while i {
        print i+2+3+4+5+6;
        i = i - 1;
    }
    print -1;
}
