/**
 * This is the name of the platform that users will use to register the plugin in the Homebridge config.json
 */
export const PLATFORM_NAME = 'StadlerFormNoah';

/**
 * This must match the name of your plugin as defined the package.json
 */
export const PLUGIN_NAME = 'homebridge-stadler-form-noah';

/**
 * Tuya datapoint (DP) ids used by the Stadler Form Noah / Noah Pro.
 * Source: tuya-local device definition `stadlerform_noah_humidifier.yaml`
 * and the Tuya cloud model posted in make-all/tuya-local#4106.
 */
export const DP = {
  /** bool, rw: power */
  POWER: 1,
  /** integer 0-100, ro: measured ambient relative humidity (%) */
  CURRENT_HUMIDITY: 13,
  /** integer 0-100 (step 25), ro: water tank level (%) */
  WATER_LEVEL: 17,
  /** bitmap, ro: fault flags. bit 0 = no_water */
  FAULT: 22,
  /** bool, rw: child lock */
  CHILD_LOCK: 29,
  /** integer 0-100, ro: filter life remaining (%) */
  FILTER_LIFE: 33,
  /** integer 30-80 step 5, rw: target humidity (%). 80 = continuous */
  TARGET_HUMIDITY: 101,
  /** integer 1-5, rw: fan speed. 5 = turbo */
  FAN_SPEED: 102,
  /** bool, rw: auto (hygrostat) mode */
  AUTO_MODE: 103,
  /** bool, rw: filter replacement reminder */
  REPLACE_FILTER: 104,
  /** enum 'Normal' | 'Dimmer' | 'Light_off', rw: display brightness */
  NIGHT_MODE: 105,
} as const;

export const FAULT_NO_WATER = 0x1;

export const TARGET_HUMIDITY_MIN = 30;
export const TARGET_HUMIDITY_MAX = 80;
export const TARGET_HUMIDITY_STEP = 5;

export const FAN_SPEED_MIN = 1;
export const FAN_SPEED_MAX = 5;

export const DISPLAY_NORMAL = 'Normal';
export const DISPLAY_DIMMER = 'Dimmer';
export const DISPLAY_OFF = 'Light_off';

export const DEFAULT_POLL_INTERVAL_SECONDS = 30;
export const DEFAULT_PROTOCOL_VERSION = 'auto';
