
# VGA Sprites

A lightweight sprite renderer in Verilog. Design is similar to coin-op video arcade machines during the
[golden age of arcade video](https://en.wikipedia.org/wiki/Golden_age_of_arcade_video_games). Resolution is limited to 256 x 200
pixels driving a 640 x 480 60 Hz VGA monitor. Each visible pixel is 2 x 2 VGA pixels to cover most of the screen.

Current status:

* Single sprite rendering with dual port ping-pong buffer functional

Next steps:

* Playfield/motion sprite RAM
* CPU
* Assembler
* Compiler

## Components

* VGA sync signal generator
* Sprite renderer: 32 x 30 fixed playfield sprites, 16 motion sprites
* Lightweight, high speed 16-bit CPU optimized small code size
 * Each instruction is exactly one byte, 25 MHz clock

## CPU

Registers:

* A: 16 bits
* B: 16 bits
* PC: 16 bits
* SP: 16 bits
* flags: 8 bits: 0 0 0 0 V C M Z
 * Overflow, carry, minus, zero

Instruction Set

Each instruction is exactly 1 byte. Instruction format:

* No operation: 00000000
* Load A immediate, sign extended: 1ddddddd, A = 16 bit sign extended (ddddddd)
* Load A from memory with offset: 001ddddd, A[7:0] = mem[B + ddddd] no sign extension
* Load A from register/stack: 0100xxxx
 * 01000000: A = B
 * 01000001: A = PC
 * 01000010: A = SP
 * 01000011: A = flags
 * 01000100: A = { A[7:0], A[15:8] } (swap high/low bytes)
 * 01000101: Load A from stack (pop): A[7:0] = mem[++SP] no sign extension
* ALU operations: 0101xxxx (up to 16)
 * 01010000: A = A + B
 * 01010001: A = A - B
 * 01010010: A = A & B
 * 01010011: A = A | B
 * 01010100: A = A ^ B
 * 01010101: A = A << 1 (left shift)
 * 01010110: A = A >> 1 (right shift)
* Store A to memory with offset: 011ddddd, mem[B + ddddd] = A
* Store A to register/stack: 0110xxxx
 * 01100000: B = A
 * 01100001: Store A to stack (push): mem[SP--] = A[7:0]
 * 01100010: SP = A
 * 01100011: flags = A
* Branch: 0111xxxx (up to 16)
 * 01110000: PC = A (unconditional branch)
 * 01110001: SP = PC, PC = A (branch and link)
 * 01110010: PC = A if Z (branch if zero)
 * 01110011: PC = A if ~Z (branch if not zero)
 * 01110100: PC = A if M (branch if negative)
 * 01110101: PC = A if ~M (branch if positive)

## Resource Utilization

The code runs on a [Nandland Go Board](https://nandland.com/the-go-board/) with a Lattice [ICE40](https://www.latticesemi.com/ice40) HX1K FPGA containing 1280 LCs and 16 4kbit RAM blocks (8 kBytes total).

* 1 4kbit BRAM (4096 bits): 32 8x8 pixel sprite table, 4 colors/pixel (2 bits each)
* 1 4kbit BRAM (4096 bits): 2048 x 2 bit dual port line RAM, ping-pong buffer stores next line for motion objects
 * Two bufferes, 1024 x 2 bits each, alternate each line
* 1 4kbit BRAM (4096 bits): 32 x 30 fixed playfield sprites and 16 motion sprites
* 8 4kbit BRAM (4 kB): CPU instruction ROM
* 2 4kbit BRAM (1 kB): CPU RAM
* 13/16 BRAMs used

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

USB support on WSL requires [usbipd](https://devblogs.microsoft.com/commandline/connecting-usb-devices-to-wsl) for device programming in WSL. To connect a USB device to WSL Ubuntu, the following commands must be executed from an **administrator** command prompt on Windows:

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
