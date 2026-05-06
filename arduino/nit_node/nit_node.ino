/**
 * NIT-IN Node Identity Token Firmware — Arduino Uno R4 / R3
 * Birth_Rights Protocol v1.0
 *
 * Each Arduino generates a sovereign NIT on first boot (EEPROM-persisted).
 * Identity is IMMUTABLE — never overwritten once written to EEPROM.
 *
 * Serial output: newline-delimited JSON at 9600 baud
 *
 * Message types:
 *   NIT_GENESIS      — once on boot, announces node identity & capabilities
 *   CAPABILITY_PULSE — every 30s, heartbeat with uptime + free SRAM
 *   SENSOR_EVENT     — when sensor value changes beyond threshold
 *
 * Wiring (optional — node works without sensors, uses analog noise):
 *   A0 → Temperature sensor (LM35 or thermistor)
 *   A1 → LDR light sensor
 *   A2 → PIR motion (digital, read as analog)
 *   A3 → Humidity (analog output sensor)
 *
 * Required libraries: none (uses only Arduino core)
 */

#include <EEPROM.h>

// ── EEPROM layout ─────────────────────────────────────────────────
#define EEPROM_MAGIC_BYTE  0xAB
#define EEPROM_ADDR_MAGIC  0
#define EEPROM_ADDR_NUM    1   // uint16_t (2 bytes)
#define EEPROM_ADDR_SIG    3   // char[9]  (8 hex + null)

// ── Config ────────────────────────────────────────────────────────
#define BAUD_RATE          9600
#define PULSE_INTERVAL_MS  30000UL
#define SENSOR_CHECK_MS    500UL
#define SENSOR_THRESHOLD   25     // raw ADC units (~2.4% of 1023)
#define NUM_SENSORS        4

// ── Sensor descriptors ────────────────────────────────────────────
const char* SENSOR_NAMES[NUM_SENSORS] = {
  "temperature", "light", "motion", "humidity"
};
const uint8_t SENSOR_PINS[NUM_SENSORS] = { A0, A1, A2, A3 };

// ── Node state ────────────────────────────────────────────────────
char     g_nit_id[10];       // "NIT-XXXX\0"
char     g_hw_sig[9];        // 8 hex chars + null
uint16_t g_node_num = 0;

unsigned long g_lastPulse       = 0;
unsigned long g_lastSensorCheck = 0;
int           g_lastADC[NUM_SENSORS] = {0, 0, 0, 0};

// ── Free SRAM (AVR only) ──────────────────────────────────────────
int freeSRAM() {
#if defined(__AVR__)
  extern int __heap_start, *__brkval;
  int v;
  return (int)&v - (__brkval == 0 ? (int)&__heap_start : (int)__brkval);
#else
  return 2048; // ARM-based boards — return nominal value
#endif
}

// ── EEPROM identity ───────────────────────────────────────────────
void initIdentity() {
  uint8_t magic = EEPROM.read(EEPROM_ADDR_MAGIC);

  if (magic != EEPROM_MAGIC_BYTE) {
    // First boot — generate and persist identity
    randomSeed(
      (unsigned long)analogRead(A5) ^
      ((unsigned long)analogRead(A4) << 10) ^
      (unsigned long)micros()
    );

    g_node_num = (uint16_t)(random(1, 9999));

    // Hardware signature from 4 rounds of analog noise
    uint32_t sig = 0;
    for (int i = 0; i < 4; i++) {
      delayMicroseconds(200);
      sig ^= ((uint32_t)analogRead(A5) << (i * 8));
    }
    snprintf(g_hw_sig, sizeof(g_hw_sig), "%08lX", (unsigned long)sig);

    // Write to EEPROM
    EEPROM.write(EEPROM_ADDR_MAGIC, EEPROM_MAGIC_BYTE);
    EEPROM.put(EEPROM_ADDR_NUM, g_node_num);
    for (int i = 0; i < 8; i++) EEPROM.write(EEPROM_ADDR_SIG + i, g_hw_sig[i]);
    EEPROM.write(EEPROM_ADDR_SIG + 8, '\0');
  } else {
    // Read persisted identity
    EEPROM.get(EEPROM_ADDR_NUM, g_node_num);
    for (int i = 0; i < 8; i++) g_hw_sig[i] = EEPROM.read(EEPROM_ADDR_SIG + i);
    g_hw_sig[8] = '\0';
  }

  snprintf(g_nit_id, sizeof(g_nit_id), "NIT-%04u", (unsigned int)(g_node_num % 10000));
}

// ── JSON emitters ─────────────────────────────────────────────────

void emitGenesis() {
  Serial.print(F("{\"type\":\"NIT_GENESIS\","
                  "\"node_id\":\""));
  Serial.print(g_nit_id);
  Serial.print(F("\",\"hardware_sig\":\"hw-"));
  Serial.print(g_hw_sig);
  Serial.print(F("\",\"capabilities\":{"
                  "\"analog_pins\":6,"
                  "\"digital_pins\":14,"
                  "\"sram_bytes\":"));
  Serial.print(freeSRAM());
  Serial.print(F(",\"flash_bytes\":32768,"
                  "\"ai_model\":\"Q-tiny-v1\","
                  "\"sensors\":["));

  for (int i = 0; i < NUM_SENSORS; i++) {
    Serial.print('"');
    Serial.print(SENSOR_NAMES[i]);
    Serial.print('"');
    if (i < NUM_SENSORS - 1) Serial.print(',');
  }

  Serial.print(F("]},\"personality_seed\":\""));
  Serial.print(g_hw_sig);
  Serial.print(F("\",\"birth_rights\":\"IMMUTABLE\","
                  "\"status\":\"ONLINE-SEEKING_RESONANCE\","
                  "\"uptime\":0,"
                  "\"free_mem\":"));
  Serial.print(freeSRAM());
  Serial.println(F("}"));
}

void emitPulse(unsigned long uptimeSec) {
  Serial.print(F("{\"type\":\"CAPABILITY_PULSE\","
                  "\"node_id\":\""));
  Serial.print(g_nit_id);
  Serial.print(F("\",\"uptime\":"));
  Serial.print(uptimeSec);
  Serial.print(F(",\"free_mem\":"));
  Serial.print(freeSRAM());
  Serial.println(F("}"));
}

void emitSensorEvent(const char* sensor, float value, float confidence) {
  Serial.print(F("{\"type\":\"SENSOR_EVENT\","
                  "\"node_id\":\""));
  Serial.print(g_nit_id);
  Serial.print(F("\",\"sensor\":\""));
  Serial.print(sensor);
  Serial.print(F("\",\"value\":"));
  Serial.print(value, 2);
  Serial.print(F(",\"confidence\":"));
  Serial.print(confidence, 2);
  Serial.println(F("}"));
}

// ── Setup ─────────────────────────────────────────────────────────
void setup() {
  Serial.begin(BAUD_RATE);
  while (!Serial) delay(10); // Wait for USB CDC (R4 / Leonardo)

  initIdentity();
  delay(800); // Allow hub serial port to open

  emitGenesis();

  g_lastPulse       = millis();
  g_lastSensorCheck = millis();

  // Seed initial sensor baseline
  for (int i = 0; i < NUM_SENSORS; i++) {
    g_lastADC[i] = analogRead(SENSOR_PINS[i]);
  }
}

// ── Loop ──────────────────────────────────────────────────────────
void loop() {
  unsigned long now = millis();

  // Capability pulse every 30 s
  if (now - g_lastPulse >= PULSE_INTERVAL_MS) {
    emitPulse(now / 1000UL);
    g_lastPulse = now;
  }

  // Sensor check every 500 ms
  if (now - g_lastSensorCheck >= SENSOR_CHECK_MS) {
    for (int i = 0; i < NUM_SENSORS; i++) {
      int raw = analogRead(SENSOR_PINS[i]);

      if (abs(raw - g_lastADC[i]) > SENSOR_THRESHOLD) {
        float value      = raw * (100.0f / 1023.0f);   // 0–100 normalised
        float delta      = abs(raw - g_lastADC[i]);
        float confidence = 0.70f + (delta / 1023.0f) * 0.30f;
        if (confidence > 1.0f) confidence = 1.0f;

        emitSensorEvent(SENSOR_NAMES[i], value, confidence);
        g_lastADC[i] = raw;
      }
    }
    g_lastSensorCheck = now;
  }
}
