
import tkinter as tk
from tkinter import ttk
import sys

from hdlite import Simulation as sim
from hdlite import Signal as sig

class ClockFrame(ttk.Frame):
    def __init__(self, container, resetSignal, clockSignal, outFrame):
        super().__init__(container)
        self.resetSignal = resetSignal
        self.clockSignal = clockSignal
        self.outFrame = outFrame
        ttk.Button(self, text='Reset', command=self.reset).grid(column=0, row=0, padx=5, pady=2)
        ttk.Button(self, text='Start').grid(column=0, row=1, padx=5, pady=2)
        ttk.Button(self, text='Stop').grid(column=0, row=2, padx=5, pady=2)
        ttk.Button(self, text='Step', command=self.step).grid(column=0, row=3, padx=5, pady=2)
        ttk.Button(self, text='Step #').grid(column=0, row=4, padx=5, pady=2)
        nClocks = ttk.Entry(self, width=5)
        nClocks.focus()
        nClocks.grid(column=1, row=4, sticky=tk.W)

    def reset(self):
        self.resetSignal <<= 1
        sim.simulation.runUntilStable()
        self.resetSignal <<= 0
        sim.simulation.runUntilStable()
        self.outFrame.update()

    def step(self):
        self.clockSignal <<= 1
        sim.simulation.runUntilStable()
        self.clockSignal <<= 0
        sim.simulation.runUntilStable()
        self.outFrame.update()

class SignalIndicator(tk.Canvas):
    def __init__(self, container, signal, w=15, h=15):
        super().__init__(container, width=w, height=h)
        self.signal = signal

    def update(self):
        w = self.winfo_width()-3
        h = self.winfo_height()-3
        if self.signal.getIntValue():
            self.create_oval(2, 2, w, h, fill='#0f0', outline='#000')
        else:
            self.create_oval(2, 2, w, h, fill='#fff', outline='#000')

class VectorIndicator(tk.Label):
    def __init__(self, container, signal):
        fontValue = ('Digital-7 Mono', 20)
        super().__init__(container, text='', font=fontValue, fg='#f00')
        self.signal = signal
        digits = (len(signal)+3) >> 2
        self.format = f'%0{digits}X'

    def update(self):
        self.config(text = self.format % self.signal.getIntValue())

class OutputFrame(ttk.Frame):
    def __init__(self, container, outputs):
        super().__init__(container)
        self.outputs = outputs
        self.indicators = {}
        fontName = ('Consolas', 16)
        # TTF font from https://www.fontspace.com/digital-7-font-f7087
        row = 0
        for name, signal in outputs.items():
            tk.Label(self, text=name, font=fontName).grid(column=0, row=row, sticky=tk.E)
            ind = None
            if isinstance(signal, sig.Vector):
                ind = self.indicators[name] = VectorIndicator(self, signal)
            elif isinstance(signal, sig.Signal):
                ind = self.indicators[name] = SignalIndicator(self, signal)
            ind.grid(column=1, row=row, sticky=tk.W)
            row += 1
        self.update()

    def update(self):
        for name, signal in self.outputs.items():
            self.indicators[name].update()

class App(tk.Tk):
    def __init__(self, resetSignal, clockSignal, outputs):
        super().__init__()
        self.title('Control Panel')
        self.geometry('500x150')
        self.resizable(0, 0)
        # windows only (remove the minimize/maximize button)
        self.attributes('-toolwindow', True)
        self.columnconfigure(0, weight=1)
        self.columnconfigure(1, weight=2)
        self.columnconfigure(2, weight=2)
        of = OutputFrame(self, outputs)
        cf = ClockFrame(self, resetSignal, clockSignal, of)
        cf.grid(column=0, row=0)
        of.grid(column=2, row=0, sticky=tk.W)
