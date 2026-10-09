import { EventEmitter } from 'node:events';
import TuyAPI from 'tuyapi';
import type { Logging } from 'homebridge';

import { type DpsState, type DpsValue, mergeDps } from './mapping.js';
import { DEFAULT_POLL_INTERVAL_SECONDS, DEFAULT_PROTOCOL_VERSION } from './settings.js';

export interface NoahDeviceOptions {
  id: string;
  key: string;
  ip?: string;
  /** '3.3' | '3.4' | '3.5' or 'auto' to discover via UDP broadcast */
  version?: string;
  pollIntervalSeconds?: number;
  name: string;
}

export interface NoahDeviceEvents {
  /** Emitted after any datapoint changes. Payload: ids that changed, full state. */
  state: [changed: number[], state: DpsState];
  connected: [];
  disconnected: [];
}

const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
const DISCOVERY_TIMEOUT_S = 10;
const CONNECT_TIMEOUT_MS = 10_000;
/** How long a HomeKit write will wait for an on-demand reconnect before giving up. */
const WRITE_CONNECT_TIMEOUT_MS = 8_000;
/** If the link lasted less than this, treat the drop as "something kicked us off". */
const FLAP_THRESHOLD_MS = 15_000;

/** Internal tuyapi fields we need to poke at to abort a hung connect. */
interface TuyaInternals {
  device?: { ip?: string; version?: string };
  client?: { destroy(): void };
  connectPromise?: unknown;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Thin, resilient wrapper over tuyapi for a single Noah:
 * - discovers IP / protocol version when not configured
 * - keeps an in-memory datapoint cache
 * - reconnects with (short) exponential backoff, and on demand when HomeKit writes
 * - polls periodically so HomeKit stays in sync even if the device drops pushes
 */
export class NoahDevice extends EventEmitter<NoahDeviceEvents> {
  public readonly state: DpsState = {};
  private readonly tuya: TuyAPI;
  private readonly pollIntervalMs: number;
  private pollTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectDelayMs = RECONNECT_MIN_MS;
  private stopped = false;
  private connectInFlight?: Promise<boolean>;
  private connectedAt = 0;
  private flapCount = 0;
  private readonly needsDiscovery: boolean;

  constructor(
    private readonly options: NoahDeviceOptions,
    private readonly log: Logging,
  ) {
    super();
    const version = options.version && options.version !== DEFAULT_PROTOCOL_VERSION ? options.version : undefined;
    this.needsDiscovery = !options.ip || !version;
    this.pollIntervalMs = Math.max(5, options.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS) * 1000;

    this.tuya = new TuyAPI({
      id: options.id,
      key: options.key,
      ip: options.ip,
      // tuyapi defaults to 3.1; most current Stadler Form units speak 3.3+. find() overrides this
      // with the version the device advertises when discovery runs.
      version: version ?? '3.3',
      issueGetOnConnect: true,
      issueRefreshOnConnect: false,
    });

    this.tuya.on('connected', () => {
      this.log.info('[%s] Connected to %s (protocol %s)', options.name, this.describeEndpoint(), this.protocolVersion());
      this.connectedAt = Date.now();
      this.reconnectDelayMs = RECONNECT_MIN_MS;
      this.startPolling();
      this.emit('connected');
    });

    this.tuya.on('disconnected', () => {
      const uptime = Date.now() - this.connectedAt;
      this.stopPolling();
      this.emit('disconnected');
      if (this.stopped) {
        return;
      }
      if (uptime < FLAP_THRESHOLD_MS) {
        this.flapCount++;
        this.log.warn('[%s] Disconnected after %ds', options.name, Math.round(uptime / 1000));
        if (this.flapCount === 3) {
          this.log.warn(
            '[%s] Connection keeps dropping. Tuya devices allow one local client at a time: ' +
              'close the Stadler Form / Smart Life app on phones on this network and make sure no other ' +
              'local Tuya integration (tuya-local, LocalTuya, homebridge-tuya) targets this device.',
            options.name,
          );
        }
      } else {
        this.flapCount = 0;
        this.log.warn('[%s] Disconnected', options.name);
      }
      this.scheduleReconnect();
    });

    this.tuya.on('error', (error: unknown) => {
      // tuyapi emits Error objects for socket failures but plain strings for set() timeouts.
      const message = error instanceof Error ? error.message : String(error);
      this.log.debug('[%s] Tuya error: %s', options.name, message);
      if (!this.tuya.isConnected()) {
        this.scheduleReconnect();
      }
    });

    const onData = (data: { dps?: Record<string, unknown> } | undefined) => {
      if (!data || typeof data !== 'object' || !data.dps) {
        return;
      }
      this.applyDps(data.dps);
    };
    this.tuya.on('data', onData);
    this.tuya.on('dp-refresh', onData);
  }

  get name(): string {
    return this.options.name;
  }

  isConnected(): boolean {
    return this.tuya.isConnected();
  }

  /** Begin connecting; never throws. Retries forever until stop() is called. */
  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.stopPolling();
    this.clearReconnectTimer();
    this.tuya.disconnect();
  }

  /** Write one or more datapoints. Reconnects on demand if needed. Resolves once the device acknowledges. */
  async set(values: Partial<Record<number, DpsValue>>): Promise<void> {
    const entries = Object.entries(values).filter(([, v]) => v !== undefined) as Array<[string, DpsValue]>;
    if (entries.length === 0) {
      return;
    }
    if (!this.tuya.isConnected()) {
      this.log.info('[%s] Not connected, reconnecting before write', this.options.name);
      const ok = await this.ensureConnected(WRITE_CONNECT_TIMEOUT_MS);
      if (!ok) {
        throw new Error(`${this.options.name} is not connected`);
      }
    }
    this.log.debug('[%s] set %j', this.options.name, Object.fromEntries(entries));

    if (entries.length === 1) {
      const [dps, value] = entries[0];
      await this.tuya.set({ dps: Number(dps), set: value, shouldWaitForResponse: true });
    } else {
      await this.tuya.set({ multiple: true, data: Object.fromEntries(entries), shouldWaitForResponse: true });
    }
    // Optimistically merge so immediate reads reflect the write even if the device
    // only echoes a subset of the changed dps.
    this.applyDps(Object.fromEntries(entries));
  }

  /** Ask the device for its full state. Result is delivered via the 'state' event. */
  async refresh(): Promise<void> {
    if (!this.tuya.isConnected()) {
      return;
    }
    try {
      const result = await this.tuya.get({ schema: true });
      if (result && typeof result === 'object' && 'dps' in result) {
        this.applyDps(result.dps as Record<string, unknown>);
      }
    } catch (error) {
      this.log.debug('[%s] Poll failed: %s', this.options.name, (error as Error).message);
    }
  }

  private applyDps(incoming: Record<string | number, unknown>): void {
    const changed = mergeDps(this.state, incoming);
    if (changed.length > 0) {
      this.log.debug('[%s] dps changed %j -> %j', this.options.name, changed, this.state);
      this.emit('state', changed, this.state);
    }
  }

  /**
   * Connect now (cancelling any pending backoff timer) and wait up to `timeoutMs` for it.
   * Returns true if connected at the end, false otherwise. Never throws.
   */
  private async ensureConnected(timeoutMs: number): Promise<boolean> {
    if (this.tuya.isConnected()) {
      return true;
    }
    this.clearReconnectTimer();
    try {
      return await withTimeout(this.connect(), timeoutMs, 'reconnect');
    } catch {
      return false;
    }
  }

  /** Single-flight connect. Resolves true on success, false on failure (and schedules a retry). */
  private connect(): Promise<boolean> {
    if (this.stopped) {
      return Promise.resolve(false);
    }
    if (this.tuya.isConnected()) {
      return Promise.resolve(true);
    }
    if (this.connectInFlight) {
      return this.connectInFlight;
    }
    this.connectInFlight = this.doConnect().finally(() => {
      this.connectInFlight = undefined;
    });
    return this.connectInFlight;
  }

  private async doConnect(): Promise<boolean> {
    try {
      if (this.needsDiscovery) {
        this.log.debug('[%s] Discovering device on LAN (id %s)', this.options.name, this.options.id);
        await this.tuya.find({ timeout: DISCOVERY_TIMEOUT_S });
      }
      await withTimeout(this.tuya.connect(), CONNECT_TIMEOUT_MS, 'connect');
      return true;
    } catch (error) {
      this.log.warn('[%s] Connection failed: %s', this.options.name, (error as Error).message);
      this.abortConnect();
      this.scheduleReconnect();
      return false;
    }
  }

  /**
   * tuyapi leaves a half-open socket and a pending connectPromise behind when the 3.4/3.5
   * session-key handshake stalls; tear it down so the next connect() starts clean.
   */
  private abortConnect(): void {
    if (this.tuya.isConnected()) {
      return;
    }
    const internals = this.tuya as unknown as TuyaInternals;
    try {
      internals.client?.destroy();
    } catch {
      /* ignore */
    }
    delete internals.connectPromise;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(RECONNECT_MAX_MS, this.reconnectDelayMs * 2);
    this.log.debug('[%s] Reconnecting in %ds', this.options.name, Math.round(delay / 1000));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => void this.refresh(), this.pollIntervalMs);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private describeEndpoint(): string {
    return (this.tuya as unknown as TuyaInternals).device?.ip ?? this.options.ip ?? 'unknown ip';
  }

  private protocolVersion(): string {
    return (this.tuya as unknown as TuyaInternals).device?.version ?? this.options.version ?? '?';
  }
}
