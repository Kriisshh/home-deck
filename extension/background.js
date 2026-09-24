// Service worker: opens the Home Deck window and handles Chrome-wide keyboard shortcuts
// (chrome://extensions/shortcuts), which work even when the Deck window isn't focused.

import { AirConditioner } from './lib/ac.js';
import { PcAgent } from './lib/agent.js';
import { loadSettings } from './lib/store.js';
import { installHeaderRules } from './lib/xiaomi.js';

const APP_URL = chrome.runtime.getURL('app.html');

async function openDeck() {
  const [tab] = await chrome.tabs.query({ url: APP_URL });
  if (tab) {
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tab.id, { active: true });
    return;
  }
  const { windowMode } = await loadSettings();
  const win = await chrome.windows.create({ url: APP_URL, type: 'popup', width: 1280, height: 820, focused: true });
  if (windowMode === 'maximized' || windowMode === 'fullscreen') {
    await chrome.windows.update(win.id, { state: windowMode });
  }
}

async function notify(message) {
  // Brief feedback on the toolbar icon for shortcuts used while the Deck window is hidden.
  await chrome.action.setBadgeBackgroundColor({ color: message === '!' ? '#f43f5e' : '#1ed760' });
  await chrome.action.setBadgeText({ text: message });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 1500);
}

const COMMANDS = {
  'media-play-pause': (agent) => agent.mediaCommand('play_pause'),
  'media-next': (agent) => agent.mediaCommand('next'),
  'media-previous': (agent) => agent.mediaCommand('previous'),
  'volume-up': (agent) => agent.setVolume({ target: 'app', delta: 0.05 }).catch(() => agent.setVolume({ target: 'system', delta: 0.05 })),
  'volume-down': (agent) => agent.setVolume({ target: 'app', delta: -0.05 }).catch(() => agent.setVolume({ target: 'system', delta: -0.05 })),
  'ac-power': (_, ac) => ac.togglePower(),
  'ac-warmer': (_, ac) => ac.nudgeTemp(1),
  'ac-cooler': (_, ac) => ac.nudgeTemp(-1),
  'ac-fan-up': (_, ac) => ac.nudgeFan(1),
  'ac-fan-down': (_, ac) => ac.nudgeFan(-1),
};

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'open-deck') return openDeck();
  const run = COMMANDS[command];
  if (!run) return;
  try {
    const settings = await loadSettings();
    const agent = new PcAgent(settings.agentUrl, settings.agentToken);
    let ac = null;
    if (command.startsWith('ac-')) {
      ac = await AirConditioner.fromSettings(settings);
      await ac.refresh();
    }
    await run(agent, ac);
    await notify('✓');
  } catch (err) {
    console.warn(`Command ${command} failed:`, err);
    await notify('!');
  }
});

chrome.action.onClicked.addListener(openDeck);

// The shelf launcher (launcher/ on GitHub Pages, installed as an app) can only ask for one thing:
// open the Home Deck window. It then gets closed so only the Deck window remains.
const LAUNCHER_ORIGIN = 'https://kriisshh.github.io';
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (sender.origin !== LAUNCHER_ORIGIN || message?.type !== 'open-deck') return false;
  openDeck().then(() => {
    sendResponse({ ok: true });
    if (sender.tab?.id) setTimeout(() => chrome.tabs.remove(sender.tab.id).catch(() => {}), 150);
  });
  return true; // respond asynchronously
});

chrome.runtime.onStartup.addListener(async () => {
  await installHeaderRules();
  if ((await loadSettings()).openOnStartup) await openDeck();
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await installHeaderRules();
  // 'update' includes Home Deck's own self-update (lib/updater.js), which reloads the extension.
  if (reason === 'install' || reason === 'update') await openDeck();
});
