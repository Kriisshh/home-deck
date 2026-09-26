// Settings/session storage: chrome.storage.local inside the extension, localStorage when the page is
// opened as a plain web page (used for the ?demo preview).

const hasChrome = typeof chrome !== 'undefined' && !!chrome.storage?.local;

export const DEFAULT_SETTINGS = {
  region: 'cn',
  acDid: '',
  acModel: '',
  acName: '',
  agentUrl: '',
  agentToken: '',
  wakeUrl: '',
  wakeMethod: 'POST',
  wakeBody: '',
  wakeDevices: '',  // extra devices, one per line: "Name = AA:BB:CC:DD:EE:FF"
  openOnStartup: true,
  windowMode: 'popup',
  appearance: 'auto',
  reduceTransparency: false,
};

export async function load(key, fallback = null) {
  if (hasChrome) return (await chrome.storage.local.get(key))[key] ?? fallback;
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

export async function save(key, value) {
  if (hasChrome) return chrome.storage.local.set({ [key]: value });
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

export async function remove(key) {
  if (hasChrome) return chrome.storage.local.remove(key);
  try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
}

export async function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...(await load('settings', {})) };
}

export function saveSettings(settings) {
  return save('settings', settings);
}

export function onChange(fn) {
  if (hasChrome) chrome.storage.onChanged.addListener((changes, area) => area === 'local' && fn(changes));
}
