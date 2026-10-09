import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import {
  asBool,
  brightnessToDisplayDp,
  currentHumidity,
  currentState,
  displayBrightness,
  fanLevelToRotationSpeed,
  filterLife,
  isPowerOn,
  isTankEmpty,
  rotationSpeedToFanLevel,
  targetHumidity,
  targetState,
  TargetState,
  toTargetHumidityDp,
  waterLevel,
  type DpsState,
  type DpsValue,
} from './mapping.js';
import type { NoahDevice } from './noahDevice.js';
import type { NoahDeviceConfig, StadlerFormNoahPlatform } from './platform.js';
import {
  DISPLAY_NORMAL,
  DISPLAY_OFF,
  DP,
  FAN_SPEED_MAX,
} from './settings.js';

/** Bump when characteristic props change so controllers drop their cached metadata. */
const HUMIDIFIER_SUBTYPE = 'humidifier-v2';

export interface NoahAccessoryContext {
  config: NoahDeviceConfig;
}

/**
 * One HomeKit accessory per Noah. Services:
 *  - HumidifierDehumidifier (primary): power, auto/humidify, target & current humidity, fan speed,
 *    child lock, water level
 *  - FilterMaintenance: filter life + replace-filter indicator
 *  - Lightbulb "Display" (optional): display brightness Normal / Dimmer / Off
 *  - ContactSensor "Water Tank" (optional): open = tank empty
 */
export class NoahAccessory {
  private readonly humidifier: Service;
  private readonly filter: Service;
  private display?: Service;
  private tank?: Service;
  private fan?: Service;
  private readonly config: NoahDeviceConfig;

  constructor(
    private readonly platform: StadlerFormNoahPlatform,
    accessory: PlatformAccessory<NoahAccessoryContext>,
    private readonly device: NoahDevice,
  ) {
    const { Service, Characteristic } = this.platform;
    const config = accessory.context.config;
    this.config = config;

    accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Stadler Form')
      .setCharacteristic(Characteristic.Model, config.model ?? 'Noah')
      .setCharacteristic(Characteristic.SerialNumber, config.id)
      .setCharacteristic(Characteristic.FirmwareRevision, '0.1.6');

    // --- Humidifier -------------------------------------------------------
    // HomeKit controllers cache characteristic metadata (min/max/step) per instance id, and
    // hap-nodejs derives instance ids from the service subtype. Versions <= 0.1.2 published the
    // threshold with a 30-80 range which the Home app then kept using for its tile maths even after
    // the range was widened. Publishing the service under a subtype gives it fresh instance ids, so
    // controllers re-read the metadata. Bump HUMIDIFIER_SUBTYPE if characteristic props change again.
    for (const legacy of accessory.services.filter((svc) => svc.UUID === Service.HumidifierDehumidifier.UUID && !svc.subtype)) {
      this.platform.log.info('[%s] Migrating humidifier service to new instance ids', accessory.displayName);
      accessory.removeService(legacy);
    }
    this.humidifier =
      accessory.getServiceById(Service.HumidifierDehumidifier, HUMIDIFIER_SUBTYPE) ||
      accessory.addService(Service.HumidifierDehumidifier, accessory.displayName, HUMIDIFIER_SUBTYPE);
    this.humidifier.setPrimaryService(true);
    this.humidifier.setCharacteristic(Characteristic.Name, accessory.displayName);

    this.humidifier
      .getCharacteristic(Characteristic.Active)
      .onGet(() => this.read(() => (isPowerOn(this.state) ? 1 : 0)))
      .onSet((value) => this.write({ [DP.POWER]: value === Characteristic.Active.ACTIVE }));

    this.humidifier
      .getCharacteristic(Characteristic.CurrentHumidifierDehumidifierState)
      .onGet(() => this.read(() => currentState(this.state)));

    this.humidifier
      .getCharacteristic(Characteristic.TargetHumidifierDehumidifierState)
      .setProps({ validValues: [TargetState.AUTO, TargetState.HUMIDIFIER] })
      .onGet(() => this.read(() => targetState(this.state)))
      .onSet((value) => this.write({ [DP.AUTO_MODE]: value === TargetState.AUTO }));

    this.humidifier
      .getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .onGet(() => this.read(() => currentHumidity(this.state)));

    // Deliberately keep HAP's default 0-100 / step 1 props here. The Home app renders the tile
    // percentage and slider fill relative to minValue/maxValue, so a 30-80 range makes the tile
    // show "(value-30)/50" instead of the value. We clamp/round to the Noah's 30-80 step-5 range
    // in the setter and the device echo snaps the slider to the accepted value.
    this.humidifier
      .getCharacteristic(Characteristic.RelativeHumidityHumidifierThreshold)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onGet(() => this.read(() => targetHumidity(this.state)))
      .onSet((value) => this.write({ [DP.TARGET_HUMIDITY]: toTargetHumidityDp(value as number) }));

    this.humidifier
      .getCharacteristic(Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 100 / FAN_SPEED_MAX })
      .onGet(() => this.read(() => (isPowerOn(this.state) ? fanLevelToRotationSpeed(this.state) : 0)))
      .onSet((value) => {
        const speed = value as number;
        // Home sends RotationSpeed 0 together with Active 0; let Active own power.
        if (speed <= 0) {
          return;
        }
        return this.write({ [DP.FAN_SPEED]: rotationSpeedToFanLevel(speed) });
      });

    this.humidifier
      .getCharacteristic(Characteristic.LockPhysicalControls)
      .onGet(() => this.read(() => (asBool(this.state[DP.CHILD_LOCK]) ? 1 : 0)))
      .onSet((value) => this.write({ [DP.CHILD_LOCK]: value === Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED }));

    this.humidifier
      .getCharacteristic(Characteristic.WaterLevel)
      .onGet(() => this.read(() => waterLevel(this.state)));

    // --- Filter -----------------------------------------------------------
    this.filter =
      accessory.getService(Service.FilterMaintenance) ||
      accessory.addService(Service.FilterMaintenance, `${accessory.displayName} Filter`);
    this.filter.setCharacteristic(Characteristic.Name, `${accessory.displayName} Filter`);
    this.humidifier.addLinkedService(this.filter);

    this.filter
      .getCharacteristic(Characteristic.FilterChangeIndication)
      .onGet(() => this.read(() => (asBool(this.state[DP.REPLACE_FILTER]) ? 1 : 0)));
    this.filter
      .getCharacteristic(Characteristic.FilterLifeLevel)
      .onGet(() => this.read(() => this.filterLifeRemaining()));
    this.filter
      .getCharacteristic(Characteristic.ResetFilterIndication)
      .onSet(() => this.write({ [DP.REPLACE_FILTER]: false }));

    // --- Optional: display light -----------------------------------------
    const displayName = `${accessory.displayName} Display`;
    if (config.exposeDisplayLight) {
      this.display =
        accessory.getServiceById(Service.Lightbulb, 'display') ||
        accessory.addService(Service.Lightbulb, displayName, 'display');
      this.display.setCharacteristic(Characteristic.Name, displayName);
      this.display
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.read(() => displayBrightness(this.state) > 0))
        .onSet((value) => this.write({ [DP.NIGHT_MODE]: value ? DISPLAY_NORMAL : DISPLAY_OFF }));
      this.display
        .getCharacteristic(Characteristic.Brightness)
        .setProps({ minValue: 0, maxValue: 100, minStep: 50 })
        .onGet(() => this.read(() => displayBrightness(this.state)))
        .onSet((value) => this.write({ [DP.NIGHT_MODE]: brightnessToDisplayDp(value as number) }));
    } else {
      const stale = accessory.getServiceById(Service.Lightbulb, 'display');
      if (stale) {
        accessory.removeService(stale);
      }
    }

    // --- Optional: fan control -------------------------------------------
    // The Home app hides RotationSpeed on HumidifierDehumidifier, so offer a real Fan tile.
    const fanName = `${accessory.displayName} Fan`;
    if (config.exposeFanControl) {
      this.fan =
        accessory.getServiceById(Service.Fanv2, 'fan') ||
        accessory.addService(Service.Fanv2, fanName, 'fan');
      this.fan.setCharacteristic(Characteristic.Name, fanName);
      this.humidifier.addLinkedService(this.fan);
      this.fan
        .getCharacteristic(Characteristic.Active)
        .onGet(() => this.read(() => (isPowerOn(this.state) ? 1 : 0)))
        .onSet((value) => this.write({ [DP.POWER]: value === Characteristic.Active.ACTIVE }));
      this.fan
        .getCharacteristic(Characteristic.RotationSpeed)
        .setProps({ minValue: 0, maxValue: 100, minStep: 100 / FAN_SPEED_MAX })
        .onGet(() => this.read(() => (isPowerOn(this.state) ? fanLevelToRotationSpeed(this.state) : 0)))
        .onSet((value) => {
          const speed = value as number;
          if (speed <= 0) {
            return;
          }
          return this.write({ [DP.FAN_SPEED]: rotationSpeedToFanLevel(speed) });
        });
    } else {
      const stale = accessory.getServiceById(Service.Fanv2, 'fan');
      if (stale) {
        accessory.removeService(stale);
      }
    }

    // --- Optional: water tank contact sensor ------------------------------
    const tankName = `${accessory.displayName} Water Tank`;
    if (config.exposeWaterTankSensor) {
      this.tank =
        accessory.getServiceById(Service.ContactSensor, 'tank') ||
        accessory.addService(Service.ContactSensor, tankName, 'tank');
      this.tank.setCharacteristic(Characteristic.Name, tankName);
      this.tank
        .getCharacteristic(Characteristic.ContactSensorState)
        .onGet(() => this.read(() => this.tankContactState()));
    } else {
      const stale = accessory.getServiceById(Service.ContactSensor, 'tank');
      if (stale) {
        accessory.removeService(stale);
      }
    }

    const thresholdProps = this.humidifier.getCharacteristic(Characteristic.RelativeHumidityHumidifierThreshold).props;
    this.platform.log.info(
      '[%s] Services: %s. Target humidity range served to HomeKit: %d-%d',
      accessory.displayName,
      accessory.services.map((svc) => svc.displayName || svc.UUID).join(', '),
      thresholdProps.minValue,
      thresholdProps.maxValue,
    );

    // --- Push updates from the device -------------------------------------
    device.on('state', () => this.pushState());
    device.on('connected', () => this.pushState());
  }

  private get state(): DpsState {
    return this.device.state;
  }

  /** DP 33 is documented as "filter life" but at least one owner reads it as % used; make it configurable. */
  private filterLifeRemaining(): number {
    const value = filterLife(this.state);
    return this.config.filterLifeIsUsed ? 100 - value : value;
  }

  private tankContactState(): number {
    const { Characteristic } = this.platform;
    return isTankEmpty(this.state)
      ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
      : Characteristic.ContactSensorState.CONTACT_DETECTED;
  }

  /** Reads come from the cache; if we have never heard from the device, tell HomeKit we are unreachable. */
  private read<T extends CharacteristicValue>(fn: () => T): T {
    if (Object.keys(this.state).length === 0) {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    return fn();
  }

  private async write(values: Partial<Record<number, DpsValue>>): Promise<void> {
    try {
      await this.device.set(values);
    } catch (error) {
      this.platform.log.warn('[%s] Failed to write %j: %s', this.device.name, values, (error as Error).message);
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }

  /** Push the full cached state into every characteristic. */
  private pushState(): void {
    const { Characteristic } = this.platform;
    const s = this.state;
    if (Object.keys(s).length === 0) {
      return;
    }
    const on = isPowerOn(s);

    this.humidifier.updateCharacteristic(Characteristic.Active, on ? 1 : 0);
    this.humidifier.updateCharacteristic(Characteristic.CurrentHumidifierDehumidifierState, currentState(s));
    this.humidifier.updateCharacteristic(Characteristic.TargetHumidifierDehumidifierState, targetState(s));
    this.humidifier.updateCharacteristic(Characteristic.CurrentRelativeHumidity, currentHumidity(s));
    this.humidifier.updateCharacteristic(Characteristic.RelativeHumidityHumidifierThreshold, targetHumidity(s));
    this.humidifier.updateCharacteristic(Characteristic.RotationSpeed, on ? fanLevelToRotationSpeed(s) : 0);
    this.humidifier.updateCharacteristic(Characteristic.LockPhysicalControls, asBool(s[DP.CHILD_LOCK]) ? 1 : 0);
    this.humidifier.updateCharacteristic(Characteristic.WaterLevel, waterLevel(s));

    this.filter.updateCharacteristic(Characteristic.FilterChangeIndication, asBool(s[DP.REPLACE_FILTER]) ? 1 : 0);
    this.filter.updateCharacteristic(Characteristic.FilterLifeLevel, this.filterLifeRemaining());

    if (this.fan) {
      this.fan.updateCharacteristic(Characteristic.Active, on ? 1 : 0);
      this.fan.updateCharacteristic(Characteristic.RotationSpeed, on ? fanLevelToRotationSpeed(s) : 0);
    }
    if (this.display) {
      const brightness = displayBrightness(s);
      this.display.updateCharacteristic(Characteristic.On, brightness > 0);
      this.display.updateCharacteristic(Characteristic.Brightness, brightness);
    }
    if (this.tank) {
      this.tank.updateCharacteristic(Characteristic.ContactSensorState, this.tankContactState());
    }
  }
}
