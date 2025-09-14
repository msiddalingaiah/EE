
/*

tinyAVR® 1-series
ATtiny412
Tested with Arduino IDE 2.3.2
Tested with Arduino 1.8.11

Install megaTinyCore https://github.com/SpenceKonde/megaTinyCore/blob/master/Installation.md

USB-FTDI ------------ ATtiny412

TX  -- 2.2k --+
RX  ----------+------ UPDI
+5V ----------------- VDD
GND ----------------- GND
GND --|<-- 1k ------- PA1

1. Select board: Tools | [megaTinyCore] | ATtiny412...
2. Select chip: Tools | Chip | ATtiny412
3. Select port: Tools | Port | COM7 (Launch Arduino after USB plugged in)
4. Select programmer: Tools | Programmer | SerialUPDI - SLOW: 57600 baud
5. Tools | Clock "20 MHz Internal"

Sketch | Upload Using Programmer

 */

#define LED  PIN_PA1
#define TRIG PIN_PA2

#define PIN_DAC       PIN_PA6         // audio output pin
#define PIN_ADC_I     PIN_PA3         // In phase input pin
#define PIN_ADC_Q     PIN_PA7         // Quadrature input pin

#define pinDisable(x)     (&PORTA.PIN0CTRL)[x] |= PORT_ISC_INPUT_DISABLE_gc

volatile uint8_t int_trigger = 0;
volatile uint32_t count = 0;
volatile uint16_t adc_voltage;

// Init timer/counter B (TCB)
void TCB_init(void) {
  TCB0.CTRLA   = TCB_CLKSEL_CLKDIV1_gc  // set prescaler
               | TCB_ENABLE_bm;         // enable timer
  TCB0.CTRLB   = TCB_CNTMODE_INT_gc;    // set timer to periodic interrupt mode
  TCB0.CCMP    = 2000;                  // set TOP value (200 == 100kHz, 2000 == 10kHz)
  TCB0.INTCTRL = TCB_CAPT_bm;           // enable interrupt
}

// Init analog to digital converter (ADC)
void ADC_init(void) {
  pinDisable(PIN_ADC_I);                          // disable digital input buffer
  pinDisable(PIN_ADC_Q);                          // disable digital input buffer
  ADC0.CTRLA   = ADC_ENABLE_bm;                 // enable ADC
  ADC0.CTRLB   = ADC_SAMPNUM_ACC1_gc;
  ADC0.CTRLC   = ADC_SAMPCAP_bm                 // select sample capacitance
               | ADC_REFSEL_VDDREF_gc           // set Vdd as reference
               | ADC_PRESC_DIV8_gc;            // set ADC clock = CLK_PER/8. This doesn't seem right, but results in 12.6 us conversion time
  ADC0.MUXPOS  = ADC_MUXPOS_AIN3_gc;            // set the input pin
}

// Init digital to analog converter (DAC)
void DAC_init(void) {
  pinDisable(PIN_DAC);                          // disable digital input buffer
  VREF_CTRLA |= VREF_DAC0REFSEL_4V34_gc;        // set DAC reference to 4.3V
  DAC0.CTRLA  = DAC_ENABLE_bm                   // enable DAC
              | DAC_OUTEN_bm;                   // enable output buffer
}

void setup() {
  count = 0;
  pinMode(LED, OUTPUT);
  pinMode(TRIG, OUTPUT);
  DAC_init();
  ADC_init();
  TCB_init();
  sei();
}

// Timing varies a *lot*
int32_t isqrt(int32_t y) {
  int32_t L = 0;
  int32_t M;
  int32_t R = y + 1;

  while (L != R - 1) {
    M = (L + R) / 2;
    if (M * M <= y) L = M;
    else R = M;
  }
  return L;
}

// Timer interrupt service routine
// 25 us with pipelined ADC read and no square root
// 704 us with pipelined ADC read and square root
ISR(TCB0_INT_vect) {
  int32_t adc_I, adc_Q;
  VPORTA.OUT |=  4;
  adc_I = ADC0.RES;
  adc_I -= 512;
  adc_Q = analogRead(PIN_ADC_Q);
  adc_Q -= 512;
  // Pipeline ADC read to save another 12 us
  ADC0.MUXPOS  = ADC_MUXPOS_AIN3_gc;            // set ADC input to I
  ADC0.COMMAND = ADC_STCONV_bm;
  DAC0.DATA = (adc_I*adc_I + adc_Q*adc_Q) >> 12;
  // DAC0.DATA = isqrt(adc_I*adc_I + adc_Q*adc_Q) >> 2;
  VPORTA.OUT &= ~(4);
  TCB0.INTFLAGS = TCB_CAPT_bm;                  // clear interrupt flag
}

// ADC result ready interrupt service routine
ISR(ADC0_RESRDY_vect) {
  // VPORTA.OUT |=  4;
  // DAC0.DATA = ADC0.RESL;
  // VPORTA.OUT &= ~(4);
}

// the loop function runs over and over again forever
void loop() {
}
