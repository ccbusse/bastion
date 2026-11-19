import { AlertTriangle, Eye, EyeOff, Loader2 } from 'lucide-react';
import { ButtonHTMLAttributes, forwardRef, InputHTMLAttributes, ReactNode, useState } from 'react';
import { t } from './i18n';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export function Button({ loading, icon, variant = 'primary', className, children, disabled, type = 'button', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean; icon?: ReactNode; variant?: 'primary' | 'secondary' | 'ghost' }) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-xl text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60',
        variant === 'primary' && 'h-11 bg-brand-900 px-4 text-white shadow-lg shadow-brand-900/20 hover:bg-brand-800 dark:bg-[#5570ad] dark:hover:bg-[#6680bd]',
        variant === 'secondary' && 'h-9 border border-slate-300 bg-white px-3 text-slate-700 hover:bg-slate-50 dark:border-white/10 dark:bg-white/5 dark:text-slate-200 dark:hover:bg-white/10',
        variant === 'ghost' && 'h-8 px-2 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/10',
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

export function IconButton({ label, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" title={label} aria-label={label} className={cx('rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-white', className)} {...rest}>
      {children}
    </button>
  );
}

const inputCls =
  'block h-11 w-full rounded-xl border-[1.5px] border-slate-300 bg-white px-3.5 text-[15px] text-slate-900 placeholder:text-slate-400 focus:border-brand-700 focus:outline-none focus:ring-4 focus:ring-brand-200/60 dark:border-white/10 dark:bg-white/5 dark:text-white dark:focus:border-gold-500 dark:focus:ring-gold-500/15';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cx(inputCls, className)} {...rest} />;
});

export const PasswordInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function PasswordInput({ className, ...rest }, ref) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input ref={ref} type={show ? 'text' : 'password'} spellCheck={false} autoCapitalize="off" className={cx(inputCls, 'pr-11 font-mono', className)} {...rest} />
      <IconButton label={show ? t.hide : t.show} onClick={() => setShow((s) => !s)} tabIndex={-1} className="absolute right-1.5 top-1/2 -translate-y-1/2">
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </IconButton>
    </div>
  );
});

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-[13px] font-bold text-slate-700 dark:text-slate-300">{label}</span>
      {children}
    </label>
  );
}

export function ErrorBox({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div role="alert" className="flex gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-[13px] text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

export function LogoIcon({ className = 'h-7 w-7' }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <path d="M14 8h8v6h6V8h8v6h6V8h8v46H14z" fill="#e6ebf5" />
      <path d="M32 8h4v6h6V8h8v46H32z" fill="#c3cde3" />
      <path d="M26 54V46.5a6 6 0 0 1 12 0V54z" fill="#141b2d" />
      <rect x="10" y="54" width="44" height="4" rx="1" fill="#e6ebf5" />
      <circle cx="32" cy="27" r="4.5" fill="#e0a526" />
      <path d="M29.6 29.5 28.3 38.5h7.4l-1.3-9z" fill="#e0a526" />
    </svg>
  );
}

/** Kopfbereich im Stil der Anmeldeseite: dunkle Fläche mit goldenem Schein. */
export function Hero({ children }: { children?: ReactNode }) {
  return (
    <div className="relative overflow-hidden bg-[radial-gradient(120%_120%_at_20%_0%,#26345e_0%,#111831_55%,#070b17_100%)] px-5 pb-6 pt-5 text-white">
      <div className="pointer-events-none absolute -right-10 -top-16 h-48 w-48 rounded-full bg-gold-500/20 blur-3xl" />
      <div className="relative flex items-center gap-2.5">
        <LogoIcon />
        <span className="text-[15px] font-extrabold tracking-[0.3em]">BASTION</span>
      </div>
      {children && <div className="relative mt-4">{children}</div>}
    </div>
  );
}
