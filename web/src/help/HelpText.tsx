import { Fragment, ReactNode } from 'react';
import { Link } from 'react-router';

/**
 * Inline-Auszeichnung der Hilfetexte: **fett**, `Code`, [Text](/route) und [Text](help:artikel).
 * Ergebnis sind ausschließlich React-Elemente (kein innerHTML). Andere Linkziele werden als Text ausgegeben.
 */
const TOKEN = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;

export function helpHref(target: string): string | null {
  if (target.startsWith('help:')) return `/help/${encodeURIComponent(target.slice(5))}`;
  // Nur Routen innerhalb der App (kein "//host")
  if (target.startsWith('/') && !target.startsWith('//')) return target;
  return null;
}

export function HelpText({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<strong key={key++} className="font-semibold text-slate-900">{m[1]}</strong>);
    else if (m[2] !== undefined) out.push(<code key={key++} className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.85em] text-slate-800">{m[2]}</code>);
    else {
      const href = helpHref(m[4]);
      out.push(
        href ? (
          <Link key={key++} to={href} className="font-medium text-brand-700 underline decoration-brand-300 underline-offset-2 hover:decoration-brand-700">
            {m[3]}
          </Link>
        ) : (
          <Fragment key={key++}>{m[3]}</Fragment>
        ),
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}
