import { useTranslation } from 'react-i18next';
import { entropyBits, GeneratorOptions } from '../lib/generator';
import { Checkbox, cx } from './ui';

/** Länge, Zeichenarten und Stärke des Passwortgenerators; genutzt auf der Generator-Seite und im Eintragsformular. */
export function GeneratorOptionsFields({ value, onChange, compact }: { value: GeneratorOptions; onChange: (o: GeneratorOptions) => void; compact?: boolean }) {
  const { t } = useTranslation();
  const set = <K extends keyof GeneratorOptions>(k: K, v: GeneratorOptions[K]) => onChange({ ...value, [k]: v });
  const bits = entropyBits(value);
  const rating = bits >= 128 ? 'excellent' : bits >= 90 ? 'strong' : bits >= 64 ? 'ok' : 'weak';
  return (
    <div className={compact ? 'space-y-3' : 'space-y-5'}>
      <div>
        <label className="mb-1 flex justify-between text-sm font-medium text-slate-700">
          <span>{t('generator.length')}</span>
          <span className="tabular-nums">{value.length}</span>
        </label>
        <input type="range" min={8} max={128} value={value.length} onChange={(e) => set('length', Number(e.target.value))} className="w-full accent-brand-900" />
      </div>
      <div className={cx('grid sm:grid-cols-2', compact ? 'gap-2' : 'gap-3')}>
        <Checkbox label={t('generator.upper')} checked={value.upper} onChange={(v) => set('upper', v)} />
        <Checkbox label={t('generator.lower')} checked={value.lower} onChange={(v) => set('lower', v)} />
        <Checkbox label={t('generator.digits')} checked={value.digits} onChange={(v) => set('digits', v)} />
        <Checkbox label={t('generator.symbols')} checked={value.symbols} onChange={(v) => set('symbols', v)} />
        <Checkbox label={t('generator.excludeAmbiguous')} checked={value.excludeAmbiguous} onChange={(v) => set('excludeAmbiguous', v)} />
      </div>
      <p className="text-xs text-slate-500">{t('generator.entropy', { bits, rating: t(`generator.rating.${rating}`) })}</p>
    </div>
  );
}
