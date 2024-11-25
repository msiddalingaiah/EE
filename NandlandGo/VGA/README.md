
# VGA Pong

A lightweight [VGA](https://vanhunteradams.com/DE1/VGA_Driver/Driver.html) [Pong](https://www.reddit.com/r/EngineeringPorn/comments/ul49zt/the_original_pong_video_game_had_no_code_and_was/) game in Verilog.

The code runs on a [Nandland Go Board](https://nandland.com/the-go-board/), using about 1006 of the 1280 available logic cells in a Lattice iCE40HX1K. The two 7-segment LED displays are used for left/right score keeping.

The code is not optimized in any way, written mostly for readability. It's requires a 25 MHz clock (VGA spec is 25.175 MHz). Max design frequency is 64 MHz.

## Simulation

[Icarus Verilog](http://iverilog.icarus.com/) is used for simulation, specifically, [Icarus Verilog for Windows](https://bleyer.org/icarus/). The test bench is in contained in TestBench.v. Run simulation using:

```
make test
```

## Synthesis

[Project IceStorm](https://clifford.at/icestorm) open source tools were used for synthesis. Synthesis is known to work on [WSL](https://docs.microsoft.com/en-us/windows/wsl/install) Ubuntu running on Windows 11. The following command will build and program the FPGA:

```
make prog
```

USB support on WSL requires [usbipd](https://devblogs.microsoft.com/commandline/connecting-usb-devices-to-wsl) for device programming in WSL. To connect a USB device to WSL Ubuntu, the following commands must be executed from an **administrator** command prompt on Windows:

```
usbipd wsl list
```
```
usbipd wsl attach --busid <busid>
```

Where busid is the appropriate USB bus ID from the wsl list command above. The device should appear in WSL Ubuntu using ```lsusb```.

The board can be programmed from WSL Ubuntu using:

```
make sudo-prog
```
