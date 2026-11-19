/**
 * Masterpasswort-Richtlinie, angelehnt an BSI IT-Grundschutz ORP.4.A8/A22 und die BSI-Empfehlungen zu sicheren Passwörtern:
 *  - mindestens 12 Zeichen
 *  - Zeichenvielfalt abhängig von der Länge (12+ Zeichen: 4 Zeichenarten, 16+: 3, 20+: 2 – lange Passphrasen bevorzugt)
 *  - hohe geschätzte Stärke (zxcvbn-Score ≥ 3), keine Wörterbuch- und Tastaturmuster
 *  - kein Bezug zu Name oder E-Mail-Adresse
 *  - nicht in bekannten Datenlecks enthalten (HaveIBeenPwned, k-Anonymity)
 * Bei Zero-Knowledge kann der Server das Passwort nicht prüfen – die Prüfung erfolgt im Client.
 */
import { post } from './api';
import { toHex, utf8 } from './crypto/encoding';

type Zxcvbn = (password: string, userInputs?: string[]) => import('@zxcvbn-ts/core').ZxcvbnResult;
let zxcvbnPromise: Promise<Zxcvbn> | null = null;

export function loadZxcvbn(): Promise<Zxcvbn> {
  if (!zxcvbnPromise) {
    zxcvbnPromise = (async () => {
      const [core, common, de, en] = await Promise.all([
        import('@zxcvbn-ts/core'),
        import('@zxcvbn-ts/language-common'),
        import('@zxcvbn-ts/language-de'),
        import('@zxcvbn-ts/language-en'),
      ]);
      const factory = new core.ZxcvbnFactory({
        dictionary: { ...common.dictionary, ...de.dictionary, ...en.dictionary },
        graphs: common.adjacencyGraphs,
        translations: en.translations,
      });
      return (password, userInputs) => factory.check(password, userInputs);
    })();
  }
  return zxcvbnPromise;
}

export const MIN_LENGTH = 12;

export interface PolicyResult {
  score: number;
  checks: { length: boolean; variety: boolean; strength: boolean; personal: boolean };
  valid: boolean;
}

export function charClasses(pw: string) {
  return [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
}

export async function evaluatePassword(pw: string, userInputs: string[] = []): Promise<PolicyResult> {
  const zxcvbn = await loadZxcvbn();
  const inputs = userInputs.flatMap((s) => s.toLowerCase().split(/[@.\s_-]+/)).filter((s) => s.length >= 4);
  const score = pw ? zxcvbn(pw, inputs).score : 0;
  const classes = charClasses(pw);
  const len = [...pw].length;
  const lower = pw.toLowerCase();
  const checks = {
    length: len >= MIN_LENGTH,
    variety: (len >= 12 && classes >= 4) || (len >= 16 && classes >= 3) || (len >= 20 && classes >= 2),
    strength: score >= 3,
    personal: pw.length > 0 && !inputs.some((i) => lower.includes(i)),
  };
  return { score, checks, valid: Object.values(checks).every(Boolean) };
}

/** HIBP-Prüfung: nur die ersten 5 Hex-Zeichen des SHA-1-Hashes verlassen den Browser. Ergebnis: Anzahl Funde, null = nicht prüfbar. */
export async function breachCount(pw: string): Promise<number | null> {
  try {
    const hash = toHex(new Uint8Array(await crypto.subtle.digest('SHA-1', utf8(pw)))).toUpperCase();
    const body = await post<string>('/breach/range', { prefix: hash.slice(0, 5) });
    const suffix = hash.slice(5);
    for (const line of body.split('\n')) {
      const [s, count] = line.trim().split(':');
      if (s === suffix) return parseInt(count, 10) || 0;
    }
    return 0;
  } catch {
    return null;
  }
}
