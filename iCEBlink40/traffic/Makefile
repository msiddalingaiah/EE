
PROJ = Traffic
PIN_DEF =  iceblink40_vq100.pcf
DEVICE = hx1k
PACKAGE = vq100
# Comment QUIET for detailed output
QUIET = -q

all: $(PROJ).rpt $(PROJ).bin

%.json: %.v roms/traffic_rom.txt Makefile
	yosys $(QUIET) -p 'synth_ice40 -top $(PROJ) -json $@' $<

%.asc: $(PIN_DEF) %.json
	nextpnr-ice40 $(QUIET) --$(DEVICE) --package $(PACKAGE) --json $(word 2,$^) --pcf $(PIN_DEF) --asc $@

%.bin: %.asc
	icepack $< $@

%.rpt: %.asc
	icetime -d $(DEVICE) -mtr $@ $<

prog: $(PROJ).bin
	iCEburn -e -v -w  $<

sudo-prog: $(PROJ).bin
	@echo 'Executing prog as root!!!'
	sudo iCEburn -e -v -w  $<

clean:
	rm $(PROJ).json $(PROJ).asc $(PROJ).bin $(PROJ).rpt

.PHONY: all prog clean
