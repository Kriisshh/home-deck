# Home Deck

A touch control panel for the Surface Laptop (Chrome OS Flex) that works **without Linux, Home
Assistant or HASS.Agent**:

| Feature | How it works | Needs |
|---|---|---|
| Mi Home AC (power, temp ±, fan ±, modes, swing, eco/sleep/…) | Talks to the Xiaomi cloud directly, like the Mi Home app | Internet; one QR sign-in |
| Spotify on the main PC (now playing, art, play/pause/next/prev, seek, shuffle, repeat, volume) | Home Deck agent on the PC reads Windows' media controls | PC on, agent running |
| Deck buttons (Stream Deck–style) + keybinds | Agent runs actions you define in `pc-agent/config.json` | PC on, agent running |
| Wake PC | Calls a URL on an always-on wake device (add one later) | e.g. ESP32 + ESPHome |

```
Surface (Chrome extension) ──HTTPS──► Xiaomi cloud ──► AC
          │
          └──LAN http:8765──► PC agent (Python) ──► Spotify / keystrokes / apps
```

## Setup

About 10 minutes. Do the PC part first, because the laptop needs the address and token it prints.

### Part A: Main PC (Windows)

Needs Python 3.11+ ([python.org](https://www.python.org/downloads/)).

1. Open PowerShell in the `pc-agent` folder and run:
   ```powershell
   powershell -ExecutionPolicy Bypass -File setup.ps1
   ```
   This installs what the agent needs, makes it start (hidden) every time you log in, starts it
   now, and prints two lines you'll need on the laptop:
   ```
   Agent URL:   http://192.168.1.xx:8765
   Agent token: xxxxxxxxxxxxxxxx
   ```
   (You can see them again any time in `pc-agent/config.json`.)
2. Let the laptop reach the agent through Windows Firewall. Open PowerShell **as Administrator**
   (Start → type *PowerShell* → *Run as administrator*) and run:
   ```powershell
   New-NetFirewallRule -DisplayName 'Home Deck Agent' -Direction Inbound -Protocol TCP -LocalPort 8765 -Profile Private -Action Allow
   ```
3. Optional but recommended: in the Huawei router's admin page, give the PC a fixed IP (DHCP
   reservation), so the Agent URL never changes.

### Part B: Surface (Chrome OS Flex)

1. **Download.** On the Surface, open this repository on GitHub in Chrome, open the `dist` folder, click
   `home-deck-extension.zip`, then click the **Download raw file** button (↓).
2. **Extract.** Open the **Files** app → **Downloads** → double-click the zip (it opens like a folder) →
   copy the `extension` folder out into **My files** (for example `My files/Home Deck`).
   Keep this folder: Chrome runs the extension from it, so don't delete it later.
3. **Install.** Go to `chrome://extensions` → turn on **Developer mode** (top right) → **Load unpacked**
   → select the `extension` folder you just copied.
4. **Pin it.** Click the puzzle-piece icon in Chrome's toolbar → pin **Home Deck**. Clicking it (or
   **Alt+Shift+D**) opens the panel, and it opens on its own every time Chrome starts.
5. **Connect**, in the panel's ⚙ Settings:
   - **Mi Home → Sign In with QR Code.** On your phone: Mi Home app → **+** → **Scan** → confirm.
     Region *Mainland China*, then pick your AC under **Air Conditioner**.
   - **Main PC:** paste the Agent URL and token from Part A. Chrome asks to allow access to the PC;
     click **Allow**.
   - Tap **Done**. The *Mi Home* and *PC* dots at the top turn green.

**Updating later:** download the new zip, replace the files in your `extension` folder, then click the
↻ reload icon on Home Deck's card in `chrome://extensions`. Your settings and sign-in are kept.

## Keyboard shortcuts

Inside the panel (press **?** to see them): **Space** play/pause · **← →** prev/next · **S** shuffle ·
**R** repeat · **= / -** volume · **M** mute · **↑ ↓** AC temperature · **[ ]** fan · **P** AC power ·
**W** wake PC · **1–9** deck buttons · **,** settings.

Anywhere in Chrome (change at `chrome://extensions/shortcuts`): **Alt+Shift+D** open deck,
**Alt+Shift+P** play/pause, **Alt+Shift+. / ,** next/previous. AC power/temperature/fan and volume can
be given shortcuts there too.

## Adding deck buttons

Edit `pc-agent/config.json`. It reloads automatically, and the laptop picks up changes within 30 s.

```json
{ "id": "obs-rec", "label": "Record", "icon": "⏺️", "type": "hotkey", "keys": ["ctrl", "shift", "r"], "color": "#ef4444", "key": "q" }
```

| `type` | Fields | Does |
|---|---|---|
| `hotkey` | `keys` (e.g. `["win","shift","s"]`) | Presses a key combo |
| `text` | `text` | Types text |
| `run` | `command` (string or list), `cwd` | Starts a program |
| `open` | `target` | Opens a URL, file or folder |
| `shell` | `command` | Runs a hidden PowerShell command |
| `media` | `command`: `play_pause` `next` `previous` `shuffle` `repeat` | Media control |
| `volume` | `target` (`system`/`app`), `level` / `delta` / `muted` | Volume |
| `mic_mute` | `muted` (optional) | Toggles the default microphone |
| `lock` · `sleep` · `shutdown` · `restart` | `delay` (shutdown/restart) | Power |
| `multi` | `steps`: list of actions, `{ "delay_ms": 500 }` for pauses | Macro |

Optional on every action: `icon` (emoji), `color`, `group` (section heading), `confirm: true`
(tap twice), `key` (keyboard shortcut in the panel, e.g. `"q"`, `"shift+f1"`; otherwise the first nine
buttons get 1–9).

Keystrokes go to whichever window is focused on the PC. Windows blocks sending them to apps running
as administrator unless the agent also runs as administrator.

## Wake-on-LAN (later)

Chrome can't send Wake-on-LAN packets, and the Huawei AX2 Pro has no usable WoL, so you'll need a
small always-on sender. Easiest is an **ESP32/ESP8266 with ESPHome** (flash it from Chrome at
web.esphome.io, which works on Chrome OS):

```yaml
esphome: { name: wake-pc }
esp32: { board: esp32dev }          # or esp8266: { board: d1_mini }
wifi: { ssid: "YOUR_WIFI", password: "YOUR_WIFI_PASSWORD" }
web_server: { port: 80 }
button:
  - platform: wake_on_lan
    name: "Wake PC"
    id: wake_pc
    target_mac_address: AA:BB:CC:DD:EE:FF   # the PC's Ethernet MAC
```

Then in Settings → Wake PC: `POST http://wake-pc.local/button/wake_pc/press` (or the board's IP;
newer ESPHome versions may use `/button/Wake%20PC/press`, so open `http://wake-pc.local` to check).
Any other device that can wake the PC from an HTTP request works the same way.

## Files

- `extension/`: the Chrome extension (`app.*` = panel, `background.js` = shortcuts/startup, `lib/xiaomi.js` = Mi cloud protocol)
- `pc-agent/`: Windows agent (`agent.py`), `config.json` (your token + buttons, created on first run), `agent.log`
- `dist/home-deck-extension.zip`: the extension, zipped for downloading on the laptop

Troubleshooting: the Mi Home / PC dots in the panel header go green when connected. Open the panel's
Settings to see agent errors, and check `pc-agent/agent.log` on the PC.
