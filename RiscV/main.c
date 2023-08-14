
void write_uart(int c);
//void write_uart_str(char *p, int n);

void main() {
    write_uart('0');
    write_uart('1');
    write_uart('2');
    write_uart('\n');
    for(;;);
}

void write_uart(int c) {
    unsigned int *p = (unsigned int *) 0xf0000010;
    *p = c;
}
