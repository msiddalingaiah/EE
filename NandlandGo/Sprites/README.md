
# VGA Sprites

A lightweight sprite renderer in Verilog. Design is similar to coin-op video arcade machines during the
[golden age of arcade video](https://en.wikipedia.org/wiki/Golden_age_of_arcade_video_games). Resolution is limited to 256 x 200
pixels driving a 640 x 480 60 Hz VGA monitor. Each visible pixel is 2 x 2 VGA pixels to cover most of the screen.

## Components

- VGA sync signal generator
- Sprite renderer: 32 x 30 fixed playfield sprites, 16 motion sprites
- Lightweight, high speed 16-bit CPU optimized small code size
    - Each instruction is exactly one byte, one clock cycle, 25 MHz clock

## Current status:

- Single sprite rendering with dual port ping-pong buffer
- Playfield rendering, needs alignment
- StackMachine 16-bit CPU
- 558/1280 LCs, 5/16 RAM blocks, Timing estimate: 11.09 ns (90.17 MHz)

Next steps:

- Motion sprite RAM

## Sprite Rendering

- TBD

## CPU

16-bit stack machine with internal call stack. Stack is 4 16-bit words deep, labeled S3-S0, with S0 as top of stack.
The following auxilliary registers are included to improve performance:

- PC: 12 bit program counter

Instruction Set

Each instruction is exactly 1 byte, single cycle execution. Instruction format:

- 00000000: No operation

- 1ddddddd: Load immediate, sign extended

OPS_LOAD
- 00000001: Load unsigned 8-bit value from memory using S0 as address: S0[7:0] = mem[S0]
- 00000010: Load signed 8-bit value from memory using S0 as address: S0[15:0] = sign extend(mem[S0])
- 00000011: Duplicate: S0 = S0
- 00000100: Load from PC: S0[15:0] = { 4'b000, PC } (unsigned)

OPS_STORE
- 00010000: Store to memory: mem[S0] = S1

OPS_ALU
- 00100000: ADD: S0 = S1 + S0
- 00100001: SUB: S0 = S1 - S0
- 00100010: AND: S0 = S1 & S0
- 00100011: OR: S0 = S1 | S0
- 00100100: XOR: S0 = S1 ^ S0
- 00100101: LT: S0 = S1 < S0
- 00100110: EQ: S0 = S1 == S0
- 00100111: NEQ: S0 = S1 != S0
- 00101000: GT: S0 = S1 > S0
- 00100101: Shift left 1: S0 = S0 << 1
- 00100110: Logical shift right 1: S0 = S0 >> 1
- 00100111: Arithmetic shift right 1: S0 = S0 >> 1, S0[15] = S0[14]
- 00101000: Negate: S0 = -S0

OPS_JUMP
- 00110000: Unconditional jump: PC = S0
- 00110001: Jump if zero: PC = S0 if S1 == 0
- 00110010: Jump if not zero: PC = S0 if S1 != 0
- 00110011: Call: stack.push(PC), PC = S0
- 00110100: Return: PC = stack.pop()

OPS_SYS
- 01000000: Halt
- 01000001: Print (TestBench only)

## Resource Utilization

The code runs on a [Nandland Go Board](https://nandland.com/the-go-board/) with a Lattice [ICE40](https://www.latticesemi.com/ice40) HX1K FPGA containing 1280 LCs and 16 4kbit RAM blocks (8 kBytes total).

- 1 4kbit BRAM (4096 bits): 32 8x8 pixel sprite table, 4 colors/pixel (2 bits each)
- 1 4kbit BRAM (4096 bits): 2048 x 2 bit dual port line RAM, ping-pong buffer stores next line for motion objects
    - Two buffers, 1024 x 2 bits each, alternate each line
- 2 4kbit BRAM (4096 bits): 32 x 30 fixed playfield sprites
- 1 4kbit BRAM 16 motion sprites
- 4 4kbit BRAM (2 kB): CPU instruction ROM
- 2 4kbit BRAM (1 kB): CPU RAM
- 13/16 BRAMs used

## Simulation

[Icarus Verilog](http://iverilog.icarus.com/) is used for simulation, specifically, [Icarus Verilog for Windows](https://bleyer.org/icarus/). The test bench is in contained in TestBench.v. Run simulation using:

```
make test
```

## Synthesis

[Project IceStorm](https://clifford.at/icestorm) open source tools were used for synthesis. Synthesis is known to work on [WSL](https://docs.microsoft.com/en-us/windows/wsl/install) Ubuntu running on Windows 11. The following command will perform synthesis and generate the bitstream suitable for programming the FPGA:

```
make
```

USB support on WSL requires [usbipd](https://devblogs.microsoft.com/commandline/connecting-usb-devices-to-wsl) for device programming in WSL. To connect a USB device to WSL Ubuntu, the following commands must be executed from an **administrator*- command prompt on Windows:

```
usbipd wsl list
```
```
usbipd wsl attach --busid <busid>
```

Where busid is the appropriate USB bus ID from the wsl list command above. The device should appear in WSL Ubuntu using ```lsusb```.

Alternatively, Windows Powershell in VSCode is quicker. Open a Windows Powershell terminal in VSCode using Terminal | New Terminal and run the following command to list available usb devices:

```
.\usb.bat
```

Then run ```usbipd wsl attach --busid <busid>``` as described above.

The board can be programmed from WSL Ubuntu using:

```
make prog
```
