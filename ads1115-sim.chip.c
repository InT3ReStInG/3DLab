#include "wokwi-api.h"
#include <stdlib.h>
#include <stdint.h>
#include <stdbool.h>

typedef struct {
  uint32_t ain_attr[4];
  pin_t pot_pin;
  pin_t mode_pin;
  pin_t dut_pin;
  uint8_t reg_pointer;
  uint8_t byte_index;
  uint16_t config;
  uint16_t conversion;
  uint16_t low_thresh;
  uint16_t high_thresh;
  bool read_transaction;
  bool dut_closed;
} chip_state_t;

// Simulation-only plant model. Turning the pot moves pressure from 0 to 3 bar.
// The real rig's pressure/flow relationship is hydraulic and will not be linear.
#define SIM_MAX_PRESSURE_BAR 3.0f
#define SENSOR_FULL_SCALE_PSIA 150.0f
#define ATMOSPHERIC_PSIA 14.696f
#define BAR_TO_PSI 14.5037738f

static void update_plant(chip_state_t *chip) {
  float command_v = pin_adc_read(chip->pot_pin);
  float pressure_bar_gauge = command_v / 5.0f * SIM_MAX_PRESSURE_BAR;
  bool high_mode = pin_adc_read(chip->mode_pin) > 2.5f;
  float trip = high_mode ? 2.0f : 0.2f;
  float reset = high_mode ? 1.8f : 0.15f;

  if (!chip->dut_closed && pressure_bar_gauge >= trip) chip->dut_closed = true;
  if (chip->dut_closed && pressure_bar_gauge <= reset) chip->dut_closed = false;
  pin_dac_write(chip->dut_pin, chip->dut_closed ? 5.0f : 0.0f);
}

static float full_scale(uint16_t config) {
  switch ((config >> 9) & 7) {
    case 0: return 6.144f;
    case 1: return 4.096f;
    case 2: return 2.048f;
    case 3: return 1.024f;
    case 4: return 0.512f;
    default: return 0.256f;
  }
}

static void update_conversion(chip_state_t *chip) {
  update_plant(chip);
  uint8_t mux = (chip->config >> 12) & 7;
  uint8_t channel = (mux >= 4) ? mux - 4 : 0;
  float command_v = pin_adc_read(chip->pot_pin);
  float pressure_bar_gauge = command_v / 5.0f * SIM_MAX_PRESSURE_BAR;
  float pressure_psia = ATMOSPHERIC_PSIA + pressure_bar_gauge * BAR_TO_PSI;
  float volts;
  if (channel == 0) volts = pressure_psia / SENSOR_FULL_SCALE_PSIA * 5.0f;
  else if (channel == 3) volts = command_v;
  else volts = attr_read_float(chip->ain_attr[channel]);
  float fs = full_scale(chip->config);
  int32_t code = (int32_t)(volts / fs * 32768.0f);
  if (code > 32767) code = 32767;
  if (code < -32768) code = -32768;
  chip->conversion = (uint16_t)(int16_t)code;
  chip->config |= 0x8000; // conversion ready
}

static uint16_t selected_register(chip_state_t *chip) {
  if (chip->reg_pointer == 0) {
    update_conversion(chip);
    return chip->conversion;
  }
  if (chip->reg_pointer == 1) return chip->config;
  if (chip->reg_pointer == 2) return chip->low_thresh;
  if (chip->reg_pointer == 3) return chip->high_thresh;
  return 0;
}

static bool on_connect(void *user_data, uint32_t address, bool read) {
  chip_state_t *chip = user_data;
  chip->byte_index = 0;
  chip->read_transaction = read;
  return true;
}

static uint8_t on_read(void *user_data) {
  chip_state_t *chip = user_data;
  uint16_t value = selected_register(chip);
  uint8_t result = chip->byte_index == 0 ? (value >> 8) : (value & 0xff);
  chip->byte_index = (chip->byte_index + 1) & 1;
  return result;
}

static bool on_write(void *user_data, uint8_t data) {
  chip_state_t *chip = user_data;
  if (chip->byte_index == 0) {
    chip->reg_pointer = data & 3;
  } else {
    uint16_t *target = &chip->config;
    if (chip->reg_pointer == 2) target = &chip->low_thresh;
    if (chip->reg_pointer == 3) target = &chip->high_thresh;
    if (chip->byte_index == 1) *target = (*target & 0x00ff) | ((uint16_t)data << 8);
    if (chip->byte_index == 2) {
      *target = (*target & 0xff00) | data;
      if (chip->reg_pointer == 1) update_conversion(chip);
    }
  }
  chip->byte_index++;
  return true;
}

static void on_disconnect(void *user_data) {}

void chip_init(void) {
  chip_state_t *chip = calloc(1, sizeof(chip_state_t));
  chip->config = 0x8583;
  chip->low_thresh = 0x8000;
  chip->high_thresh = 0x7fff;
  chip->ain_attr[1] = attr_init_float("ain1Voltage", 3.59f);
  chip->ain_attr[2] = attr_init_float("ain2Voltage", 3.59f);
  chip->pot_pin = pin_init("POT", ANALOG);
  chip->mode_pin = pin_init("MODE", ANALOG);
  chip->dut_pin = pin_init("DUT", ANALOG);
  pin_dac_write(chip->dut_pin, 0.0f);

  i2c_config_t config = {
    .address = 0x48,
    .scl = pin_init("SCL", INPUT_PULLUP),
    .sda = pin_init("SDA", INPUT_PULLUP),
    .connect = on_connect,
    .read = on_read,
    .write = on_write,
    .disconnect = on_disconnect,
    .user_data = chip,
  };
  i2c_init(&config);
}
