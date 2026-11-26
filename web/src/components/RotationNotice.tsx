import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { RotationResult } from '../state/vault';
import { Alert } from './ui';

/** Ergebnis der automatischen Schlüsselerneuerung: erneuerte Ordner und solche, die eine Einzelentscheidung brauchen. */
export function RotationNotice({ result, onClose, className }: { result: RotationResult | null | undefined; onClose?: () => void; className?: string }) {
  const { t } = useTranslation();
  if (!result || (!result.rotated.length && !result.skipped.length)) return null;
  return (
    <div className={`relative space-y-2 ${className ?? ''}`} data-testid="rotation-notice">
      {result.rotated.length > 0 && (
        <Alert kind="success" title={t('rotation.autoDone', { count: result.rotated.length })}>
          {result.rotated.join(', ')}
        </Alert>
      )}
      {result.skipped.length > 0 && (
        <Alert kind="warning" title={t('rotation.autoSkipped', { count: result.skipped.length })}>
          {result.skipped.join(', ')}
        </Alert>
      )}
      {onClose && (
        <button type="button" onClick={onClose} aria-label={t('common.close')} className="absolute right-2 top-2 rounded p-1 text-slate-500 hover:bg-black/5">
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
