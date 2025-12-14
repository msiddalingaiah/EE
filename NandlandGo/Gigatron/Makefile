
# bin\oss-cad-suite\environment.ps1

# Top level module
PROJ = Gigatron

# Nandland Go Board
PIN_DEF = nandland_go.pcf
DEVICE = hx1k
PACKAGE = vq100
FREQ_MHz = 25

all: simulation

synthesis: $(PROJ).rpt $(PROJ).bin

%.json: %.v Makefile *.v roms/rom.txt
	yosys -q -p 'synth_ice40 -top $(PROJ) -json $@' $<

%.asc: $(PIN_DEF) %.json
	nextpnr-ice40 -q -l vcd/log.txt --freq $(FREQ_MHz) $(QUIET) --$(DEVICE) --package $(PACKAGE) --json $(word 2,$^) --pcf $(PIN_DEF) --asc $@

%.bin: %.asc
	icepack $< $@

%.rpt: %.asc
	icetime -d $(DEVICE) -mtr $@ $<

prog: $(PROJ).bin
	iceprog $<

sudo-prog: $(PROJ).bin
	iceprog $<

simulation: TestBench roms/rom.txt
	vvp vcd/TestBench

TestBench: *.v
	iverilog -g2009 -o vcd/TestBench TestBench.v

clean:
	rm $(PROJ).json $(PROJ).asc $(PROJ).bin $(PROJ).rpt vcd/TestBench

.PHONY: all prog clean
