import { isFillableUrl } from './match';

export type FillResult = 'filled' | 'no-form' | 'origin-changed' | 'insecure';

/**
 * Wird über chrome.scripting einmalig in den obersten Frame der aktiven Seite eingeschleust (activeTab),
 * es gibt kein dauerhaftes Content-Script. Füllt nur sichtbare Felder und nur, wenn die Seite sich seit
 * der Prüfung nicht geändert hat.
 */
function fillInPage(expectedOrigin: string, username: string, password: string): FillResult {
  if (location.origin !== expectedOrigin) return 'origin-changed';
  const visible = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05;
  };
  const usable = (el: HTMLInputElement) => !el.disabled && !el.readOnly && visible(el);
  const pw = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="password"]')).find(usable);
  const textTypes = ['text', 'email', 'tel', ''];
  const candidates = Array.from(document.querySelectorAll<HTMLInputElement>('input')).filter((el) => textTypes.includes(el.type) && usable(el));
  let user: HTMLInputElement | undefined;
  if (pw) {
    // Benutzerfeld: letztes Textfeld vor dem Passwortfeld (im selben Formular bevorzugt)
    const before = candidates.filter((el) => el.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING);
    user = before.filter((el) => el.form === pw.form).pop() ?? before.pop();
  } else {
    // Mehrstufige Anmeldung: zuerst nur Benutzername
    user = candidates.find((el) => /user|mail|login|name|konto|account/i.test(`${el.name} ${el.id} ${el.autocomplete}`)) ?? candidates[0];
  }
  if (!pw && !user) return 'no-form';
  const set = (el: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    el.focus();
    setter ? setter.call(el, value) : (el.value = value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  if (user && username) set(user, username);
  if (pw && password) set(pw, password);
  (pw ?? user)?.focus();
  return 'filled';
}

/** Füllt die aktive Seite aus; die Seiten-URL wird vorher und im Frame erneut geprüft. */
export async function fillTab(tab: chrome.tabs.Tab, username: string, password: string): Promise<FillResult> {
  if (!tab.id || !tab.url || !isFillableUrl(tab.url)) return 'insecure';
  const origin = new URL(tab.url).origin;
  const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: false }, func: fillInPage, args: [origin, username, password] });
  return (res?.result as FillResult | undefined) ?? 'no-form';
}
