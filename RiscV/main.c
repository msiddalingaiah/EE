
void write_uart(int c);
void write_uart_str(char *p, int n);

void main() {
    unsigned int *ip = (unsigned int *) 0x400;
    unsigned char *cp = (unsigned char *) 0x400;
    *ip = 0x0a434241;
    write_uart(cp[0]);
    write_uart(cp[1]);
    write_uart(cp[2]);
    write_uart(cp[3]);
    for(;;);
}

void write_uart(int c) {
    unsigned int *p = (unsigned int *) 0xf0000010;
    *p = c;
}

void write_uart_str(char *p, int n) {
    for (int i=0; i<n; i+=1) {
        write_uart(p[i]);
    }
}
