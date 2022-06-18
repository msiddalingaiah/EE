
from Directives import *
import traceback

if __name__ == '__main__':
    try:
        ap = AP('traffic.ap')
        ap.save('../iCEBlink40/traffic/roms/traffic_rom.txt')
    except Exception as e:
        print(e)
        #traceback.print_exc()
