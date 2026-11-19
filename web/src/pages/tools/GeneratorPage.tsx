import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Card, Checkbox, CopyButton, PageHeader } from '../../components/ui';
import { DEFAULT_GENERATOR, entropyBits, generatePassword, GeneratorOptions } from '../../lib/generator';

export function GeneratorPage() {
  const { t } = useTranslation();
  const [opts, setOpts] = useState<GeneratorOptions>(DEFAULT_GENERATOR);
  const [value, setValue] = useState('');
  const regenerate = () => setValue(generatePassword(opts));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(regenerate, [opts]);
  const bits = entropyBits(opts);
  const rating = bits >= 128 ? 'excellent' : bits >= 90 ? 'strong' : bits >= 64 ? 'ok' : 'weak';
  const set = <K extends keyof GeneratorOptions>(k: K, v: GeneratorOptions[K]) => setOpts((o) => ({ ...o, [k]: v }));

  return (
    <div className="mx-auto max-w-3xl p-6">
      <PageHeader title={t('generator.title')} description={t('generator.description')} help="tools" />
      <Card>
        <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 p-3">
          <p className="min-w-0 flex-1 break-all font-mono text-lg text-slate-900">{value || '–'}</p>
          <CopyButton value={value} />
          <Button variant="ghost" size="sm" onClick={regenerate} icon={<RefreshCw className="h-4 w-4" />}>
            {t('generator.regenerate')}
          </Button>
        </div>
        <p className="mt-2 text-xs text-slate-500">{t('generator.entropy', { bits, rating: t(`generator.rating.${rating}`) })}</p>
        <div className="mt-6 space-y-5">
          <div>
            <label className="mb-1 flex justify-between text-sm font-medium text-slate-700">
              <span>{t('generator.length')}</span>
              <span className="tabular-nums">{opts.length}</span>
            </label>
            <input type="range" min={8} max={128} value={opts.length} onChange={(e) => set('length', Number(e.target.value))} className="w-full accent-brand-900" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Checkbox label={t('generator.upper')} checked={opts.upper} onChange={(v) => set('upper', v)} />
            <Checkbox label={t('generator.lower')} checked={opts.lower} onChange={(v) => set('lower', v)} />
            <Checkbox label={t('generator.digits')} checked={opts.digits} onChange={(v) => set('digits', v)} />
            <Checkbox label={t('generator.symbols')} checked={opts.symbols} onChange={(v) => set('symbols', v)} />
            <Checkbox label={t('generator.excludeAmbiguous')} checked={opts.excludeAmbiguous} onChange={(v) => set('excludeAmbiguous', v)} />
          </div>
        </div>
      </Card>
    </div>
  );
}
