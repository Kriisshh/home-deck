// Self-updater for the unpacked extension.
//
// Chrome can't update an unpacked extension by itself, so Home Deck does it: the user links the
// folder it was loaded from once (File System Access API). On each start we compare our version
// with extension/manifest.json on GitHub, and when it's newer we download every file under
// extension/, check each one against the Git blob hash GitHub publishes for it, write them into the
// folder and reload. Files only ever come from this repository, over HTTPS.

const REPO = 'Kriisshh/home-deck';
const BRANCH = 'main';
const API = `https://api.github.com/repos/${REPO}`;
// Files are fetched by commit SHA: those URLs never change, so GitHub's 5-minute CDN cache on
// branch URLs (raw .../main/...) can't serve an old version right after a release.
const raw = (sha, path) => `https://raw.githubusercontent.com/${REPO}/${sha}/${path.split('/').map(encodeURIComponent).join('/')}`;
const PREFIX = 'extension/';

// ---------------------------------------------------------------- tiny IndexedDB store for the folder handle
// (handles can't go into chrome.storage, but IndexedDB can hold them)

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('home-deck', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function kv(mode, fn) {
  const conn = await db();
  return new Promise((resolve, reject) => {
    const tx = conn.transaction('kv', mode);
    const req = fn(tx.objectStore('kv'));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}

const getHandle = () => kv('readonly', (s) => s.get('extensionDir'));
const setHandle = (h) => kv('readwrite', (s) => s.put(h, 'extensionDir'));
export const unlinkFolder = () => kv('readwrite', (s) => s.delete('extensionDir'));

// ---------------------------------------------------------------- versions

export const currentVersion = () => chrome.runtime.getManifest().version;

export function isNewer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

async function latestCommit() {
  const res = await fetch(`${API}/commits/${BRANCH}`, { cache: 'no-store', headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}`);
  return (await res.json()).sha;
}

/** { version, sha } of the newest release on GitHub. */
export async function latestVersion() {
  const sha = await latestCommit();
  const res = await fetch(raw(sha, `${PREFIX}manifest.json`));
  if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}`);
  return { version: (await res.json()).version, sha };
}

// ---------------------------------------------------------------- folder link

/** Ask the user for the folder Home Deck was loaded from, and check it really is that folder. */
export async function linkFolder() {
  const dir = await showDirectoryPicker({ id: 'home-deck-extension', mode: 'readwrite' });
  let manifest;
  try {
    manifest = JSON.parse(await (await (await dir.getFileHandle('manifest.json')).getFile()).text());
  } catch {
    throw new Error("That folder doesn't contain Home Deck's manifest.json - pick the folder you loaded the extension from");
  }
  if (manifest.name !== chrome.runtime.getManifest().name) throw new Error("That folder holds a different extension");
  await verifyLoadedFolder(dir);
  await setHandle(dir);
  return dir.name;
}

/**
 * Prove `dir` is the exact folder Chrome runs Home Deck from, and that it's writable: write a
 * random probe file into it and read it back through Home Deck's own chrome-extension:// URL.
 * (Unpacked extensions are served live from disk.)
 */
export async function verifyLoadedFolder(dir) {
  const name = `link-check-${crypto.randomUUID().slice(0, 8)}.txt`;
  const value = crypto.randomUUID();
  try {
    await writeFile(dir, name, new TextEncoder().encode(value));
  } catch {
    throw new Error("Home Deck can't write to that folder. If you loaded it straight from the zip, copy the extension folder into My files, load that copy in chrome://extensions, and pick it here.");
  }
  let seen = null;
  try {
    seen = await (await fetch(chrome.runtime.getURL(name), { cache: 'no-store' })).text();
  } catch { /* not served: different folder */ }
  await dir.removeEntry(name).catch(() => {});
  if (seen !== value) {
    throw new Error('That is a different copy of Home Deck from the one Chrome runs. In chrome://extensions, open Home Deck → Details and pick the folder shown under "Loaded from".');
  }
}

/** 'none' (not linked) | 'granted' | 'prompt' (needs a tap to re-allow access) */
export async function folderStatus() {
  const dir = await getHandle();
  if (!dir) return { state: 'none' };
  return { state: await dir.queryPermission({ mode: 'readwrite' }), name: dir.name };
}

// ---------------------------------------------------------------- install

async function gitBlobSha(bytes) {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(header.length + bytes.length);
  all.set(header);
  all.set(bytes, header.length);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-1', all))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function writeFile(root, path, bytes) {
  const parts = path.split('/');
  let dir = root;
  for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
  const writable = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
  await writable.write(bytes);
  await writable.close();
}

/**
 * Download the latest extension files, verify them, write them into the linked folder and reload.
 * `target` defaults to the linked folder; tests can pass any FileSystemDirectoryHandle.
 * Must be called from a user gesture if the folder permission is 'prompt'.
 */
export async function installUpdate({ target, sha, reload = true, onStatus = () => {} } = {}) {
  const dir = target ?? await getHandle();
  if (!dir) throw new Error('Link the extension folder in Settings first');
  if (!target && (await dir.requestPermission({ mode: 'readwrite' })) !== 'granted') {
    throw new Error('Home Deck needs access to its folder to update itself');
  }

  onStatus('Checking files…');
  sha ??= await latestCommit();
  const treeRes = await fetch(`${API}/git/trees/${sha}?recursive=1`);
  if (!treeRes.ok) throw new Error(`GitHub returned HTTP ${treeRes.status}`);
  const files = (await treeRes.json()).tree.filter((t) => t.type === 'blob' && t.path.startsWith(PREFIX));
  if (!files.some((f) => f.path === `${PREFIX}manifest.json`)) throw new Error('The update on GitHub looks incomplete');

  // Download and verify everything before touching the folder, so a failed update changes nothing.
  onStatus(`Downloading ${files.length} files…`);
  const downloads = await Promise.all(files.map(async (f) => {
    const res = await fetch(raw(sha, f.path));
    if (!res.ok) throw new Error(`Couldn't download ${f.path} (HTTP ${res.status})`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if ((await gitBlobSha(bytes)) !== f.sha) {
      throw new Error(`Downloaded ${f.path} doesn't match GitHub's checksum - try again`);
    }
    return [f.path.slice(PREFIX.length), bytes];
  }));
  const manifest = JSON.parse(new TextDecoder().decode(downloads.find(([p]) => p === 'manifest.json')[1]));
  if (manifest.name !== chrome.runtime.getManifest().name) throw new Error('The update on GitHub is not Home Deck');

  onStatus(`Installing ${manifest.version}…`);
  // manifest.json last: if writing stops half-way, Chrome keeps loading a consistent old manifest.
  downloads.sort(([a], [b]) => (a === 'manifest.json') - (b === 'manifest.json'));
  for (const [path, bytes] of downloads) await writeFile(dir, path, bytes);

  if (!target) {
    // Make sure Chrome will actually load what we just wrote before reloading into it.
    const served = await (await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' })).json().catch(() => ({}));
    if (served.version !== manifest.version) {
      await unlinkFolder();
      throw new Error('The linked folder is not the one Chrome runs Home Deck from. Link the folder shown under "Loaded from" in chrome://extensions → Home Deck → Details.');
    }
  }
  await chrome.storage.local.set({ 'update.justInstalled': manifest.version });
  if (reload) chrome.runtime.reload();
  return manifest.version;
}
