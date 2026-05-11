
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

/*
  SN76477 Complex Sound Generator emulation for ATtiny412
  20 MHz internal, TCA0 PWM audio on PA6, 31.25 kHz sample rate
  
  All 76477 function blocks implemented:
    1. Noise generator - 32-bit nonlinear feedback LFSR
    2. VCO - Timer-driven square wave
    3. SLF - Super low frequency oscillator  
    4. Noise filter - 1st order IIR lowpass
    5. Mixer - Logic AND of selected sources
    6. Envelope - Attack/Decay with one-shot or VCO mode
    7. Amplifier - 8-bit PWM output
  
  Configure behavior with #defines below. Compile and flash.
*/

/*
  SN76477 Complex Sound Generator for ATtiny412
  20 MHz internal clock, megaTinyCore
  Audio: 31.25 kHz PWM on PA6
  
  ATtiny412 has only TCA0 + TCB0. This sketch uses:
  TCA0 = 31.25 kHz sample rate + 8-bit PWM audio out
  TCB0 = SLF oscillator 
  VCO + Envelope = software in audio ISR
  
  Compile-time config only - no external inputs

ATtiny412 SOIC-8
Pin 1 VCC  -> 5V
Pin 2 GND  -> GND  
Pin 3 PA6  -> 1k -> 10nF -> GND  (1st RC stage)
                  -> 10k -> 10nF -> GND (2nd RC stage) -> Speaker/LM386
Pin 4 PA7  -> UPDI programming

Explosion:
ENABLE_NOISE 1, ENV_MODE 1, ATTACK_RATE 1, DECAY_RATE 60, NOISE_FILTER 200

Laser zap:
ENABLE_VCO 1, ENABLE_SLF 1, VCO_PHASE_INC 50000, SLF_PERIOD 5000, ENV_MODE 1, ATTACK_RATE 5, DECAY_RATE 30

Steam train chuff:
ENABLE_NOISE 1, ENABLE_SLF 1, SLF_PERIOD 15000, NOISE_FILTER 220, ENV_MODE 0

*/

#include <avr/io.h>
#include <avr/interrupt.h>

// ================== CONFIG ==================
// Mixer enables: 1 = source active
// #define ENABLE_VCO      1
// #define ENABLE_SLF      0
// #define ENABLE_NOISE    1

// VCO: 16-bit phase accumulator increment. ~8 Hz to 15 kHz
// Formula: Freq = (VCO_PHASE_INC * 31250) / 65536
#define VCO_PHASE_INC   40000  // ~19 kHz square

// SLF: TCB0 period. 20MHz/2 / (SLF_PERIOD+1) = freq*2
// 200000 = 0.05 Hz, 10000 = 1 Hz, 333 = 30 Hz
#define SLF_PERIOD      50000  // ~0.2 Hz

// Noise: clock divider, 1 = fastest
// #define NOISE_CLK_DIV   4

// Noise filter: 0 = none, 255 = max. IIR lowpass coeff
// #define NOISE_FILTER    180

// Envelope mode: 0=VCO only, 1=One-shot, 2=Mixer only, 3=VCO alt polarity
// #define ENV_MODE        1

// Attack/Decay: samples per step. 1 = ~32us/step, 100 = 3.2ms/step
// #define ATTACK_RATE     10     // ~0.3ms to full
// #define DECAY_RATE      80     // ~2.5ms to zero

// Fire one-shot on startup
#define TRIGGER_ONESHOT 1

// Master volume 0-255
#define VOLUME          200
// =============================================

// State variables - all volatile for ISR access
volatile uint32_t lfsr = 0xACE1ACE1;     // 32-bit noise LFSR
volatile uint8_t  noise_div = 1;
volatile uint8_t  noise_filtered = 0;

volatile uint16_t vco_phase = 0;         // VCO phase accumulator
volatile uint8_t  vco_out = 0;

volatile uint8_t  slf_out = 0;           // SLF from TCB0 ISR

volatile uint8_t  envelope = 0;          // Current envelope level 0-255
volatile uint8_t  env_state = 0;         // 0=idle, 1=attack, 2=decay
volatile uint16_t env_counter = 0;       // Timing for attack/decay

/*
 Explosion/Gunshot
 */
#define ENABLE_VCO      0   // no tone
#define ENABLE_SLF      0   // no modulation  
#define ENABLE_NOISE    1   // white noise only
#define NOISE_FILTER    200 // heavy lowpass = "boom" not "hiss"
#define NOISE_CLK_DIV   2   // fast noise

#define ENV_MODE        1   // one-shot
#define ATTACK_RATE     1   // instant attack
#define DECAY_RATE      80  // long decay = rumble

/*
 Laser zip/phaser

#define ENABLE_VCO      1   // tone on
#define ENABLE_SLF      1   // modulate it
#define ENABLE_NOISE    0   // no noise
#define VCO_FREQ        50000 // high pitch
#define SLF_FREQ        80    // SLF sweeps the VCO down

#define ENV_MODE        1   // one-shot  
#define ATTACK_RATE     2   // quick attack
#define DECAY_RATE      40  // short decay
 */

void setup() {
  // 20 MHz internal osc, no prescale
  _PROTECTED_WRITE(CLKCTRL.MCLKCTRLB, 0);
  
  // PA6 = PWM audio output
  PORTA.DIRSET = PIN6_bm;
  
  // TCA0: Single-slope PWM, 31.25 kHz
  // 20MHz / 8 / 80 = 31.25 kHz sample rate
  TCA0.SINGLE.CTRLB = TCA_SINGLE_CMP0EN_bm | TCA_SINGLE_WGMODE_SINGLESLOPE_gc;
  TCA0.SINGLE.PER = 79;
  TCA0.SINGLE.CMP0 = 0;
  TCA0.SINGLE.INTCTRL = TCA_SINGLE_OVF_bm; // ISR on overflow
  TCA0.SINGLE.CTRLA = TCA_SINGLE_CLKSEL_DIV8_gc | TCA_SINGLE_ENABLE_bm;
  
  // TCB0: SLF oscillator in periodic interrupt mode
  TCB0.CCMP = SLF_PERIOD;
  TCB0.CTRLB = TCB_CNTMODE_INT_gc;
  TCB0.INTCTRL = TCB_CAPT_bm;
  TCB0.CTRLA = TCB_CLKSEL_DIV2_gc | TCB_ENABLE_bm; // 10 MHz
  
  sei();
  
  #if TRIGGER_ONESHOT
    env_state = 1; // Start attack
  #endif
}

// TCB0 ISR: SLF oscillator
ISR(TCB0_INT_vect) {
  TCB0.INTFLAGS = TCB_CAPT_bm;
  slf_out ^= 0xFF; // Toggle for square wave
}

// TCA0 ISR: 31.25 kHz - All SN76477 blocks run here
ISR(TCA0_OVF_vect) {
  TCA0.SINGLE.INTFLAGS = TCA_SINGLE_OVF_bm;
  
  // 1. NOISE GENERATOR - 32-bit nonlinear feedback shift register
  // SN76477 used taps at 0,1,4,6 per die photos
  if(--noise_div == 0) {
    noise_div = NOISE_CLK_DIV;
    uint8_t fb = ((lfsr >> 0) ^ (lfsr >> 1) ^ (lfsr >> 4) ^ (lfsr >> 6)) & 1;
    lfsr = (lfsr >> 1) | ((uint32_t)fb << 31);
  }
  uint8_t noise_raw = (uint8_t)lfsr;
  
  // 4. NOISE FILTER - 1st order IIR: y += a*(x-y)
  int16_t diff = (int16_t)noise_raw - noise_filtered;
  noise_filtered += (diff * (256 - NOISE_FILTER)) >> 8;
  
  // 2. VCO - Phase accumulator
  uint16_t prev_phase = vco_phase;
  vco_phase += VCO_PHASE_INC;
  if(vco_phase < prev_phase) vco_out ^= 0xFF; // Overflow = toggle
  
  // 3. SLF - comes from TCB0 ISR via slf_out
  
  // 5. MIXER - 76477 uses AND logic on selected sources
  uint8_t mix = 0xFF;
  #if ENABLE_VCO
    mix &= vco_out;
  #endif
  #if ENABLE_SLF
    mix &= slf_out;
  #endif
  #if ENABLE_NOISE
    mix &= noise_filtered;
  #endif
  #if !ENABLE_VCO && !ENABLE_SLF && !ENABLE_NOISE
    mix = 0;
  #endif
  
  // 6. ENVELOPE GENERATOR - software state machine
  switch(ENV_MODE) {
    case 0: // VCO only
      envelope = 255;
      break;
      
    case 1: // One-shot attack/decay
      if(env_state == 1) { // Attack
        if(++env_counter >= ATTACK_RATE) {
          env_counter = 0;
          if(envelope < 255) envelope++;
          else env_state = 2; // -> decay
        }
      } else if(env_state == 2) { // Decay
        if(++env_counter >= DECAY_RATE) {
          env_counter = 0;
          if(envelope > 0) envelope--;
          else env_state = 0; // -> idle
        }
      }
      break;
      
    case 2: // Mixer only
      envelope = 255;
      break;
      
    case 3: // VCO alternating polarity
      envelope = vco_out ? 255 : 0;
      break;
  }
  
  // 7. AMPLIFIER - multiply + volume
  uint16_t out = ((uint16_t)mix * envelope) >> 8;
  out = (out * VOLUME) >> 8;
  
  TCA0.SINGLE.CMP0 = (uint8_t)out;
}

void triggerSound() {
  env_state = 1;  // 1 = attack phase
  envelope = 0;   // start from silence
  env_counter = 0;
}

void loop() {
  static uint32_t last = 0;
  if(millis() - last > 2000) { // every 2 sec
    last = millis();
    triggerSound();
  }
}
