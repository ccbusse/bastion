/** Kopieren aus dem Popup; der Service Worker leert die Zwischenablage nach 30 Sekunden (auch wenn das Popup geschlossen ist). */
export async function copySecret(value: string) {
  await navigator.clipboard.writeText(value);
  await chrome.runtime.sendMessage({ type: 'schedule-clipboard-clear' }).catch(() => undefined);
}
