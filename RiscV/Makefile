
test: tb.vvp main.hex
	vvp tb.vvp

tb.vvp: *.v
	iverilog -o tb.vvp tb.v

main.hex: boot.s main.c
	riscv64-unknown-elf-gcc -march=rv32g -mabi=ilp32 -static -mcmodel=medany -fvisibility=hidden -nostdlib -nostartfiles -Tboot0.ld boot.s main.c -o main.bin

	#riscv64-unknown-elf-objcopy -O ihex main.bin main.hex
	riscv64-unknown-elf-objcopy -O verilog --verilog-data-width=1 main.bin main.hex

clean:
	rm main.hex main.bin tb.vvp

disasm:
	riscv64-unknown-elf-gcc -march=rv32g -mabi=ilp32 -static -mcmodel=medany -S main.c
