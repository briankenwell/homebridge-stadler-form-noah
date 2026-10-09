import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { createRequire } from 'node:module';

import { NoahAccessory, type NoahAccessoryContext } from './noahAccessory.js';
import { NoahDevice } from './noahDevice.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

const require = createRequire(import.meta.url);

/** Version + build time of the compiled JS actually running, so a stale dist/ is obvious in the log. */
function buildStamp(): string {
  try {
    const stamp = require('./build-stamp.json') as { version?: string; builtAt?: string };
    return `${stamp.version ?? '?'} (built ${stamp.builtAt ?? '?'})`;
  } catch {
    return 'unknown build (dist/build-stamp.json missing: run `npm run build`)';
  }
}

export interface NoahDeviceConfig {
  name: string;
  id: string;
  key: string;
  ip?: string;
  version?: string;
  model?: 'Noah' | 'Noah Pro';
  pollInterval?: number;
  exposeDisplayLight?: boolean;
  exposeWaterTankSensor?: boolean;
  exposeFanControl?: boolean;
  /** Device reports DP 33 as % of filter life USED rather than remaining. */
  filterLifeIsUsed?: boolean;
  /**
   * Bump to publish the device as a brand-new HomeKit accessory. Forces Home to drop every cached
   * characteristic property for it. Costs the room assignment and any scenes/automations once.
   */
  homekitRevision?: number;
}

export interface NoahPlatformConfig extends PlatformConfig {
  devices?: NoahDeviceConfig[];
}

export class StadlerFormNoahPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: Map<string, PlatformAccessory<NoahAccessoryContext>> = new Map();
  private readonly devices: NoahDevice[] = [];

  constructor(
    public readonly log: Logging,
    public readonly config: NoahPlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.log.info('%s %s', PLUGIN_NAME, buildStamp());

    this.api.on('didFinishLaunching', () => {
      this.log.debug('Executed didFinishLaunching callback');
      this.discoverDevices();
    });

    this.api.on('shutdown', () => {
      for (const device of this.devices) {
        device.stop();
      }
    });
  }

  /**
   * Called by Homebridge for every cached accessory restored from disk at startup.
   */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory as PlatformAccessory<NoahAccessoryContext>);
  }

  private discoverDevices(): void {
    const configured = Array.isArray(this.config.devices) ? this.config.devices : [];
    const seen = new Set<string>();

    for (const entry of configured) {
      if (!entry || typeof entry.id !== 'string' || typeof entry.key !== 'string' || !entry.id || !entry.key) {
        this.log.error('Skipping device with missing "id" or "key": %j', entry);
        continue;
      }
      const name = entry.name?.trim() || 'Stadler Form Noah';
      const revision = Number.isInteger(entry.homekitRevision) && entry.homekitRevision! > 0 ? `:rev${entry.homekitRevision}` : '';
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${entry.id}${revision}`);
      if (seen.has(uuid)) {
        this.log.warn('Duplicate device id %s in config, ignoring second entry', entry.id);
        continue;
      }
      seen.add(uuid);

      const device = new NoahDevice(
        {
          id: entry.id,
          key: entry.key,
          ip: entry.ip?.trim() || undefined,
          version: entry.version,
          pollIntervalSeconds: entry.pollInterval,
          name,
        },
        this.log,
      );
      this.devices.push(device);

      const existing = this.accessories.get(uuid);
      if (existing) {
        this.log.info('Restoring existing accessory from cache:', existing.displayName);
        existing.context.config = entry;
        new NoahAccessory(this, existing, device);
        this.api.updatePlatformAccessories([existing]);
      } else {
        this.log.info('Adding new accessory:', name);
        const accessory = new this.api.platformAccessory<NoahAccessoryContext>(name, uuid);
        accessory.context.config = entry;
        new NoahAccessory(this, accessory, device);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.set(uuid, accessory);
      }

      device.start();
    }

    // Remove accessories that are no longer in the config.
    for (const [uuid, accessory] of this.accessories) {
      if (!seen.has(uuid)) {
        this.log.info('Removing accessory no longer in config:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(uuid);
      }
    }
  }
}
