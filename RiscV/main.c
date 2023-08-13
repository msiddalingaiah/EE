
void write_uart(char c);
void write_uart_str(char *p, int n);

void main() {
    unsigned int *p = (unsigned int *) 0xf0000010;

    int sum = 3;
    for(int i=0; i<3; i+=1) {
        sum += 3;
        *p = 'A' + i;
    }
    *p = '\n';
}

void write_uart(char c) {
    unsigned char *p = (unsigned char *) 0xf0000010;
    *p = c;
}
