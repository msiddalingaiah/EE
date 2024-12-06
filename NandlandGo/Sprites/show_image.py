
import numpy as np

import matplotlib.pyplot as plt
import matplotlib.colors

cmaps = []
cmaps.append(matplotlib.colors.ListedColormap(["#000000", "#FFFFC0", "#FF0000", "#00FF00"], name='from_list', N=None))
cmaps.append(matplotlib.colors.ListedColormap(["#000000", "#FFC000", "#00FFC0", "#FF00C0"], name='from_list', N=None))
cmaps.append(matplotlib.colors.ListedColormap(["#000000", "#00FFC0", "#FFFF00", "#FF0000"], name='from_list', N=None))
cmaps.append(matplotlib.colors.ListedColormap(["#000000", "#00FFC0", "#0000FF", "#FFC000"], name='from_list', N=None))

cmaps.append(matplotlib.colors.ListedColormap(["#000000", "#FFFF00", "#FF00FF", "#00FFC0"], name='from_list', N=None))
cmaps.append(matplotlib.colors.ListedColormap(["#000000", "#0000FF", "#FFC000", "#00FFFF"], name='from_list', N=None))
cmaps.append(matplotlib.colors.ListedColormap(["#000000", "#00FF00", "#FF00FF", "#FFFF00"], name='from_list', N=None))
cmaps.append(matplotlib.colors.ListedColormap(["#000000", "#FFFF00", "#FF0000", "#00FFFF"], name='from_list', N=None))

def show_image(data):
    plt.figure(figsize=(7, 3))
    plt.imshow(data, cmap=cmaps[0])
    plt.show()

if __name__ == '__main__':
    with open('vcd/image.txt') as f:
        data = []
        lines = f.readlines()
        for line in lines:
            word32 = int(line.strip(), 16)
            for i in range(0, 32, 2):
                data.append((word32 >> 30-i) & 3)
        rows = int(len(data)/256)
        data = data[0:rows*256]
        print(len(data), len(data)/256)
        show_image(np.array(data).reshape(rows, 256))
