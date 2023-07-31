
default: sparkfun

sparkfun:
	riscv64-unknown-elf-gcc -march=rv32g -mabi=ilp32 -static -mcmodel=medany -fvisibility=hidden -nostdlib -nostartfiles -Tboot0.ld hello.s hello.c -o hello.bin

	#riscv64-unknown-elf-objcopy -O ihex hello.bin hello.hex
	riscv64-unknown-elf-objcopy -O verilog --verilog-data-width=4 hello.bin hello.hex
    