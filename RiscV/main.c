
void write_uart(int c);
void write_uart_str(char *p, int n);
void halt();

void main() {
    unsigned char *cp = (unsigned char *) "abcd\n";
    write_uart(cp[0]);
    write_uart(cp[1]);
    write_uart(cp[2]);
    write_uart(cp[3]);
    write_uart(cp[4]);
    halt();
    for(;;);
}

void write_uart(int c) {
    unsigned int *p = (unsigned int *) 0xf0000010;
    *p = c;
}

// FIXME: this doesn't work yet...
void write_uart_str(char *p, int n) {
    for (int i=0; i<n; i+=1) {
        write_uart(p[i]);
    }
}

void halt() {
    unsigned int *p = (unsigned int *) 0xf0000020;
    *p = 0xc0de;
}
