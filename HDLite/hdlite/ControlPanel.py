
import tkinter as tk
from tkinter import ttk
from tkinter import messagebox

from hdlite import Simulation as sim

TIMER_TICK_MS = 500

class ClockFrame(ttk.LabelFrame):
    def __init__(self, container, resetSignal, clockSignal, sigframes):
        super().__init__(container, text='Reset/Clock')
        self.resetSignal = resetSignal
        self.clockSignal = clockSignal
        self.sigFrames = sigframes
        self.clockCount = 0
        ttk.Button(self, text='Reset', command=self.reset).grid(column=0, row=0, padx=5, pady=2)
        self.startBtn = ttk.Button(self, text='Start', command=self.start)
        self.startBtn.grid(column=0, row=1, padx=5, pady=2)
        self.stopBtn = ttk.Button(self, text='Stop', command=self.stop, state='disabled')
        self.stopBtn.grid(column=0, row=2, padx=5, pady=2)
        self.stepBtn = ttk.Button(self, text='Step', command=self.step)
        self.stepBtn.grid(column=0, row=3, padx=5, pady=2)
        self.stepNBtn = ttk.Button(self, text='Step #', command=self.stepn)
        self.stepNBtn.grid(column=0, row=4, padx=5, pady=2)
        self.nClocks = ttk.Entry(self, width=5)
        self.nClocks.focus()
        self.nClocks.grid(column=1, row=4, padx=5, pady=2, sticky=tk.W)

    def timer(self):
        self.winfo_toplevel().after(TIMER_TICK_MS, self.timer)
        if self.clockCount > 0:
            self.clockCount -= 1
            self.step()
        else:
            self.stepBtn.configure(state='normal')
            self.stepNBtn.configure(state='normal')
            self.startBtn.configure(state='normal')
            self.stopBtn.configure(state='disabled')
            self.nClocks.configure(state='normal')

    def updateAll(self):
        for f in self.sigFrames:
            f.doUpdate()

    def reset(self):
        self.resetSignal <<= 1
        sim.simulation.runUntilStable()
        self.resetSignal <<= 0
        sim.simulation.runUntilStable()
        self.updateAll()

    def start(self):
        self.clockCount = 100000
        self.stepBtn.configure(state='disabled')
        self.stepNBtn.configure(state='disabled')
        self.startBtn.configure(state='disabled')
        self.stopBtn.configure(state='normal')
        self.nClocks.configure(state='disabled')

    def stop(self):
        self.clockCount = 0

    def step(self):
        self.clockSignal <<= 1
        sim.simulation.runUntilStable()
        self.clockSignal <<= 0
        sim.simulation.runUntilStable()
        self.updateAll()

    def stepn(self):
        try:
            n = int(self.nClocks.get())
            while n > 0:
                self.clockSignal <<= 1
                sim.simulation.runUntilStable()
                self.clockSignal <<= 0
                sim.simulation.runUntilStable()
                n -= 1
            self.updateAll()
        except ValueError as e:
            msg = f'Count is not an int: {self.nClocks.get()}'
            messagebox.showwarning(title='Input Error', message=msg)

class SignalIndicator(tk.Canvas):
    def __init__(self, container, signal, w=15, h=15):
        super().__init__(container, width=w, height=h)
        self.signal = signal

    def doUpdate(self):
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

    def doUpdate(self):
        self.config(text = self.format % self.signal.getIntValue())

class OutputFrame(ttk.LabelFrame):
    def __init__(self, container, title, outputs):
        super().__init__(container, text=title)
        self.outputs = outputs
        self.indicators = {}
        fontName = ('Consolas', 14)
        # TTF font from https://www.fontspace.com/digital-7-font-f7087
        row = 0
        for name, signal in outputs.items():
            tk.Label(self, text=name, font=fontName).grid(column=0, row=row, sticky=tk.E)
            ind = None
            if len(signal) == 1:
                ind = self.indicators[name] = SignalIndicator(self, signal)
            else:
                ind = self.indicators[name] = VectorIndicator(self, signal)
            ind.grid(column=1, row=row, sticky=tk.W)
            row += 1
        self.doUpdate()

    def doUpdate(self):
        for name, signal in self.outputs.items():
            self.indicators[name].doUpdate()

class App(tk.Tk):
    def __init__(self, resetSignal, clockSignal, internal, outputs):
        super().__init__()
        self.title('Control Panel')
        #self.geometry('500x200')
        self.resizable(True, True)
        # windows only (remove the minimize/maximize button)
        self.attributes('-toolwindow', True)
        self.columnconfigure(0, weight=1)
        self.columnconfigure(1, weight=2)
        self.columnconfigure(2, weight=2)
        ifr = OutputFrame(self, 'Internal Signals', internal)
        of = OutputFrame(self, 'Output Signals', outputs)
        cf = ClockFrame(self, resetSignal, clockSignal, [ifr, of])
        cf.grid(column=0, row=0, padx=2, pady=2)
        ifr.grid(column=1, row=0, padx=2, pady=2, sticky=tk.N)
        of.grid(column=2, row=0, padx=2, pady=2, sticky=tk.N)
        # Assert reset after 500 ms
        self.after(500, cf.reset)
        self.after(TIMER_TICK_MS, cf.timer)