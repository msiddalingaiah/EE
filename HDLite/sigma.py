
text = '''FABC = OU6 O4 NO5 NO6
FABOX = OU6 OL3 + O1 NO3 NO4 NO5 NO6
FABR = OU6 NO4 O5 NO6
FACAL = OUO NO4 O5
FACV = OU2 O4 NO5 NO6
FADE = OU7 OU4 + OU7 NO4 O5 O6
FADIV = OU5 OLO + OU3 OL6
FADW = OU1 + OUO O4
FAFL = NO1 O3 O4 O5
FAFLD = NO1 O3 OLE
FAFLM = NO1 O3 OLF
FAFRR = OU2 OL3 + OU2 OL5 + OU1 OL5
FAFRR_1 = OU3 NO4 O5 O6 + OU4 OL7 + OU1 OLF
FAILL = OU5 O4 O5 + NO1 O3 OL4 + OU0 NO4 NO5 NO6 + NO2 NO3 OL3 + O1 NO3 OL2 + OU5 O4 NO6 O7 + OU5 O5 NO6 NO7 + OU1 NO4 O5 O6 + NO1 NO3 O4 O5 O6 + OU2 NO4 O5 O6 + IA NO3 NO4 NO5
FAIM = NO3 NO4 NO5
FAIO = OU4 O4 O5 + OU6 OLE
FAMDSE = FAMUL + FADIV + FASH + FAFL + SDIS
FAMDSF_D = FADIV + FAFLD
FAMUL = OU5 OL7 + OU3 OLT + OU2 OL3
FANIMP = NO1 O3 O4 O5 NFPOPTION + OU7 O4 NDEOPTION + OU7 NO4 O5 O6 NDEOPTION + FUEBS NIA NDEOPTION
FAPRIV = NO3 O4 O5
FAPSD = OU0 O4 O5 O6
FARWD = OU6 O4 O5 O6
FAS1 = NO1 O3 OLS
FAS2 = OUI OL8 + OUI OL1
FAS3 = OUI NO5 NOG NO7
FAS6 = OU4 NO4 O5 O7 + OUH OLA
FAS7 = O2 O3 OL3 + O1 O3 OL3
FAS8 = OU3 OL3 + OU6 OL6
FAS9 = OU4 OL6 + OU4 O4 NO5 NO6 + OU4 O4 NO5 O7
FAS10 = OU3 OLB OU5 OLB
FAS11 = NO1 O2 OL1 + O1 O3 OL1
FAS12 = NO1 02 OLO + OU3 NO5 NO6 NO7 + OU5 NO5 NO6 NO7
FAS13 = O1 O3 OL3
FAS14 = OU4 OL7 + OU1 OL5
FAS15 = OU4 OL5 + OU4 OLA
FAS16 = OU1 O4 NO5 O6 + OU1 NO5 O6 NO7
FAS17 = OUO OL2 + OU7 OLO
FAS18 = OU7 NO4 O5 NO6 + O2 O3 OL5 + O1 O3 OL5
FAS19 = OU1 O4 NO5 O6
FAS21 = FAS1O + FAS23
FAS22 = OU1 NO5 NO6 + NOI O3 OLO
FAS23 = OU5 NO5 O6 NO7 + O1 O3 OL2 + NO1 O2 OL2 + OU3 NO5 O6 NO7
FAS24 = OU6 OL6 + O2 O3 OL3 + O1 O3 OL3
FAS26 = OU3 O4 NO5 NO6
FASH = OU2 NO4 O5 NO6
FASHFL = FASH NO7
FASHFX = FASH O7
FAST_1 = OUO O4 NO5 + OU1 OL3 + OU2 OLA + OU2 OLB OU3 + NO3 NO4 O5
FAW = OU3 + NO3 NO4 O5'''

if __name__ == '__main__':
    lines = text.split('\n')
    for line in lines:
        lhs, rhs = line.split(' = ')
        #print(f'self.{lhs} = sig.Signal()')
        sums = rhs.split(' + ')
        result = []
        for sum in sums:
            prods = sum.split(' ')
            if len(prods) > 1:
                result.append('(' + ' & '.join([f'self.{x}' for x in prods]) + ')')
            else:
                result.append(f'self.{sum}')
        terms = ' | '.join(result)
        print(f'self.{lhs} <<= {terms}')