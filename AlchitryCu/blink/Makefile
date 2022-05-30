
PROJ = blinker

# Alchitry Cu
PIN_DEF = ice40_alchitry_cu.pcf
DEVICE = hx8k
PACKAGE = cb132

# Comment QUIET for detailed output
#QUIET = -q

all: $(PROJ).rpt $(PROJ).bin

%.json: %.v Makefile *.v
	yosys $(QUIET) -p 'synth_ice40 -top $(PROJ) -json $@' $<

%.asc: $(PIN_DEF) %.json
	nextpnr-ice40 $(QUIET) --$(DEVICE) --package $(PACKAGE) --json $(word 2,$^) --pcf $(PIN_DEF) --asc $@

%.bin: %.asc
	icepack $< $@

%.rpt: %.asc
	icetime -d $(DEVICE) -mtr $@ $<

prog: $(PROJ).bin
	iceprog $<

sudo-prog: $(PROJ).bin
	@echo 'Executing prog as root!!!'
	sudo iceprog $<

clean:
	rm $(PROJ).json $(PROJ).asc $(PROJ).bin $(PROJ).rpt CPU6TestBench

.PHONY: all prog clean
