# Pressure-switch calibrator — Wokwi prototype

This project tests the complete user interface before hardware is purchased:

- 20x4 LCD shows pressure, DUT switch voltage/state, main supply, sensor supply, 5V rail, and pump command.
- One LOW/HIGH mode switch. The real build can use a LOW-OFF-HIGH center-off selector.
- A visible potentiometer raises/lowers simulated pressure and pump command.
- The DUT changes automatically between 0V and 5V at the selected trip/reset pressure and sounds the buzzer.
- The custom `ads1115-sim` I2C chip behaves like the subset of an ADS1115 used by the Arduino library.

## Run it

1. Create a new **Arduino Uno** project at Wokwi.
2. Copy `sketch.ino`, `diagram.json`, and `libraries.txt` into the project.
3. Add a custom C chip named **ads1115-sim**. Replace the generated chip files with `ads1115-sim.chip.c` and `ads1115-sim.chip.json`.
4. Start the simulation. Click the custom ADS1115 chip to open its four voltage sliders.

## Simulator controls

| Control | Meaning | Useful setting |
|---|---|---:|
| AIN1 | Main 28V after 68k/10k divider | 3.59V = about 28.0V |
| AIN2 | Sensor supply after 68k/10k divider | 3.59V = about 28.0V |
| Potentiometer | Simulated pressure and pump command | 0–5V maps to 0–3 bar |
| LOW/HIGH switch | Calibration mode | LOW trips at 0.20 bar; HIGH at 2.00 bar |
| Automatic DUT | Pressure-switch contact | LOW resets at 0.15 bar; HIGH at 1.80 bar |

## Confirmed Taber conversion

The Taber label states **0-150 PSIA**. Assuming its identified output is 0-5V:

- `absolute pressure (PSIA) = sensor voltage / 5 × 150`
- `gauge pressure (bar) = (PSIA - 14.696) × 0.0689476`
- At normal atmospheric pressure, the expected sensor output is approximately **0.490V**, not 0V.

The firmware displays **bar(g)** for pressure-switch calibration and prints both bar(g) and PSIA to Serial. `ATMOSPHERIC_PSIA` is initially 14.696. For best accuracy, replace it with the local atmospheric reference or implement a zero-at-atmosphere operation before calibration.

## Real hardware wiring represented by the simulation

| From | To |
|---|---|
| Regulated 5V | Arduino 5V, LCD VCC, ADS1115 VDD, pot outer pin, DUT COM |
| Common GND | Arduino/LCD/ADS GND, buzzer negative, divider bottoms, other pot outer pin |
| Arduino A4/A5 | LCD and ADS1115 SDA/SCL in parallel |
| Taber 0–5V output (0–150 PSIA absolute) | ADS1115 A0 |
| Main 28V through 68k/10k divider | ADS1115 A1 |
| Sensor 28V through 68k/10k divider | ADS1115 A2 |
| Pump-command pot wiper | pump white command wire and ADS1115 A3 |
| DUT NO contact | 10k pulldown node, then 1k series resistor to Arduino A0 |
| Arduino D8 | buzzer positive (only if buzzer current is <=15mA) |
| 3-position selector common | GND; LOW to D3; HIGH to D4 |

The real DUT circuit is **5V -> COM, NO -> sense node, 10k from sense node to GND, 1k from sense node to A0**. In Wokwi, the custom chip automatically drives that 0/5V signal based on pressure. The simulated pressure response is deliberately simple and linear; the real rig still uses its hydraulic valve and pump.

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
