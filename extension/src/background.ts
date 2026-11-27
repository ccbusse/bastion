import { fillTab } from './lib/fill';
import { isFillableUrl, matchesPage } from './lib/match';
import { getSession, restrictSessionStorage } from './lib/storage';
import { KEEPALIVE_ALARM, LOCK_ALARM, keepAlive, loadKeys, loadVault, lock, logEvent, sessionInfo, touch } from './lib/vault';

const CLIPBOARD_ALARM = 'bastion-clear-clipboard';

chrome.runtime.onInstalled.addListener(() => void restrictSessionStorage());
chrome.runtime.onStartup.addListener(() => void restrictSessionStorage());
void restrictSessionStorage();

// Automatische Sperre nach Inaktivität und sofort, wenn das Betriebssystem gesperrt wird
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === LOCK_ALARM) void lock();
  if (alarm.name === CLIPBOARD_ALARM) void clearClipboard();
  if (alarm.name === KEEPALIVE_ALARM) void enforceLock().then(keepAlive);
});
chrome.idle.onStateChanged.addListener((state) => {
  if (state === 'locked') void lock();
});

// Sicherheitsnetz, falls ein Alarm verpasst wurde (Service Worker war beendet)
async function enforceLock() {
  const { lockAt } = await getSession();
  if (lockAt && Date.now() >= lockAt) await lock();
}

chrome.runtime.onMessage.addListener((msg: { type?: string }, sender, sendResponse) => {
  // Nachrichten nur von eigenen Erweiterungsseiten annehmen
  if (sender.id !== chrome.runtime.id || sender.tab) return false;
  if (msg.type === 'schedule-clipboard-clear') {
    void chrome.alarms.create(CLIPBOARD_ALARM, { when: Date.now() + 30_000 });
    sendResponse({ ok: true });
  } else if (msg.type === 'touch') {
    void enforceLock().then(touch);
    sendResponse({ ok: true });
  }
  return false;
});

/**
 * Zwischenablage leeren. Chrome: über ein unsichtbares Offscreen-Dokument (Service Worker haben keinen Zugriff darauf).
 * Firefox: die Hintergrundseite ist ein echtes Dokument und darf mit clipboardWrite direkt schreiben.
 */
async function clearClipboard() {
  if (__FIREFOX__) {
    await navigator.clipboard.writeText('').catch(() => {
      const onCopy = (e: ClipboardEvent) => {
        e.preventDefault();
        e.clipboardData?.setData('text/plain', '');
      };
      document.addEventListener('copy', onCopy, { once: true });
      document.execCommand('copy');
    });
    return;
  }
  const url = chrome.runtime.getURL('offscreen.html');
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT], documentUrls: [url] });
  if (!contexts.length) {
    await chrome.offscreen.createDocument({ url, reasons: [chrome.offscreen.Reason.CLIPBOARD], justification: 'Kopierte Passwörter nach 30 Sekunden aus der Zwischenablage entfernen' });
  }
  await chrome.runtime.sendMessage({ type: 'offscreen-clear-clipboard' }).catch(() => undefined);
  await chrome.offscreen.closeDocument().catch(() => undefined);
}

/** Tastenkürzel: genau ein passender Eintrag wird ausgefüllt, sonst öffnet sich das Popup zur Auswahl. */
chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'fill-login') return;
  void (async () => {
    await enforceLock();
    const s = await getSession();
    if (!tab?.url || !s.accountKeyRaw || !isFillableUrl(tab.url)) return chrome.action.openPopup().catch(() => undefined);
    try {
      const info = await sessionInfo();
      const keys = await loadKeys(info);
      if (!keys) return chrome.action.openPopup().catch(() => undefined);
      const matches = (await loadVault(info, keys, '')).filter((i) => matchesPage(i, tab.url!) && i.secret?.password);
      if (matches.length !== 1) return chrome.action.openPopup().catch(() => undefined);
      const item = matches[0];
      const result = await fillTab(tab, item.overview.username ?? '', item.secret!.password);
      if (result === 'filled') {
        await logEvent(item, 'autofill');
        await touch();
      }
    } catch {
      await chrome.action.openPopup().catch(() => undefined);
    }
  })();
});
