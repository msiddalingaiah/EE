
BIN = bin

top: ${BIN}/tb.vvp ${BIN}/main.hex
	vvp ${BIN}/tb.vvp

${BIN}/tb.vvp: *.v
	iverilog -o ${BIN}/tb.vvp tb.v

${BIN}/main.hex: boot.s main.c
	riscv64-unknown-elf-gcc -march=rv32g -mabi=ilp32 -static -mcmodel=medany -fvisibility=hidden -nostdlib -nostartfiles -Tboot0.ld boot.s main.c -o ${BIN}/main.bin
	#riscv64-unknown-elf-objcopy -O ihex ${BIN}/main.bin ${BIN}/main.hex
	riscv64-unknown-elf-objcopy -O verilog --verilog-data-width=1 ${BIN}/main.bin ${BIN}/main.hex
	riscv64-unknown-elf-objdump -S ${BIN}/main.bin > main.s

clean:
	rm ${BIN}/main.hex ${BIN}/main.bin ${BIN}/tb.vvp ${BIN}/test.vvp

test: ${BIN}/test.vvp
	vvp ${BIN}/test.vvp

${BIN}/test.vvp: *.v
	iverilog -o ${BIN}/test.vvp test.v
