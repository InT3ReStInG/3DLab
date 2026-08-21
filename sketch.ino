#include <Wire.h>
#include <Adafruit_ADS1X15.h>
#include <LiquidCrystal_I2C.h>

Adafruit_ADS1115 ads;
LiquidCrystal_I2C lcd(0x27, 20, 4);

// Taber M2911 identified by its label: 0-150 PSIA, 0-5V output.
// PSIA is absolute pressure, so subtract local atmospheric pressure to
// display the gauge pressure used to calibrate the pressure switches.
const float TABER_FULL_SCALE_PSIA = 150.0;
const float ATMOSPHERIC_PSIA = 14.696; // standard atmosphere; field-zero below
const float PSI_TO_BAR = 0.0689476;
const float DIVIDER_RATIO = 7.8; // (68k + 10k) / 10k

const byte DUT_SENSE_PIN = A0;
const byte MODE_PIN = 3; // LOW=0V, HIGH=5V
const byte BUZZER_PIN = 8;

float pressureBar, pressurePsia, vin28, sensor28, commandV, switchV;
bool previousClosed = false;
unsigned long tripMessageUntil = 0;
float lastTripPressure = 0;

float adsVoltage(uint8_t channel) {
  int16_t raw = ads.readADC_SingleEnded(channel);
  return ads.computeVolts(raw);
}

void printFixedLine(byte row, const String &text) {
  lcd.setCursor(0, row);
  String line = text;
  while (line.length() < 20) line += ' ';
  lcd.print(line.substring(0, 20));
}

String modeName() {
  return digitalRead(MODE_PIN) == LOW ? "LOW" : "HIGH";
}

void setup() {
  pinMode(MODE_PIN, INPUT_PULLUP);
  pinMode(BUZZER_PIN, OUTPUT);
  Serial.begin(115200);
  Wire.begin();
  lcd.init();
  lcd.backlight();
  printFixedLine(0, "Pressure Calibrator");
  printFixedLine(1, "Starting...");

  if (!ads.begin(0x48)) {
    printFixedLine(2, "ADS1115 NOT FOUND");
    while (true) delay(100);
  }
  ads.setGain(GAIN_TWOTHIRDS); // +/-6.144V range: safe for 0..5V inputs
  delay(500);
}

void loop() {
  float pressureSignalV = adsVoltage(0);
  vin28 = adsVoltage(1) * DIVIDER_RATIO;
  sensor28 = adsVoltage(2) * DIVIDER_RATIO;
  commandV = adsVoltage(3);
  switchV = analogRead(DUT_SENSE_PIN) * (5.0 / 1023.0);
  pressurePsia = pressureSignalV / 5.0 * TABER_FULL_SCALE_PSIA;
  pressureBar = (pressurePsia - ATMOSPHERIC_PSIA) * PSI_TO_BAR;
  // Small negative readings can occur from tolerance/noise at atmosphere.
  if (pressureBar < 0.0) pressureBar = 0.0;

  bool closed = switchV > 2.5;
  if (closed != previousClosed) {
    lastTripPressure = pressureBar;
    tripMessageUntil = millis() + 1800;
    tone(BUZZER_PIN, closed ? 2200 : 1400, 350);
    previousClosed = closed;
  }

  if (millis() < tripMessageUntil) {
    printFixedLine(0, closed ? "*** SWITCH CLOSED **" : "*** SWITCH OPEN ***");
    printFixedLine(1, "Trip P:" + String(lastTripPressure, 2) + " bar");
  } else {
    printFixedLine(0, "MODE:" + modeName() + " P:" + String(pressureBar, 2) + "bar");
    printFixedLine(1, "SW:" + String(switchV, 2) + "V " + (closed ? "CLOSED" : "OPEN"));
  }
  printFixedLine(2, "VIN:" + String(vin28, 1) + " S:" + String(sensor28, 1) + "V");
  printFixedLine(3, "5V:5.00 CMD:" + String(commandV, 2) + "V");

  Serial.print("P="); Serial.print(pressureBar, 3);
  Serial.print("bar(g) ABS="); Serial.print(pressurePsia, 2);
  Serial.print("psia SW="); Serial.print(switchV, 2);
  Serial.print("V VIN="); Serial.print(vin28, 1);
  Serial.print("V SENSOR="); Serial.print(sensor28, 1);
  Serial.print("V CMD="); Serial.println(commandV, 2);
  delay(120);
}
