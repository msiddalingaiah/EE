
void write_uart(int c);
void write_uart_str(char *p, int n);

void main() {
    write_uart('H');
    write_uart('i');
    write_uart('!');
    write_uart('\n');
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
