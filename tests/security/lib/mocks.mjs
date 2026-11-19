// Einfache Gegenstellen für Exportziele und SMTP. Sie laufen auf dem Testrechner;
// die App erreicht sie aus dem Container über host.docker.internal (siehe compose.test.yml).
import { createServer } from 'node:http';
import { createServer as tcpServer } from 'node:net';

export const MOCK_HOST = process.env.MOCK_HOST ?? 'host.docker.internal';

const listen = (server, port) =>
  new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, '0.0.0.0', () => {
      // Ein offener Mock-Server darf den Testprozess nie am Beenden hindern (z. B. nach einem fehlgeschlagenen Hook)
      server.unref();
      done(server);
    });
  });

/** WebDAV-Ziel: merkt sich Authorization-Header und Dateien. `redirectTo` leitet jede Anfrage weiter. */
export async function webdav(port, { redirectTo } = {}) {
  const state = { auth: [], files: new Set() };
  const server = createServer((req, res) => {
    req.resume();
    if (req.headers.authorization) state.auth.push(req.headers.authorization);
    if (redirectTo) return res.writeHead(302, { location: redirectTo }).end();
    if (req.method === 'PROPFIND') {
      res.writeHead(207, { 'content-type': 'application/xml' });
      return res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${[...state.files].map((f) => `<d:response><d:href>/x/${f}</d:href></d:response>`).join('')}</d:multistatus>`);
    }
    const name = decodeURIComponent((req.url ?? '').split('/').pop());
    if (req.method === 'PUT') state.files.add(name);
    if (req.method === 'DELETE') state.files.delete(name);
    res.writeHead(201).end();
  });
  await listen(server, port);
  return { state, close: () => new Promise((done) => server.close(done)) };
}

/** SMTP-Server: protokolliert Anmeldungen (AUTH PLAIN) sowie Empfänger und Betreff jeder Mail. */
export async function smtp(port) {
  const state = { auth: [], mails: [] };
  const server = tcpServer((sock) => {
    let data = false;
    let cur = { to: [], subject: '' };
    sock.write('220 mock ESMTP\r\n');
    sock.on('error', () => undefined);
    sock.on('data', (buf) => {
      for (const line of buf.toString().split('\r\n')) {
        if (data) {
          if (line === '.') {
            data = false;
            state.mails.push(cur);
            cur = { to: [], subject: '' };
            sock.write('250 ok\r\n');
          } else if (/^Subject:/i.test(line)) cur.subject = line.slice(8).trim();
          continue;
        }
        if (!line) continue;
        const u = line.toUpperCase();
        if (u.startsWith('EHLO')) sock.write('250-mock\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (u.startsWith('AUTH PLAIN')) {
          state.auth.push(Buffer.from(line.slice(11).trim(), 'base64').toString().split('\0'));
          sock.write('235 ok\r\n');
        } else if (u.startsWith('RCPT TO')) {
          cur.to.push(line.slice(8).replace(/[<>]/g, '').trim());
          sock.write('250 ok\r\n');
        } else if (u.startsWith('DATA')) {
          data = true;
          sock.write('354 go\r\n');
        } else if (u.startsWith('QUIT')) {
          sock.write('221 bye\r\n');
          sock.end();
        } else sock.write('250 ok\r\n');
      }
    });
  });
  await listen(server, port);
  return { state, close: () => new Promise((done) => server.close(done)) };
}

/** Wartet, bis eine Bedingung erfüllt ist (z. B. Mail angekommen), höchstens `ms`. */
export async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((d) => setTimeout(d, 100));
  }
  return fn();
}
