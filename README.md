# homebridge-stadler-form-noah

Homebridge plugin that brings the **Stadler Form Noah** and **Noah Pro** humidifiers into Apple Home.

It talks to the humidifier **directly on your LAN** using the Tuya local protocol (the Stadler Form app
is a rebranded Tuya / Smart Life app). No cloud round-trip, no polling of Tuya servers, and it keeps
working if Stadler Form's cloud is down. You do need a one-time trip to the Tuya developer portal to
obtain the device's *local key*.

## What you get in the Home app

| Home app control | Humidifier function | Tuya DP |
| --- | --- | --- |
| Power | On / off | 1 |
| Mode: **Auto** / **Humidify** | Auto (hygrostat) mode on / off | 103 |
| Target humidity slider (30–80 %, 5 % steps) | Target humidity. 80 % = continuous | 101 |
| Current humidity | Measured room humidity | 13 |
| Fan speed (20 / 40 / 60 / 80 / 100 %), via Siri/automations or the optional Fan tile | Fan level 1–5 (5 = Turbo) | 102 |
| Child lock | Child lock | 29 |
| Water level | Tank level (0 / 25 / 50 / 75 / 100 %) | 17 |
| Filter life and "replace filter" badge | Filter life %, filter reminder | 33, 104 |
| *Optional* light tile "Display" | LED brightness Normal / Dimmer / Off | 105 |
| *Optional* contact sensor "Water Tank" | Opens when the tank is empty | 22 |

State changes made on the device or in the Stadler Form app are pushed to HomeKit immediately; a
periodic poll (default 30 s) keeps everything in sync as a fallback.

## Requirements

- Homebridge 1.8 or newer (2.x supported)
- Node.js 20, 22, 24 or 26
- The humidifier paired to Wi-Fi with the Stadler Form app (or Smart Life / Tuya Smart)
- Homebridge on the same network as the humidifier (or a known IP + protocol version if not)

## Installation

Search for **Stadler Form Noah** in the Homebridge UI plugin page, or:

```bash
npm install -g homebridge-stadler-form-noah
```

## Getting the Device ID and Local Key

The Tuya local protocol needs each device's **Device ID** and **Local Key**. The quickest way:

1. Pair the Noah with the **Stadler Form** app if you haven't already.
2. Create a free account at <https://iot.tuya.com>, create a **Cloud project** (any name, "Smart Home"
   development method, pick the data centre that matches your app region).
3. In the project open **Devices → Link Tuya App Account → Add App Account**, scan the QR code from
   the Stadler Form app (*Me → Settings → ... → scan*; in Smart Life it's *Me → scan icon*).
   Your humidifier now appears under Devices with its **Device ID**.
4. Fetch the local key with the TinyTuya wizard (needs Python 3):

   ```bash
   pip install tinytuya
   python -m tinytuya wizard
   ```

   Enter the project's Access ID / Secret and region. The wizard writes `devices.json` containing
   `id`, `key` and, if the device is online, its `ip` and `version`.

More detail: [TinyTuya setup guide](https://github.com/jasonacox/tinytuya#setup-wizard-getting-local-keys).

> **Note** The local key changes whenever the device is removed and re-paired in the app. If the
> plugin stops connecting after a re-pair, fetch the key again.

## Configuration

Via the Homebridge UI, or in `config.json`:

```json
{
  "platforms": [
    {
      "platform": "StadlerFormNoah",
      "name": "Stadler Form Noah",
      "devices": [
        {
          "name": "Bedroom Humidifier",
          "id": "bf1234567890abcdef12",
          "key": "0123456789abcdef",
          "model": "Noah",
          "exposeWaterTankSensor": true
        }
      ]
    }
  ]
}
```

| Key | Required | Default | Description |
| --- | --- | --- | --- |
| `name` | yes | | Name in the Home app |
| `id` | yes | | Tuya device ID |
| `key` | yes | | Tuya local key |
| `ip` | no | discovered | Fixed IP. Needed when UDP broadcast discovery can't reach the device (different VLAN, Docker without host networking) |
| `version` | no | `auto` | Tuya protocol version `3.3`, `3.4` or `3.5`. Set this when you set `ip` |
| `model` | no | `Noah` | `Noah` or `Noah Pro` (informational) |
| `pollInterval` | no | `30` | Seconds between full state polls |
| `exposeFanControl` | no | `false` | Add a Fan tile with a 5-step speed slider (Home hides fan speed on humidifier accessories) |
| `exposeDisplayLight` | no | `false` | Add a Lightbulb tile for the LED display |
| `exposeWaterTankSensor` | no | `false` | Add a ContactSensor that opens when the tank is empty |
| `homekitRevision` | no | `0` | Bump by one to re-publish as a new HomeKit accessory and purge Home's cached properties (see Troubleshooting) |
| `filterLifeIsUsed` | no | `false` | Set if Home's filter life is the inverse of the app (device reports % used, not % remaining) |

## Behaviour notes

- **Target humidity** slider runs 0–100 in Home (HomeKit's fixed range); values are rounded to the
  nearest 5 % and clamped to the Noah's 30–80 % range, and the slider snaps once the device confirms.
- The Home app does not show a fan-speed control on humidifier accessories. Use Siri / Shortcuts, or
  enable `exposeFanControl` for a separate Fan tile.
- **Fan speed 0 %** in Home turns the device off (Home sends *Active = off* at the same time); any
  non-zero speed is rounded to the nearest level 1–5.
- **Auto mode** maps to the Home app's *Auto* target state, *Humidify* is manual mode. In Auto the
  current state shows *Idle* once the target humidity is reached.
- **Current state** shows *Idle* while the tank is empty.
- The **display brightness** datapoint (105) is known to be flaky on some firmware: the device may
  accept the command and then revert. It's therefore off by default.
- Only **one local connection** at a time is accepted by Tuya devices. Don't run another local
  integration (tuya-local, LocalTuya, homebridge-tuya) against the same humidifier. The **Stadler
  Form app itself connects locally** when your phone is on the same Wi-Fi and will bump the plugin
  off while it's open; the plugin reconnects automatically (within a few seconds, and immediately
  when you change something in Home), but expect "Disconnected after Ns" log lines while the app is
  in the foreground.

## Upgrading from 0.1.2 or earlier

The humidifier service is re-published under a new HomeKit instance id so the Home app drops the
cached 30–80 % slider range. The accessory keeps its room, but any scenes or automations that
referenced the humidifier itself need to be re-created once.

## Troubleshooting

Run Homebridge with `-D` and look for lines tagged with the device name.

### Home shows a different target humidity on the tile than in the detail view

The Home app caches each characteristic's min/max range. If the tile shows `(value - 30) / 50`
(e.g. 50 % appears as 40 %), Home is still using the 30–80 range from plugin versions before 0.1.2.
Set `homekitRevision` to `1` (or one higher than its current value) and restart Homebridge. The device
is re-published as a new accessory, Home fetches fresh metadata, and you re-assign its room once.

| Symptom | Likely cause |
| --- | --- |
| `Connection failed: find() timed out` | UDP discovery blocked. Set `ip` and `version` explicitly |
| `Disconnected after Ns` repeating | Another local client (usually the Stadler Form app on a phone) is taking the connection |
| `Failed to write ...: not connected` | Device unreachable for 8 s while a reconnect was attempted. Check the device is on the network |
| Connects then immediately disconnects, or writes time out | Wrong `version`. Try `3.4` then `3.5` |
| `ECONNRESET` / `EHOSTUNREACH` loops | Another local client holds the connection, or wrong key |
| All tiles show "No Response" | Plugin hasn't received any state yet. Check the key and that the device is online in the app |

## Installing from source on a Homebridge host

`dist/` is git-ignored, so after every `git pull` (or copy of `src/`) you must rebuild **on the host**:

```bash
cd /path/to/homebridge-stadler-form-noah
npm install          # also runs the build via the "prepare" script
npm run build        # explicit rebuild after later pulls
```

Then restart Homebridge. The first log line from the plugin prints the version **and build time** of the
compiled code that is actually running, followed by the humidity range served to HomeKit:

```
homebridge-stadler-form-noah 0.1.5 (built 2026-10-09T08:00:00.000Z)
[Humidifier] Services: ... Target humidity range served to HomeKit: 0-100
```

If the build time is older than your last change, the host is running stale code.

## Development

```bash
npm install
npm run build
npm test          # unit tests for datapoint <-> HomeKit mapping
npm run watch     # rebuild + restart a local homebridge on change
```

## Acknowledgements

Datapoint mapping based on the community
[tuya-local](https://github.com/make-all/tuya-local) device definition for the Noah and the Tuya cloud
model shared in [make-all/tuya-local#4106](https://github.com/make-all/tuya-local/issues/4106).
Built on [tuyapi](https://github.com/codetheweb/tuyapi).

## License

MIT
