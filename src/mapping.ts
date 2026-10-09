/**
 * Pure value conversions between Tuya datapoints and HomeKit characteristic values.
 * Kept free of Homebridge imports so they can be unit tested in isolation.
 */
import {
  DISPLAY_DIMMER,
  DISPLAY_NORMAL,
  DISPLAY_OFF,
  DP,
  FAN_SPEED_MAX,
  FAN_SPEED_MIN,
  FAULT_NO_WATER,
  TARGET_HUMIDITY_MAX,
  TARGET_HUMIDITY_MIN,
  TARGET_HUMIDITY_STEP,
} from './settings.js';

export type DpsValue = string | number | boolean;
export type DpsState = Record<number, DpsValue>;

/** HomeKit CurrentHumidifierDehumidifierState values. */
export const CurrentState = {
  INACTIVE: 0,
  IDLE: 1,
  HUMIDIFYING: 2,
} as const;

/** HomeKit TargetHumidifierDehumidifierState values. */
export const TargetState = {
  AUTO: 0,
  HUMIDIFIER: 1,
} as const;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export function asBool(value: DpsValue | undefined): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    return value === 'true' || value === '1';
  }
  return false;
}

export function asNumber(value: DpsValue | undefined, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  return fallback;
}

export function isPowerOn(dps: DpsState): boolean {
  return asBool(dps[DP.POWER]);
}

export function isAutoMode(dps: DpsState): boolean {
  return asBool(dps[DP.AUTO_MODE]);
}

export function isTankEmpty(dps: DpsState): boolean {
  return (asNumber(dps[DP.FAULT]) & FAULT_NO_WATER) !== 0;
}

export function currentHumidity(dps: DpsState): number {
  return clamp(asNumber(dps[DP.CURRENT_HUMIDITY]), 0, 100);
}

export function waterLevel(dps: DpsState): number {
  return clamp(asNumber(dps[DP.WATER_LEVEL]), 0, 100);
}

export function filterLife(dps: DpsState): number {
  return clamp(asNumber(dps[DP.FILTER_LIFE], 100), 0, 100);
}

export function targetHumidity(dps: DpsState): number {
  return clamp(asNumber(dps[DP.TARGET_HUMIDITY], TARGET_HUMIDITY_MIN), TARGET_HUMIDITY_MIN, TARGET_HUMIDITY_MAX);
}

/** Round a HomeKit threshold to the nearest value the Noah accepts (30..80, step 5). */
export function toTargetHumidityDp(value: number): number {
  const stepped = Math.round(value / TARGET_HUMIDITY_STEP) * TARGET_HUMIDITY_STEP;
  return clamp(stepped, TARGET_HUMIDITY_MIN, TARGET_HUMIDITY_MAX);
}

/** Fan level 1..5 -> HomeKit RotationSpeed 20..100. */
export function fanLevelToRotationSpeed(dps: DpsState): number {
  const level = clamp(Math.round(asNumber(dps[DP.FAN_SPEED], FAN_SPEED_MIN)), FAN_SPEED_MIN, FAN_SPEED_MAX);
  return level * (100 / FAN_SPEED_MAX);
}

/** HomeKit RotationSpeed 0..100 -> fan level 1..5 (0 is treated as "lowest", the caller decides to power off). */
export function rotationSpeedToFanLevel(speed: number): number {
  const level = Math.round(speed / (100 / FAN_SPEED_MAX));
  return clamp(level, FAN_SPEED_MIN, FAN_SPEED_MAX);
}

export function currentState(dps: DpsState): number {
  if (!isPowerOn(dps)) {
    return CurrentState.INACTIVE;
  }
  if (isTankEmpty(dps)) {
    return CurrentState.IDLE;
  }
  if (isAutoMode(dps) && currentHumidity(dps) >= targetHumidity(dps)) {
    return CurrentState.IDLE;
  }
  return CurrentState.HUMIDIFYING;
}

export function targetState(dps: DpsState): number {
  return isAutoMode(dps) ? TargetState.AUTO : TargetState.HUMIDIFIER;
}

/** Display enum -> HomeKit Brightness 0 | 50 | 100. */
export function displayBrightness(dps: DpsState): number {
  switch (dps[DP.NIGHT_MODE]) {
    case DISPLAY_OFF:
      return 0;
    case DISPLAY_DIMMER:
      return 50;
    default:
      return 100;
  }
}

/** HomeKit Brightness 0..100 -> display enum. */
export function brightnessToDisplayDp(brightness: number): string {
  if (brightness <= 0) {
    return DISPLAY_OFF;
  }
  if (brightness <= 50) {
    return DISPLAY_DIMMER;
  }
  return DISPLAY_NORMAL;
}

/** Merge a partial dps update into existing state. Returns the set of changed ids. */
export function mergeDps(target: DpsState, incoming: Record<string | number, unknown>): number[] {
  const changed: number[] = [];
  for (const [key, value] of Object.entries(incoming)) {
    const id = Number(key);
    if (!Number.isInteger(id)) {
      continue;
    }
    if (value === null || value === undefined) {
      continue;
    }
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      continue;
    }
    if (target[id] !== value) {
      target[id] = value;
      changed.push(id);
    }
  }
  return changed;
}
