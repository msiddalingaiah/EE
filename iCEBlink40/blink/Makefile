
PROJ = blinker
PIN_DEF =  iceblink40_vq100.pcf
DEVICE = hx1k
PACKAGE = vq100

all: $(PROJ).rpt $(PROJ).bin

%.json: %.v
	yosys -p 'synth_ice40 -top $(PROJ) -json $@' $<

%.asc: $(PIN_DEF) %.json
	nextpnr-ice40 --$(DEVICE) --package $(PACKAGE) --json $(word 2,$^) --pcf $(PIN_DEF) --asc $@

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
