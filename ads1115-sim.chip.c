#include "wokwi-api.h"
#include <stdlib.h>
#include <stdint.h>
#include <stdbool.h>

typedef struct {
  uint32_t ain_attr[4];
  uint8_t reg_pointer;
  uint8_t byte_index;
  uint16_t config;
  uint16_t conversion;
  uint16_t low_thresh;
  uint16_t high_thresh;
  bool read_transaction;
} chip_state_t;

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
  uint8_t mux = (chip->config >> 12) & 7;
  uint8_t channel = (mux >= 4) ? mux - 4 : 0;
  float volts = attr_read_float(chip->ain_attr[channel]);
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
  chip->ain_attr[0] = attr_init_float("ain0Voltage", 0.50f);
  chip->ain_attr[1] = attr_init_float("ain1Voltage", 3.59f);
  chip->ain_attr[2] = attr_init_float("ain2Voltage", 3.59f);
  chip->ain_attr[3] = attr_init_float("ain3Voltage", 2.50f);

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
