import { readFileSync } from 'node:fs';
import { Actor } from './client.mjs';

/** Testdaten aus seed.mjs. */
export const state = JSON.parse(readFileSync(new URL('../.build/state.json', import.meta.url), 'utf8'));
export const U = state.users;
export const T = state.tenants;

/** Neue (abgemeldete) Person für ein Testkonto. */
export const as = (key, opts) => new Actor(U[key].email, U[key].password, opts);

/** Angemeldet und entsperrt. */
export async function signedIn(key, opts) {
  const a = as(key, opts);
  await a.login();
  await a.unlock();
  return a;
}
