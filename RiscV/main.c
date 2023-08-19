
void write_uart(int c);
void write_uart_str(char *p);
void halt();
void test_compare();
void test_alu(int a, int b);

void main() {
    unsigned char *p = (unsigned char *) "Hello World!\n";
    write_uart_str(p);
    test_compare();
    test_alu(4, 6);
    halt();
    for(;;);
}

void write_uart(int c) {
    unsigned int *p = (unsigned int *) 0xf0000010;
    *p = c;
}

void write_uart_str(char *p) {
    char c;
    while ((c = *p++) != 0) write_uart(c);
}

void halt() {
    unsigned int *p = (unsigned int *) 0xf0000020;
    *p = 0xc0de;
}

void test_alu(int a, int b) {
    if (a+3 == 7) {
        write_uart('.');
    } else {
        write_uart('F');
    }
    if (a-7 == -3) {
        write_uart('.');
    } else {
        write_uart('F');
    }
    if (a+b == 10) {
        write_uart('.');
    } else {
        write_uart('F');
    }
    if (a-b == -2) {
        write_uart('.');
    } else {
        write_uart('F');
    }
    write_uart('\n');
}

void test_compare() {
    int a = 4;
    int b = 4;
    int c = 5;
    int d = 6;
    if (a == b) {
        write_uart('.');
    } else {
        write_uart('F');
    }
    if (a == c) {
        write_uart('F');
    } else {
        write_uart('.');
    }
    if (a == 5) {
        write_uart('F');
    } else {
        write_uart('.');
    }
    if (a == 4) {
        write_uart('.');
    } else {
        write_uart('F');
    }
    if (a <= c) {
        write_uart('.');
    } else {
        write_uart('F');
    }
    if (a <= d) {
        write_uart('.');
    } else {
        write_uart('F');
    }
    if (a > c) {
        write_uart('F');
    } else {
        write_uart('.');
    }
    write_uart('\n');
}
