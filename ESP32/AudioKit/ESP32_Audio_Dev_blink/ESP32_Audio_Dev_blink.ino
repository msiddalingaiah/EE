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
  Serial.begin(115200);
}

// double magnitude: ~4.58 us, 218 kHz
// float magnitude:  ~334 ns, 2.99 MHz
void loop() {
  uint32_t i;
  float a = 3.0, b = 4.0, result, t, phi = 0.0;

  while (1) {
    digitalWrite(19, HIGH);  
    digitalWrite(22, LOW); 
    delay(200);
    t = micros();
    for (i=0; i<2990000; i++) {
      result = sqrt(a*a + b*b);
    }
    t = micros() - t;
    t /= 1e6;
    a += 1.0;
    b += 1.0;
    Serial.print("Time: ");
    Serial.println(t);
    Serial.print("result: ");
    Serial.println(result);
    // for (float dt = 0; dt < 50; dt += 1) {
    //   float Sine1 = 100 * sin((M_PI * dt / 25) + phi);
    //   Serial.println(Sine1);
    // }
    phi += M_PI/10.0;
    digitalWrite(19, LOW);  
    digitalWrite(22, HIGH);
    delay(500); 
  }
}
