import { useId } from 'react';

export function LogoIcon({ className = 'h-8 w-8', dark = false }: { className?: string; dark?: boolean }) {
  const mask = useId();
  const a = dark ? '#e6ebf5' : '#1f2a44';
  const b = dark ? '#c3cde3' : '#2e3f66';
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <defs>
        <mask id={mask}>
          <rect width="64" height="64" fill="#fff" />
          <path d="M26 54V46.5a6 6 0 0 1 12 0V54z" fill="#000" />
        </mask>
      </defs>
      <g mask={`url(#${mask})`}>
        <path d="M14 8h8v6h6V8h8v6h6V8h8v46H14z" fill={a} />
        <path d="M32 8h4v6h6V8h8v46H32z" fill={b} />
        <rect x="10" y="54" width="44" height="4" rx="1" fill={a} />
      </g>
      <circle cx="32" cy="27" r="4.5" fill="#e0a526" />
      <path d="M29.6 29.5 28.3 38.5h7.4l-1.3-9z" fill="#e0a526" />
    </svg>
  );
}

export function Logo({ dark = false, size = 'md' }: { dark?: boolean; size?: 'md' | 'lg' }) {
  return (
    <div className="flex items-center gap-2.5">
      <LogoIcon dark={dark} className={size === 'lg' ? 'h-12 w-12' : 'h-8 w-8'} />
      <span className={`font-bold tracking-[0.2em] ${size === 'lg' ? 'text-2xl' : 'text-lg'} ${dark ? 'text-white' : 'text-brand-900'}`}>BASTION</span>
    </div>
  );
}
