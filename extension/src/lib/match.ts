import type { DecryptedItem } from '../../../web/src/lib/types';

/** Hostname ohne führendes "www.", in Kleinbuchstaben. */
function cleanHost(host: string) {
  return host.toLowerCase().replace(/^www\./, '');
}

export function hostFromUrl(url?: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.includes('://') ? url : `https://${url}`);
    return u.protocol === 'http:' || u.protocol === 'https:' ? cleanHost(u.hostname) : null;
  } catch {
    return null;
  }
}

/**
 * Passt ein Eintrag zur Seite? Nur bei exakt gleichem Host (ein führendes "www." zählt nicht).
 * Bewusst keine Subdomains: Unter vielen Domains können Dritte eigene Subdomains betreiben
 * (Hosting-Anbieter, Kundenbereiche, übernommene DNS-Einträge), die sonst das Passwort erhielten.
 */
export function matchesPage(item: DecryptedItem, pageUrl: string): boolean {
  if (item.type !== 'LOGIN') return false;
  const page = hostFromUrl(pageUrl);
  const stored = hostFromUrl(item.overview.url);
  return !!page && page === stored;
}

/** Ausfüllen nur auf verschlüsselten Seiten; unverschlüsselt ausschließlich lokal (Entwicklung). */
export function isFillableUrl(pageUrl: string): boolean {
  try {
    const u = new URL(pageUrl);
    if (u.protocol === 'https:') return true;
    return !__STORE_BUILD__ && u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}
