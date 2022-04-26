
from hdlite import Signal as sig
from hdlite.Component import *

# Work in progress...

# pp 3-181

class Sigma7CPU(Component):
    def __init__(self, reset, clock, C, S):
        super().init(self)
        self.reset = reset
        self.clock = clock
        self.C = C
        self.S = S
        self.O = sig.Vector(7)
        

    def run(self):
        OU0 <<= NO1 & NO2 & NO3
        OU1 <<= NO1 & NO2 & O3
        OU2 <<= NO1 & O2 & NO3
        OU3 = NO1 & O2 & O3
        OU4 = O1 & NO2 & NO3
        OU5 = O1 & NO2O3
        OU6 = O1 & O2 & NO3
        OU7 = O1 & O2 & O3
        OL0 = NO4 & NO5 & NO6 & NO7
        OL1 = NO4 & NO5 & NO6 & NO7
        OL2 = NO4 & NO5 & O6 & NO7
        OL3 = NO4 & NO5 & O6 & O7
        OL4 = NO4 & O5 & NO6 & NO7
        OL5 = NO4 & O5 & NO6 & O7
        OL6 = NO4 & O5 & O6 & NO7
        OL7 = NO4 & O5 & O6 & O7
        OL8 = O4 & NO5 & NO6 & NO7
        OL9 = O4 & NO5 & NO6 & O7
        OLA = O4 & NO5 & O6 & NO7
        OLB = O4 & NO5 & O6 & O7
        OLC = O4 & O5 & NO6 & NO7
        OLD = O4 & O5 & NO6 & O7
        OLE = O4 & O5 & O6 & NO7
        OLF = O4 & O5 & O6 & O7

        FUAD = OU1 & OL0
        FUANLZ = OU4 & OL4
        FUAWM = OU6 & OL6

        FUBAL = OU6 & OLA
        FUCB = OU7 & OL1
        FUCI = OU2 & OL1
        FUCLR = OU3 & OL9
        FUCS = OU4 & OL5
        FUCVS = FACV & NO7
        FUEOR = OU4 & OL8
        FUEXU = OU6 & OU7
        FULAD = OU1 & OLB
        FULCD = OU1 & OLA
        FULD = OU1 & OL2
        FUINT = OU6 & OLB
        FULRP = OU2 & OLF
        FULS = OU4 & OLA
        FUMMC = OU6 & OLF
        FUMTB = OU7 & OL3
        FUMTH = OU5 & OL3
        FUMTW = OU3 & OL3
        FUSTD = OU1 & OL5
        FUSTH = OU5 & OL5
        FUOR = OU4 & OL9
        FUSTS = OU4 & OL7
        FUWAIT = OU2 & OLE
        FUXW = OU4 & OL6