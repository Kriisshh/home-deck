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

### Automatic updates

- **PC:** nothing to do. Every time you log in, the agent pulls the latest version from GitHub before it
  starts (see `pc-agent/update.log`).
- **Surface:** one-time step. In Home Deck → ⚙ Settings → **Updates** → **Choose Extension Folder…**, pick
  the `extension` folder you loaded (e.g. `My files/Home Deck/extension`) and allow access. From then on,
  Home Deck checks GitHub each time it opens, installs new versions itself and reloads. If Chrome asks
  to re-confirm folder access, a blue **Update** button appears at the top; one tap installs it.
  Files only come from this repository and are checked against GitHub's checksums first.

## Keyboard shortcuts

Plain key presses never do anything on the panel, so a stray key can't touch the PC or the AC.

- **Spotify:** the keyboard's **Play/Pause, Next and Previous media keys** control Spotify on the PC
  (anywhere in Chrome). If your keyboard has no media keys, assign any combo at
  `chrome://extensions/shortcuts`.
- **Anywhere in Chrome** (`chrome://extensions/shortcuts`): **Alt+Shift+D** opens the panel. AC
  power/temperature/fan and Spotify volume can be given shortcuts there too.
- **Shortcut buttons:** only fire from the keyboard if you give them a `"key"` in `config.json`
  (e.g. `"ctrl+shift+1"`). Otherwise they're tap-only.
- In the panel, **?** shows the list and **,** opens Settings.

## Shortcut buttons

Tap **Edit** on the Shortcuts card to add, remove, rename, reorder and group buttons, pick icons, choose
what each does and which key it sends. The **Function Keys** list shows which button uses each of
F13–F24 (tap an unused one to create a button for it) and flags conflicts. Changes are saved to
`pc-agent/config.json` on the PC.

Buttons that run programs or commands (`run`, `shell`, opening a file/program) can be renamed, moved or
deleted from the panel, but only *added* in `config.json` on the PC, so the token alone can never be
used to run arbitrary code.

### Game-safe keybinds (the Stream Deck way)

For apps that only react to a keybind (Discord, OBS, …), use the keys **F13–F24**. Windows supports
them, but they aren't on physical keyboards, so no game ever uses them. To bind one, open the app's
keybind setting, click *record*, and tap the button on the Surface. The default **Discord mute**
button sends **F13**: in Discord → Settings → Keybinds → *Add a Keybind* → *Toggle Mute* → record →
tap **Discord mute**. Need more? Combine them: `["ctrl", "f13"]`, `["shift", "f14"]`, …

```json
{ "id": "obs-rec", "label": "Record", "icon": "⏺️", "type": "hotkey", "keys": ["f14"], "color": "#ef4444" }
```

### Action types

| `type` | Fields | Does |
|---|---|---|
| `mic_mute` | `muted` (optional) | Toggles the default microphone directly |
| `screenshot` | | Opens the Snipping Tool overlay |
| `show_desktop` | | Shows/restores the desktop |
| `task_manager` | | Opens Task Manager |
| `hotkey` | `keys` (e.g. `["f13"]`) | Presses a key combo in the focused window, so prefer F13–F24 |
| `text` | `text` | Types text |
| `run` | `command` (string or list), `cwd` | Starts a program |
| `open` | `target` | Opens a URL, file or folder |
| `shell` | `command` | Runs a hidden PowerShell command |
| `media` | `command`: `play_pause` `next` `previous` `shuffle` `repeat` | Spotify control (direct, no keystrokes) |
| `volume` | `target` (`system`/`app`), `level` / `delta` / `muted` | Volume |
| `lock` · `sleep` · `shutdown` · `restart` | `delay` (shutdown/restart) | Power |
| `multi` | `steps`: list of actions, `{ "delay_ms": 500 }` for pauses | Macro |

Everything except `hotkey` and `text` works without sending keystrokes, so none of it can reach a game.

Optional on every action: `icon` (emoji), `color`, `group` (section heading), `confirm: true`
(tap twice), `key` (panel keyboard shortcut, e.g. `"ctrl+shift+1"`).

## Pin Home Deck to the shelf

Home Deck → ⚙ Settings → **Add to Shelf…** opens a small launcher page (hosted from this repository on
GitHub Pages). Install it (**Install** button, or Chrome menu → *Cast, save and share* → *Install page
as app…*), then in the Launcher right-click **Home Deck** → **Pin to shelf**. Tapping it opens the
Home Deck window and the launcher closes itself; the extension accepts only that one request from it.

## Wake-on-LAN via the Surface's Linux container

Chrome can't send Wake-on-LAN packets, but the Chrome OS Linux container can. In the Terminal
(penguin), run once:

```sh
curl -fsSL https://raw.githubusercontent.com/Kriisshh/home-deck/main/linux/install.sh | sh
```

That installs a tiny wake service (`linux/wol-server.py`) that starts whenever Linux runs. Then in
Home Deck → Settings → Wake PC tap **Use Chrome OS Linux (penguin)** → **Done**. The Wake button works
while Linux is running.

## Wake-on-LAN with extra hardware (alternative)

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
