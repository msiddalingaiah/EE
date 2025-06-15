
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
#define PIN_ADC       PIN_PA7         // audio input pin

#define pinDisable(x)     (&PORTA.PIN0CTRL)[x] |= PORT_ISC_INPUT_DISABLE_gc

volatile uint8_t int_trigger = 0;
volatile uint32_t count = 0;
volatile uint16_t adc_voltage;

// Init timer/counter B (TCB)
void TCB_init(void) {
  TCB0.CTRLA   = TCB_CLKSEL_CLKDIV1_gc  // set prescaler
               | TCB_ENABLE_bm;         // enable timer
  TCB0.CTRLB   = TCB_CNTMODE_INT_gc;    // set timer to periodic interrupt mode
  TCB0.CCMP    = 1000;                  // set TOP value (200 == 100kHz, 2000 == 10kHz)
  TCB0.INTCTRL = TCB_CAPT_bm;           // enable interrupt
}

// Init analog to digital converter (ADC)
void ADC_init(void) {
  pinDisable(PIN_ADC);                          // disable digital input buffer
  ADC0.CTRLA   = ADC_ENABLE_bm;                 // enable ADC
  ADC0.CTRLC   = ADC_SAMPCAP_bm                 // select sample capacitance
               | ADC_REFSEL_VDDREF_gc           // set Vdd as reference
               | ADC_PRESC_DIV16_gc;            // set prescaler -> 1.25 MHz ADC clock
  ADC0.MUXPOS  = ADC_MUXPOS_AIN7_gc;            // set the input pin
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

// Timer interrupt service routine
ISR(TCB0_INT_vect) {
  ADC0.COMMAND = ADC_STCONV_bm;
  DAC0.DATA = adc_voltage >> 2;
  VPORTA.OUT |=  4;
  adc_voltage = ADC0.RES;
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
