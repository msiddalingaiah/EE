
if __name__ == '__main__':
    with open('hello.hex') as f:
        lines = f.read().split()
        for x in lines:
            if x[0] != '@':
                print(x[6:8] + x[4:6] + x[2:4] + x[0:2])
