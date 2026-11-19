let clearTimer: number | undefined;

/** Kopiert in die Zwischenablage und leert sie nach 30 Sekunden wieder. */
export async function copySecret(value: string, clearAfterMs = 30_000) {
  await navigator.clipboard.writeText(value);
  window.clearTimeout(clearTimer);
  clearTimer = window.setTimeout(() => {
    navigator.clipboard.writeText('').catch(() => undefined);
  }, clearAfterMs);
}
