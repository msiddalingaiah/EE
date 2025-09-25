// Blink two red LEDs for ESP32 Audio Development Platform
// (alternates between each LED on and off every second)

/*

 Dip switches
   * IO31 - Key2
   * IO15 - CMD

 See https://espressif.github.io/esptool-js/
 Select 115200 then Connect

Detecting chip type... ESP32
Chip is ESP32-D0WD-V3 (revision 3)
Features: Wi-Fi, BT, Dual Core, 240MHz, VRef calibration in efuse, Coding Scheme None
Crystal is 40MHz

 See https://www.instructables.com/HackerBox-0079-Audio-DSP/

 1. Tools | Board | Boards Manager...
   a. Install esp32 by Espressif Systems
 2. Install CP210x driver: https://www.silabs.com/software-and-tools/usb-to-uart-bridge-vcp-drivers?tab=downloads
 3. Tools > Board > ESP32 Arduino > ESP32 Dev Module
 4. Tools > Port > COM4
 5. Sketch > Upload

 */

void setup() {
  pinMode(19, OUTPUT);
  pinMode(22, OUTPUT);
}

void loop() {
  digitalWrite(19, HIGH);  
  digitalWrite(22, LOW); 
  delay(200);
  digitalWrite(19, LOW);  
  digitalWrite(22, HIGH);
  delay(500); 
}
