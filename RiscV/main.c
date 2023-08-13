
void write_uart(char c);
void write_uart_str(char *p, int n);

void main() {
    unsigned int *p = (unsigned int *) 0xf0000010;
    *p = 'H';
    *p = 'e';
    *p = 'l';
    *p = 'l';
    *p = 'o';
    *p = '\n';

    // int sum = 3;
    // for(int i=0; i<2; i+=1) {
    //     sum += 3;
    // }
}

void write_uart(char c) {
    unsigned char *p = (unsigned char *) 0xf0000010;
    *p = c;
}
