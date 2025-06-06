
# WSL Ubuntu Instructions
# On Windows, right-click Command Prompt | Run as Administrator
# > usbipd wsl list
# > usbipd wsl attach --busid <busid>
# <busid> is the BUS ID for "USB Serial Converter A, USB Serial Converter B"
# In Ubuntu
# $ lsusb
# ... "Future Technology Devices International, Ltd FT2232C/D/H Dual UART/FIFO IC" ...

# make
# make sudo-prog

# Top level module
PROJ = Sprites

# Nandland Go Board
PIN_DEF = nandland_go.pcf
DEVICE = hx1k
PACKAGE = vq100
FREQ_MHz = 25

all: $(PROJ).rpt $(PROJ).bin

%.json: %.v Makefile *.v roms/sprites2.py roms/sprites.txt roms/code.txt
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
	@echo 'Executing prog as root!!!'
	sudo iceprog $<

test: TestBench roms/code.txt
	vvp vcd/TestBench

TestBench: *.v
	iverilog -o vcd/TestBench TestBench.v

roms/code.txt: roms/lunar_lander.f roms/*.py
	py roms/Compiler.py roms/lunar_lander.f roms/code.txt

clean:
	rm $(PROJ).json $(PROJ).asc $(PROJ).bin $(PROJ).rpt vcd/TestBench

.PHONY: all prog clean
