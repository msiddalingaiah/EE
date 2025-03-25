
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

Sketch | Upload Using Programmer

 */

 #define LED PIN_PA1

 void setup() {
   pinMode(LED, OUTPUT);
 }
 
 // the loop function runs over and over again forever
 void loop() {
   digitalWrite(LED, HIGH);
   delay(50);
   digitalWrite(LED, LOW);
   delay(50);
   digitalWrite(LED, HIGH);
   delay(50);
   digitalWrite(LED, LOW);
   delay(500);
 }
 