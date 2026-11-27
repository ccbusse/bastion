import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GeneratorOptionsFields } from '../../components/GeneratorOptions';
import { Button, Card, CopyButton, PageHeader } from '../../components/ui';
import { DEFAULT_GENERATOR, generatePassword, GeneratorOptions } from '../../lib/generator';

export function GeneratorPage() {
  const { t } = useTranslation();
  const [opts, setOpts] = useState<GeneratorOptions>(DEFAULT_GENERATOR);
  const [value, setValue] = useState('');
  const regenerate = () => setValue(generatePassword(opts));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(regenerate, [opts]);

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
        <div className="mt-6">
          <GeneratorOptionsFields value={opts} onChange={setOpts} />
        </div>
      </Card>
    </div>
  );
}
