
import tkinter as tk
from tkinter import ttk
import sys

from hdlite import Simulation as sim

# Work in progress...

class InputFrameExample(ttk.Frame):
    def __init__(self, container):
        super().__init__(container)
        self.__create_widgets()

    def __create_widgets(self):
        # Find what
        ttk.Label(self, text='Find what:').grid(column=0, row=0, sticky=tk.W)
        keyword = ttk.Entry(self, width=30)
        keyword.focus()
        keyword.grid(column=1, row=0, sticky=tk.W)

        # Replace with:
        ttk.Label(self, text='Replace with:').grid(
            column=0, row=1, sticky=tk.W)
        replacement = ttk.Entry(self, width=30)
        replacement.grid(column=1, row=1, sticky=tk.W)

        # Match Case checkbox
        match_case = tk.StringVar()
        match_case_check = ttk.Checkbutton(
            self,
            text='Match case',
            variable=match_case,
            command=lambda: print(match_case.get()))
        match_case_check.grid(column=0, row=2, sticky=tk.W)

        # Wrap Around checkbox
        wrap_around = tk.StringVar()
        wrap_around_check = ttk.Checkbutton(
            self,
            variable=wrap_around,
            text='Wrap around',
            command=lambda: print(wrap_around.get()))
        wrap_around_check.grid(column=0, row=3, sticky=tk.W)

        for widget in self.winfo_children():
            widget.grid(padx=0, pady=5)


class ButtonFrame(ttk.Frame):
    def __init__(self, container):
        super().__init__(container)
        # setup the grid layout manager
        #self.columnconfigure(0, weight=1)

        self.__create_widgets()

    def __create_widgets(self):
        ttk.Button(self, text='Find Next').grid(column=0, row=0)
        ttk.Button(self, text='Replace').grid(column=0, row=1)
        ttk.Button(self, text='Replace All').grid(column=0, row=2)
        ttk.Button(self, text='Cancel', command=lambda: sys.exit()).grid(column=0, row=3)

        for widget in self.winfo_children():
            widget.grid(padx=0, pady=3)

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

class OutputFrame(ttk.Frame):
    def __init__(self, container, outputs):
        super().__init__(container)
        self.outputs = outputs
        self.labels = {}
        row = 0
        for name, signal in outputs.items():
            ttk.Label(self, text=name).grid(column=0, row=row, sticky=tk.E)
            label = ttk.Label(self, text='')
            label.grid(column=1, row=row, sticky=tk.E)
            self.labels[name] = label
            row += 1
        self.update()

    def update(self):
        for name, signal in self.outputs.items():
            label = self.labels[name]
            label.config(text = f'{signal.getIntValue()}')

class App(tk.Tk):
    def __init__(self, resetSignal, clockSignal, outputs):
        super().__init__()
        self.title('Control Panel')
        self.geometry('400x150')
        self.resizable(0, 0)
        # windows only (remove the minimize/maximize button)
        #self.attributes('-toolwindow', True)
        self.columnconfigure(0, weight=1)
        self.columnconfigure(1, weight=2)
        self.columnconfigure(2, weight=2)
        of = OutputFrame(self, outputs)
        cf = ClockFrame(self, resetSignal, clockSignal, of)
        cf.grid(column=0, row=0)
        of.grid(column=2, row=0, sticky=tk.W)

    def __create_widgets(self):
        # layout on the root window
        self.columnconfigure(0, weight=4)
        self.columnconfigure(1, weight=1)

        # create the input frame
        input_frame = InputFrameExample(self)
        input_frame.grid(column=0, row=0)

        # create the button frame
        button_frame = ButtonFrame(self)
        button_frame.grid(column=1, row=0)


if __name__ == "__main__":
    app = App()
    app.mainloop()
