
import tkinter as tk
from tkinter import ttk
from tkinter import messagebox
from tkinter import IntVar

from hdlite import Simulation as sim

TIMER_TICK_MS = 500

class ClockFrame(ttk.LabelFrame):
    def __init__(self, container, resetSignal, clockSignal, inputFrame, sigframes):
        super().__init__(container, text='Reset/Clock')
        self.resetSignal = resetSignal
        self.clockSignal = clockSignal
        self.inputFrame = inputFrame
        self.sigFrames = sigframes
        self.running = False
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
        self.nClocks.insert(0, '1')
        self.nClocks.focus()
        self.nClocks.grid(column=1, row=4, padx=5, pady=2, sticky=tk.W)

    def timer(self):
        self.winfo_toplevel().after(TIMER_TICK_MS, self.timer)
        if self.running:
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
        self.inputFrame.setValues()
        self.resetSignal <<= 1
        sim.simulation.runUntilStable()
        self.resetSignal <<= 0
        sim.simulation.runUntilStable()
        self.updateAll()

    def start(self):
        self.inputFrame.setValues()
        self.running = True
        self.stepBtn.configure(state='disabled')
        self.stepNBtn.configure(state='disabled')
        self.startBtn.configure(state='disabled')
        self.stopBtn.configure(state='normal')
        self.nClocks.configure(state='disabled')

    def stop(self):
        self.running = False

    def step(self):
        self.inputFrame.setValues()
        self.clockSignal <<= 1
        sim.simulation.runUntilStable()
        self.clockSignal <<= 0
        sim.simulation.runUntilStable()
        self.updateAll()

    def stepn(self):
        try:
            self.inputFrame.setValues()
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
        # TrueType font from https://www.fontspace.com/digital-7-font-f7087
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
        self.indicators = []
        fontName = ('Consolas', 14)
        row = 0
        for name, signal in outputs.items():
            tk.Label(self, text=name, font=fontName).grid(column=0, row=row, sticky=tk.E)
            ind = None
            if len(signal) == 1:
                ind = SignalIndicator(self, signal)
            else:
                ind = VectorIndicator(self, signal)
            self.indicators.append(ind)
            ind.grid(column=1, row=row, sticky=tk.W)
            row += 1
        self.doUpdate()

    def doUpdate(self):
        for ind in self.indicators:
            ind.doUpdate()

class SignalControl(tk.Checkbutton):
    def __init__(self, container, signal):
        self.value = IntVar()
        super().__init__(container, variable=self.value, onvalue=1,offvalue=0, command=self.action)
        self.signal = signal
        self.deselect()
        self.container = container

    def action(self):
        self.container.doUpdate()

    def setValue(self):
        self.signal <<= self.value.get()

class VectorControl(ttk.Entry):
    def __init__(self, container, signal):
        super().__init__(container, width=(len(signal)+7)>>2)
        self.signal = signal
        self.container = container
        self.insert(0, '0')
        self.bind('<Return>', self.action)

    def action(self, event):
        self.container.doUpdate()

    def setValue(self):
        try:
            self.signal <<= int(self.get(), 16)
        except ValueError as e:
            msg = f'Value is not an int: {self.get()}'
            messagebox.showwarning(title='Input Error', message=msg)

class InputFrame(ttk.LabelFrame):
    def __init__(self, container, inputs, sigframes):
        super().__init__(container, text="Input Signals")
        self.controls = []
        self.sigFrames = sigframes
        fontName = ('Consolas', 14)
        row = 0
        for name, signal in inputs.items():
            tk.Label(self, text=name, font=fontName).grid(column=0, row=row, sticky=tk.E)
            control = None
            if len(signal) == 1:
                control = SignalControl(self, signal)
            else:
                control = VectorControl(self, signal)
            self.controls.append(control)
            control.grid(column=1, row=row, sticky=tk.W)
            row += 1

    def setValues(self):
        for ind in self.controls:
            ind.setValue()

    def doUpdate(self):
        self.setValues()
        sim.simulation.runUntilStable()
        for f in self.sigFrames:
            f.doUpdate()

class App(tk.Tk):
    def __init__(self, resetSignal, clockSignal, inputs, internal, outputs):
        super().__init__()
        self.title('Control Panel')
        #self.geometry('500x200')
        self.resizable(True, True)
        # windows only (remove the minimize/maximize button)
        self.attributes('-toolwindow', True)
        self.columnconfigure(0, weight=1)
        self.columnconfigure(1, weight=2)
        self.columnconfigure(2, weight=2)
        self.columnconfigure(3, weight=2)
        internFrame = OutputFrame(self, 'Internal Signals', internal)
        outputFrame = OutputFrame(self, 'Output Signals', outputs)
        inputFrame = InputFrame(self, inputs, [internFrame, outputFrame])
        clockFrame = ClockFrame(self, resetSignal, clockSignal, inputFrame, [internFrame, outputFrame])
        clockFrame.grid(column=0, row=0, padx=2, pady=2)
        inputFrame.grid(column=1, row=0, padx=2, pady=2, sticky=tk.N)
        internFrame.grid(column=2, row=0, padx=2, pady=2, sticky=tk.N)
        outputFrame.grid(column=3, row=0, padx=3, pady=2, sticky=tk.N)
        # Assert reset after 500 ms
        self.after(500, clockFrame.reset)
        self.after(TIMER_TICK_MS, clockFrame.timer)