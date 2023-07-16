# EE
A collection of engineering resources

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
