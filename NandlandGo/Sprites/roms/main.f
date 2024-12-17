
var i;
var j;
var sprite_num = 0x400;
var leds_on_off = 0xc00;
var leds_numeric = 0xc01;
var switches = 0xc02;
var vertical_int = 0xc03;

def main {
    i = 0;
    while 1 {
        leds_numeric = i;
        i = i + 1;
        while 1 - vertical_int {
        }
        vertical_int = 0;
    }
}
