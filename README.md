# Pressure-switch calibrator — Wokwi prototype

This project tests the complete user interface before hardware is purchased:

- 20x4 LCD shows pressure, DUT switch voltage/state, main supply, sensor supply, 5V rail, and pump command.
- LOW/OFF/HIGH calibration mode (two simulated switches: both off = OFF).
- DUT switch changes between about 0V and 5V and sounds the buzzer on either transition.
- The custom `ads1115-sim` I2C chip behaves like the subset of an ADS1115 used by the Arduino library.

## Run it

1. Create a new **Arduino Uno** project at Wokwi.
2. Copy `sketch.ino`, `diagram.json`, and `libraries.txt` into the project.
3. Add a custom C chip named **ads1115-sim**. Replace the generated chip files with `ads1115-sim.chip.c` and `ads1115-sim.chip.json`.
4. Start the simulation. Click the custom ADS1115 chip to open its four voltage sliders.

## Simulator controls

| Control | Meaning | Useful setting |
|---|---|---:|
| AIN0 | Taber 0–5V pressure signal | `pressure/full-scale × 5V` |
| AIN1 | Main 28V after 68k/10k divider | 3.59V = about 28.0V |
| AIN2 | Sensor supply after 68k/10k divider | 3.59V = about 28.0V |
| AIN3 | Pump's 0–5V speed command | 0–5V |
| DUT switch | Pressure-switch contact | toggles Arduino A0 between 0V and 5V |
| LOW/HIGH | Calibration mode | both off = OFF; both on = ERR |

## One required correction before real use

In `sketch.ino`, change `TABER_FULL_SCALE_BAR` to the exact full-scale pressure of your actual Taber M2911 transmitter. The photos identify the family and 0–5V output, but not the calibrated pressure range. An incorrect value gives an incorrect pressure display and trip pressure.

## Real hardware wiring represented by the simulation

| From | To |
|---|---|
| Regulated 5V | Arduino 5V, LCD VCC, ADS1115 VDD, pot outer pin, DUT COM |
| Common GND | Arduino/LCD/ADS GND, buzzer negative, divider bottoms, other pot outer pin |
| Arduino A4/A5 | LCD and ADS1115 SDA/SCL in parallel |
| Taber 0–5V output | ADS1115 A0 |
| Main 28V through 68k/10k divider | ADS1115 A1 |
| Sensor 28V through 68k/10k divider | ADS1115 A2 |
| Pump-command pot wiper | pump white command wire and ADS1115 A3 |
| DUT NO contact | 10k pulldown node, then 1k series resistor to Arduino A0 |
| Arduino D8 | buzzer positive (only if buzzer current is <=15mA) |
| 3-position selector common | GND; LOW to D3; HIGH to D4 |

The real DUT circuit is **5V -> COM, NO -> sense node, 10k from sense node to GND, 1k from sense node to A0**. Wokwi's slide switch directly selects 0V/5V only to make the contact easy to simulate.

## Minimal electronics BOM

- 1 Arduino Uno R3-compatible board
- 1 ADS1115 breakout
- 1 20x4 I2C LCD (0x27)
- 1 28V-to-5V regulated buck converter, at least 1A
- 1 10k linear potentiometer
- 1 LOW-OFF-HIGH SPDT center-off selector
- 1 5V buzzer drawing <=15mA (otherwise add a transistor driver)
- 2 × 68k 1% resistors and 2 × 10k 1% resistors for the two 28V dividers
- 1 × 10k resistor and 1 × 1k resistor for DUT sensing
- 1 small screw-terminal prototyping PCB, terminal blocks, ferrules, wire, enclosure
- Recommended: 3A pump fuse and 1A electronics fuse

No relay is required for this measurement-only version.
