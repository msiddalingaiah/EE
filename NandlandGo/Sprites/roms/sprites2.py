
# Copyright (c) 2025 Madhu Siddalingaiah
# See https://github.com/msiddalingaiah/EE/blob/main/LICENSE

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

def create_row0():
    sprite_list = []
    sprite_list.append(np.zeros((8, 8)))
    sprite_list.append(np.array([
        0,0,0,0,1,0,0,0,
        0,0,0,1,0,0,0,0,
        0,0,3,3,3,3,0,0,
        0,3,3,3,3,3,3,0,
        0,3,1,1,1,1,3,0,
        0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,
    ]).reshape(8, 8))
    sprite_list.append(np.array([
        0,0,0,0,1,0,0,0,
        0,0,0,1,0,0,0,0,
        0,0,3,3,3,3,0,0,
        0,3,3,3,3,3,3,0,
        0,3,1,1,1,1,3,0,
        0,0,2,2,2,2,0,0,
        0,0,0,2,2,0,0,0,
        0,0,0,0,0,0,0,0,
    ]).reshape(8, 8))
    sprite_list.append(np.array([
        0,0,0,0,1,0,0,0,
        0,0,0,1,0,0,0,0,
        0,0,3,3,3,3,0,0,
        2,3,3,3,3,3,3,0,
        2,3,1,1,1,1,3,0,
        0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,
    ]).reshape(8, 8))
    sprite_list.append(np.array([
        0,0,0,0,1,0,0,0,
        0,0,0,1,0,0,0,0,
        0,0,3,3,3,3,0,0,
        0,3,3,3,3,3,3,2,
        0,3,1,1,1,1,3,2,
        0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,
    ]).reshape(8, 8))
    sprite_list.append(np.array([
        0,0,0,0,1,0,0,0,
        0,0,0,1,0,0,0,0,
        0,0,3,3,3,3,0,0,
        0,3,3,3,3,3,3,0,
        0,3,1,1,1,1,3,0,
        0,0,1,0,0,1,0,0,
        0,1,0,0,0,0,1,0,
        1,0,0,0,0,0,0,1,
    ]).reshape(8, 8))
    sprite_list.append(np.array([
        0,0,0,0,0,0,0,0,
        0,0,0,0,1,1,0,0,
        0,0,0,1,0,0,0,0,
        0,0,3,3,3,3,0,0,
        0,3,3,3,3,3,3,0,
        0,3,1,1,1,1,3,0,
        0,0,1,0,0,1,0,0,
        0,1,0,0,0,0,1,0,
    ]).reshape(8, 8))
    sprite_list.append(np.array([
        0,0,0,0,0,0,0,0,
        0,1,1,0,1,1,0,0,
        0,0,0,1,0,0,0,0,
        0,0,3,3,3,3,0,0,
        0,3,3,3,3,3,3,0,
        0,3,1,1,1,1,3,0,
        0,0,1,0,0,1,0,0,
        0,1,0,0,0,0,1,0,
    ]).reshape(8, 8))
    row = sprite_list[0]
    for sprite in sprite_list[1:]:
        row = np.append(row, sprite, axis=1)
    return row

def create_row1():
    sprite_list = []
    sprite_list.append(np.array([
        1,1,1,1,1,1,1,1,
        3,1,1,1,1,1,1,3,
        0,0,2,0,0,2,0,0,
        0,0,2,0,0,2,0,0,
        0,1,2,0,0,2,1,0,
        0,1,2,0,0,2,1,0,
        0,1,2,0,0,2,1,0,
        0,1,0,0,0,0,1,0,
    ]).reshape(8, 8))
    sprite_list.append(np.array([
        1,1,1,1,1,1,1,1,
        3,1,1,1,1,1,1,3,
        0,2,1,0,0,1,2,0,
        0,2,1,0,0,1,2,0,
        0,2,1,0,0,1,2,0,
        0,0,1,0,0,1,0,0,
        0,0,1,0,0,1,0,0,
        0,0,1,0,0,1,0,0,
    ]).reshape(8, 8))
    sprite_list.append(np.array([
        0,0,0,0,0,0,0,0,
        0,1,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,
    ]).reshape(8, 8))
    sprite_list.append(np.array([
        0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,
        0,0,0,0,0,1,0,0,
        0,0,0,0,0,0,0,0,
    ]).reshape(8, 8))
    sprite_list.append(np.array([
        0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,
        0,0,0,0,0,2,0,0,
        0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,
    ]).reshape(8, 8))
    sprite_list.append(np.array([
        0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,
        0,0,2,0,0,0,0,0,
        0,0,0,0,0,0,0,0,
    ]).reshape(8, 8))
    sprite_list.append(np.array([
        0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,
        3,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,
    ]).reshape(8, 8))
    sprite_list.append(np.array([
        0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,
        0,0,0,0,3,0,0,0,
        0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,
    ]).reshape(8, 8))
    for i in range(8-len(sprite_list)):
        sprite_list.append(np.zeros((8, 8)))
    row = sprite_list[0]
    for sprite in sprite_list[1:]:
        row = np.append(row, sprite, axis=1)
    return row

def create_row2():
    sprite_list = []
    sprite_list.append(np.array([
        0,1,0,3,0,0,3,0,
        2,0,3,0,1,2,0,2,
        0,0,0,0,0,0,0,0,
        3,0,0,0,0,0,3,0,
        0,1,0,0,0,0,0,3,
        0,1,0,0,0,0,1,0,
        2,0,3,0,0,0,0,3,
        0,1,0,1,2,0,2,0,
    ]).reshape(8, 8))
    sprite_list.append(np.array([
        3,0,3,1,0,2,0,3,
        0,1,0,3,3,0,3,0,
        2,3,0,2,0,1,0,2,
        3,0,2,0,0,0,3,0,
        3,3,0,0,0,0,0,1,
        0,2,0,2,0,2,3,1,
        1,0,2,0,2,0,3,2,
        2,3,0,3,3,3,1,0,
    ]).reshape(8, 8))
    sprite_list.append(np.array([
        0,0,3,2,3,0,2,0,
        0,3,3,3,3,3,2,3,
        1,3,3,3,3,3,3,1,
        1,3,3,1,1,3,3,3,
        1,3,3,1,1,3,3,1,
        1,3,3,3,3,3,3,3,
        1,3,3,2,3,3,3,1,
        0,3,0,2,0,3,0,0,
    ]).reshape(8, 8))
    for i in range(8-len(sprite_list)):
        sprite_list.append(np.zeros((8, 8)))
    row = sprite_list[0]
    for sprite in sprite_list[1:]:
        row = np.append(row, sprite, axis=1)
    return row

def create_four_rows():
    table = create_row0()
    table = np.append(table, create_row1(), axis=0)
    table = np.append(table, create_row2(), axis=0)
    row = np.zeros((8, 8))
    for i in range(7):
        row = np.append(row, np.zeros((8, 8)), axis=1)
    table = np.append(table, row, axis=0)
    return table

def show_sprite(sprites, sprite_index, offset=0):
    plt.figure(figsize=(2, 2))
    plt.imshow(get_sprite(sprites, sprite_index, offset), cmap=cmaps[0])
    plt.show()

def show_all_sprites(sprites):
    plt.figure(figsize=(8, 8))
    plt.imshow(sprites, cmap=cmaps[0])
    plt.show()

def get_sprite(sprites, sprite_index, offset=0):
    top = (sprite_index >> 3) << 3
    bottom = top + 8
    left = ((sprite_index & 0x7) << 3) + offset
    right = left + 8
    # print(top, left)
    return sprites[top:bottom, left:right]

def write_sprite(f, sprite, sprite_num):
    for row in range(8):
        for col in range(8):
            word = int(sprite[row, col])
            suffix = ''
            if row == 0 and col == 0:
                suffix = f'// Sprite {sprite_num}'
            f.write(f'{word:02b} {suffix}\n')

import sys

if __name__ == '__main__':
    if len(sys.argv) != 2:
        print('usage: python sprites2.py --show | --create')
        sys.exit(1)
    all_sprites = create_four_rows()
    if sys.argv[1] == '--show':
        show_all_sprites(all_sprites)
        sys.exit(1)
    if sys.argv[1] == '--create':
        bit_count = 0
        sprite_num = 0
        with open('roms/sprites.txt', 'wt') as f:
            word_count = 0
            for i in range(32):
                s = get_sprite(all_sprites, i)
                write_sprite(f, s, sprite_num)
                sprite_num += 1
                bit_count += 8*8*2
                word_count += 8*8
        print(f'{sprite_num} Sprites, {word_count} words, {bit_count>>3} bytes, {bit_count} bits')
        sys.exit(1)
    print('usage: python sprites2.py --show | --create')
