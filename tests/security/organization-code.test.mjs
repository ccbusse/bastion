// Organisationscode (F-12): Der Browser vertraut Organisationsschlüsseln aus einer Einladung nur, wenn sie zum Code passen
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { C } from './lib/client.mjs';
import { signedIn } from './lib/state.mjs';

const anchorOf = async (key) => {
  const a = await signedIn(key);
  const r = (await a.get('/keys/anchor')).data;
  return { signingPublicKey: r.signingPublicKey, recoveryPublicKey: r.recoveryPublicKey };
};

describe('Organisationscode', () => {
  it('passt zu den eigenen Organisationsschlüsseln, auch mit anderer Schreibweise', async () => {
    const anchor = await anchorOf('A');
    const code = await C.organizationCode(anchor);
    assert.match(code, /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
    assert.equal(await C.organizationCodeMatches(anchor, code), true);
    assert.equal(await C.organizationCodeMatches(anchor, code.toLowerCase().replace(/-/g, ' ')), true);
  });
  it('passt nicht zu den Schlüsseln eines anderen Tenants (untergeschobene Schlüssel)', async () => {
    const own = await anchorOf('A');
    const foreign = await anchorOf('B');
    assert.equal(await C.organizationCodeMatches(foreign, await C.organizationCode(own)), false);
  });
  it('ein leerer oder zu kurzer Code passt nie', async () => {
    const anchor = await anchorOf('A');
    const code = await C.organizationCode(anchor);
    assert.equal(await C.organizationCodeMatches(anchor, ''), false);
    assert.equal(await C.organizationCodeMatches(anchor, code.slice(0, 9)), false);
  });
});
