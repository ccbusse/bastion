import { AlertTriangle, Check, CheckCircle2, CircleHelp, Copy, Eye, EyeOff, FileText, Info, Loader2, UploadCloud, X, XCircle } from 'lucide-react';
import { ButtonHTMLAttributes, forwardRef, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { ApiError } from '../lib/api';
import { copySecret } from '../lib/clipboard';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ---------- Buttons ----------

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'gold';
const variants: Record<Variant, string> = {
  primary: 'bg-brand-900 text-white hover:bg-brand-800 disabled:bg-brand-400',
  secondary: 'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 disabled:text-slate-400',
  danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300',
  ghost: 'text-slate-600 hover:bg-slate-100 disabled:text-slate-300',
  gold: 'bg-gold-500 text-brand-950 hover:bg-gold-400 disabled:bg-gold-300',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md';
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors disabled:cursor-not-allowed',
        size === 'sm' ? 'px-2.5 py-1.5 text-sm' : 'px-4 py-2 text-sm',
        variants[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});

export function IconButton({ label, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" title={label} aria-label={label} className={cx('rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800', className)} {...rest}>
      {children}
    </button>
  );
}

// ---------- Formular ----------

export function Field({ label, hint, error, children, htmlFor }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-slate-700">
        {label}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-slate-500">{hint}</p>}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

const inputCls =
  'block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200 disabled:bg-slate-100';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cx(inputCls, className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx(inputCls, 'min-h-[90px]', className)} {...rest} />;
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx(inputCls, 'pr-8', className)} {...rest}>
      {children}
    </select>
  );
}

export function Checkbox({ label, checked, onChange, disabled, hint }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; hint?: ReactNode }) {
  const id = useId();
  return (
    <div className="flex items-start gap-2">
      <input id={id} type="checkbox" className="mt-0.5 h-4 w-4 rounded border-slate-300 accent-brand-900" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <label htmlFor={id} className="text-sm text-slate-700">
        {label}
        {hint && <span className="block text-xs text-slate-500">{hint}</span>}
      </label>
    </div>
  );
}

export const PasswordInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { extra?: ReactNode }>(function PasswordInput({ className, extra, ...rest }, ref) {
  const [show, setShow] = useState(false);
  const { t } = useTranslation();
  return (
    <div className="relative flex">
      <input ref={ref} type={show ? 'text' : 'password'} spellCheck={false} autoCapitalize="off" className={cx(inputCls, 'pr-16 font-mono', className)} {...rest} />
      <div className="absolute inset-y-0 right-1 flex items-center gap-0.5">
        {extra}
        <IconButton label={show ? t('common.hide') : t('common.show')} onClick={() => setShow((s) => !s)} tabIndex={-1}>
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </IconButton>
      </div>
    </div>
  );
});

/** Dateiauswahl als Ablagefläche (Klick oder Drag & Drop). */
export function FileDrop({ accept, onFile, fileName, detail, disabled }: { accept?: string; onFile: (file: File) => void; fileName?: string; detail?: ReactNode; disabled?: boolean }) {
  const { t } = useTranslation();
  const id = useId();
  const [over, setOver] = useState(false);
  return (
    <label
      htmlFor={id}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const file = e.dataTransfer.files?.[0];
        if (file && !disabled) onFile(file);
      }}
      className={cx(
        'group flex cursor-pointer items-center gap-4 rounded-lg border-2 border-dashed px-5 py-5 transition-colors',
        over ? 'border-brand-500 bg-brand-50' : fileName ? 'border-slate-300 bg-slate-50 hover:border-brand-400' : 'border-slate-300 hover:border-brand-400 hover:bg-slate-50',
        disabled && 'pointer-events-none opacity-60',
      )}
    >
      <span className={cx('flex h-11 w-11 shrink-0 items-center justify-center rounded-full', fileName ? 'bg-brand-900 text-white' : 'bg-brand-50 text-brand-700 group-hover:bg-brand-100')}>
        {fileName ? <FileText className="h-5 w-5" /> : <UploadCloud className="h-5 w-5" />}
      </span>
      <span className="min-w-0 flex-1">
        {fileName ? (
          <>
            <span className="block truncate text-sm font-medium text-slate-800">{fileName}</span>
            {detail && <span className="block text-xs text-slate-500">{detail}</span>}
          </>
        ) : (
          <>
            <span className="block text-sm font-medium text-slate-800">{t('common.dropFile')}</span>
            <span className="block text-xs text-slate-500">{t('common.dropFileHint')}</span>
          </>
        )}
      </span>
      <span className="shrink-0 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm group-hover:bg-slate-50">
        {fileName ? t('common.otherFile') : t('common.chooseFile')}
      </span>
      <input
        id={id}
        type="file"
        accept={accept}
        className="sr-only"
        disabled={disabled}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = '';
        }}
      />
    </label>
  );
}

// ---------- Layout-Bausteine ----------

export function Card({ children, className, title, actions }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={cx('rounded-lg border border-slate-200 bg-white shadow-sm', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

/** Kleines „?“ neben einer Überschrift, führt zur passenden Anleitung unter /help/:id. */
export function HelpLink({ article }: { article: string }) {
  const { t } = useTranslation();
  return (
    <Link
      to={`/help/${article}`}
      title={t('help.articleLink')}
      aria-label={t('help.articleLink')}
      className="inline-flex shrink-0 rounded-full p-0.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-brand-700"
    >
      <CircleHelp className="h-[18px] w-[18px]" />
    </Link>
  );
}

export function PageHeader({ title, description, actions, help }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; help?: string }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-900">
          {title}
          {help && <HelpLink article={help} />}
        </h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-slate-500">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

const badgeColors = {
  gray: 'bg-slate-100 text-slate-700',
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  yellow: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  red: 'bg-red-50 text-red-700 ring-red-600/20',
  blue: 'bg-brand-50 text-brand-700 ring-brand-600/20',
  gold: 'bg-gold-300/30 text-gold-600 ring-gold-500/30',
};

export function Badge({ color = 'gray', children }: { color?: keyof typeof badgeColors; children: ReactNode }) {
  return <span className={cx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ring-transparent', badgeColors[color])}>{children}</span>;
}

const alertStyles = {
  info: { cls: 'bg-brand-50 border-brand-200 text-brand-800', Icon: Info },
  warning: { cls: 'bg-amber-50 border-amber-200 text-amber-900', Icon: AlertTriangle },
  error: { cls: 'bg-red-50 border-red-200 text-red-800', Icon: XCircle },
  success: { cls: 'bg-emerald-50 border-emerald-200 text-emerald-800', Icon: CheckCircle2 },
};

export function Alert({ kind = 'info', title, children, className }: { kind?: keyof typeof alertStyles; title?: ReactNode; children?: ReactNode; className?: string }) {
  const { cls, Icon } = alertStyles[kind];
  return (
    <div role={kind === 'error' ? 'alert' : 'status'} className={cx('flex gap-3 rounded-md border p-3 text-sm', cls, className)}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="space-y-1">
        {title && <p className="font-medium">{title}</p>}
        {children && <div>{children}</div>}
      </div>
    </div>
  );
}

export function Spinner({ className = 'h-5 w-5' }: { className?: string }) {
  return <Loader2 className={cx('animate-spin text-brand-500', className)} />;
}

export function FullPageSpinner() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner className="h-8 w-8" />
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      {icon && <div className="mb-3 text-slate-300">{icon}</div>}
      <p className="font-medium text-slate-700">{title}</p>
      {children && <div className="mt-1 max-w-md text-sm text-slate-500">{children}</div>}
    </div>
  );
}

// ---------- Dialog ----------

export function Modal({ open, onClose, title, children, footer, size = 'md' }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' }) {
  const { t } = useTranslation();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  const width = size === 'sm' ? 'max-w-md' : size === 'lg' ? 'max-w-3xl' : 'max-w-xl';
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-brand-950/50 p-4 pt-[8vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" className={cx('w-full rounded-lg bg-white shadow-xl', width)}>
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <h2 className="font-semibold text-slate-900">{title}</h2>
          <IconButton label={t('common.close')} onClick={onClose}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmModal({
  open,
  onClose,
  onConfirm,
  title,
  children,
  confirmLabel,
  danger,
  loading,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: ReactNode;
  children: ReactNode;
  confirmLabel?: ReactNode;
  danger?: boolean;
  loading?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>
            {confirmLabel ?? t('common.confirm')}
          </Button>
        </>
      }
    >
      <div className="text-sm text-slate-600">{children}</div>
    </Modal>
  );
}

// ---------- Hilfen ----------

export function useErrorMessage() {
  const { t } = useTranslation();
  return (e: unknown): string => {
    const code = e instanceof ApiError ? e.code : e instanceof Error ? e.message : 'UNKNOWN';
    const detail = e instanceof Error && 'detail' in e ? String(e.detail ?? '') : '';
    return t(`errors.${code}`, { defaultValue: t('errors.UNKNOWN'), detail });
  };
}

export function ErrorAlert({ error }: { error: unknown }) {
  const msg = useErrorMessage();
  if (!error) return null;
  return <Alert kind="error">{msg(error)}</Alert>;
}

export function CopyButton({ value, onCopied, label }: { value: string; onCopied?: () => void; label?: string }) {
  const [done, setDone] = useState(false);
  const { t } = useTranslation();
  return (
    <IconButton
      label={label ?? t('common.copy')}
      onClick={async () => {
        await copySecret(value);
        onCopied?.();
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
    </IconButton>
  );
}

export function formatDate(value: string | null | undefined, lang: string, withTime = true) {
  if (!value) return '–';
  return new Date(value).toLocaleString(lang === 'de' ? 'de-DE' : 'en-GB', withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });
}

export { cx };
