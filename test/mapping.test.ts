import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  brightnessToDisplayDp,
  CurrentState,
  currentState,
  displayBrightness,
  fanLevelToRotationSpeed,
  isTankEmpty,
  mergeDps,
  rotationSpeedToFanLevel,
  targetHumidity,
  targetState,
  TargetState,
  toTargetHumidityDp,
  type DpsState,
} from '../dist/mapping.js';
import { DP } from '../dist/settings.js';

const base = (): DpsState => ({
  [DP.POWER]: true,
  [DP.CURRENT_HUMIDITY]: 42,
  [DP.WATER_LEVEL]: 75,
  [DP.FAULT]: 0,
  [DP.CHILD_LOCK]: false,
  [DP.FILTER_LIFE]: 88,
  [DP.TARGET_HUMIDITY]: 50,
  [DP.FAN_SPEED]: 3,
  [DP.AUTO_MODE]: false,
  [DP.REPLACE_FILTER]: false,
  [DP.NIGHT_MODE]: 'Normal',
});

describe('currentState', () => {
  it('is INACTIVE when powered off', () => {
    assert.equal(currentState({ ...base(), [DP.POWER]: false }), CurrentState.INACTIVE);
  });
  it('is HUMIDIFYING when on in manual mode', () => {
    assert.equal(currentState(base()), CurrentState.HUMIDIFYING);
  });
  it('is IDLE when tank is empty', () => {
    assert.equal(currentState({ ...base(), [DP.FAULT]: 1 }), CurrentState.IDLE);
  });
  it('is IDLE in auto mode once target humidity is reached', () => {
    assert.equal(currentState({ ...base(), [DP.AUTO_MODE]: true, [DP.CURRENT_HUMIDITY]: 55 }), CurrentState.IDLE);
    assert.equal(currentState({ ...base(), [DP.AUTO_MODE]: true, [DP.CURRENT_HUMIDITY]: 45 }), CurrentState.HUMIDIFYING);
  });
});

describe('targetState', () => {
  it('maps auto mode to AUTO and manual to HUMIDIFIER', () => {
    assert.equal(targetState({ ...base(), [DP.AUTO_MODE]: true }), TargetState.AUTO);
    assert.equal(targetState(base()), TargetState.HUMIDIFIER);
  });
});

describe('target humidity', () => {
  it('rounds to 5% steps and clamps to 30..80', () => {
    assert.equal(toTargetHumidityDp(52), 50);
    assert.equal(toTargetHumidityDp(53), 55);
    assert.equal(toTargetHumidityDp(10), 30);
    assert.equal(toTargetHumidityDp(99), 80);
  });
  it('reads the dp and clamps', () => {
    assert.equal(targetHumidity(base()), 50);
    assert.equal(targetHumidity({ ...base(), [DP.TARGET_HUMIDITY]: 100 }), 80);
    assert.equal(targetHumidity({}), 30);
  });
});

describe('fan speed', () => {
  it('maps levels 1..5 to 20..100', () => {
    for (let level = 1; level <= 5; level++) {
      assert.equal(fanLevelToRotationSpeed({ [DP.FAN_SPEED]: level }), level * 20);
    }
  });
  it('maps rotation speed back to levels and never returns 0', () => {
    assert.equal(rotationSpeedToFanLevel(100), 5);
    assert.equal(rotationSpeedToFanLevel(60), 3);
    assert.equal(rotationSpeedToFanLevel(25), 1);
    assert.equal(rotationSpeedToFanLevel(5), 1);
  });
});

describe('display', () => {
  it('maps enum to brightness', () => {
    assert.equal(displayBrightness({ [DP.NIGHT_MODE]: 'Normal' }), 100);
    assert.equal(displayBrightness({ [DP.NIGHT_MODE]: 'Dimmer' }), 50);
    assert.equal(displayBrightness({ [DP.NIGHT_MODE]: 'Light_off' }), 0);
  });
  it('maps brightness to enum', () => {
    assert.equal(brightnessToDisplayDp(0), 'Light_off');
    assert.equal(brightnessToDisplayDp(50), 'Dimmer');
    assert.equal(brightnessToDisplayDp(100), 'Normal');
  });
});

describe('fault', () => {
  it('detects the no_water bit', () => {
    assert.equal(isTankEmpty({ [DP.FAULT]: 0 }), false);
    assert.equal(isTankEmpty({ [DP.FAULT]: 1 }), true);
    assert.equal(isTankEmpty({ [DP.FAULT]: 3 }), true);
    assert.equal(isTankEmpty({}), false);
  });
});

describe('mergeDps', () => {
  it('merges string-keyed dps and reports changed ids only', () => {
    const state: DpsState = { 1: true, 13: 40 };
    const changed = mergeDps(state, { '1': true, '13': 41, '102': 2, '106': null, foo: 1 });
    assert.deepEqual(changed.sort((a, b) => a - b), [13, 102]);
    assert.deepEqual(state, { 1: true, 13: 41, 102: 2 });
  });
});
