# EE
A collection of engineering resources

# License

MIT License

Copyright (c) 2025 Madhu Siddalingaiah

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

# Subprojects

Several FPGA board examples based on [IceStorm](https://clifford.at/icestorm) open source tools are included. For example:

* [ICEBlink40](https://www.latticesemi.com/iceblink40-hx1k)
* [AlchitryCu](https://www.sparkfun.com/products/16526)
* [Nandland Go Board](https://nandland.com/the-go-board/) 
* [iceFUN](https://www.robotshop.com/products/icefun-fpga-board) [schematic](https://cdn.robotshop.com/media/d/dev/rb-dev-99/pdf/icefun-fpga-board-schematic.pdf) [github](https://github.com/devantech/iceFUN)

## Github Personal Access Token

* Create fine grained [personal access token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token)
 * Select repos
 * Repository Permissions | Contents  | Read and write

```
$ cd $docs/github/EE
$ git remote set-url origin https://<USER>:<TOKEN>@github.com/<USER>/EE.git
```
