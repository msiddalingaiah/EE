
@echo off

iverilog -o bin\tb.vvp tb.v

if %ERRORLEVEL% == 0 goto :next
goto :endofscript

:next
vvp bin\tb.vvp

:endofscript
