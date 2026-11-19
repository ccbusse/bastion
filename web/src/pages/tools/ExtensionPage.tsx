import { ExternalLink, Lock, MousePointerClick, Puzzle, ShieldCheck, Timer } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Alert, Badge, Card, CopyButton, PageHeader } from '../../components/ui';

/** Eintrag im Chrome Web Store (nicht gelistet, nur über diesen Link auffindbar). */
const CHROME_WEB_STORE_URL = 'https://chromewebstore.google.com/detail/bastion/fkdcleihlodonenjchpdcjmgfnpadono';

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-900 text-xs font-bold text-white">{n}</span>
      <span className="pt-0.5 text-sm text-slate-700">{children}</span>
    </li>
  );
}

/** Installation der Browser-Erweiterung über den Chrome Web Store. */
export function ExtensionPage() {
  const { t } = useTranslation();
  const vaultUrl = window.location.origin;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <PageHeader title={t('extension.title')} description={t('extension.description')} help="extension" />

      <div className="grid gap-3 sm:grid-cols-3">
        {[
          [MousePointerClick, 'fill'],
          [Lock, 'readOnly'],
          [Timer, 'lock'],
        ].map(([Icon, k]) => {
          const I = Icon as typeof Lock;
          return (
            <div key={k as string} className="rounded-lg border border-slate-200 bg-white p-4">
              <I className="h-5 w-5 text-gold-500" />
              <p className="mt-2 text-sm font-semibold text-slate-900">{t(`extension.features.${k}.title`)}</p>
              <p className="mt-1 text-xs leading-relaxed text-slate-500">{t(`extension.features.${k}.text`)}</p>
            </div>
          );
        })}
      </div>

      <Card
        title={
          <span className="flex items-center gap-2">
            <Puzzle className="h-4 w-4 text-brand-500" /> Chrome · Edge · Brave · Opera
          </span>
        }
      >
        <div className="space-y-5">
          <a
            href={CHROME_WEB_STORE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-2 rounded-md bg-brand-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-800"
          >
            <ExternalLink className="h-4 w-4" />
            {t('extension.openStore')}
          </a>
          <ol className="space-y-3">
            <Step n={1}>{t('extension.steps.install')}</Step>
            <Step n={2}>{t('extension.steps.pin')}</Step>
            <Step n={3}>
              <span className="block">{t('extension.steps.connect')}</span>
              <span className="mt-2 flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2">
                <code className="min-w-0 flex-1 truncate font-mono text-sm text-slate-900">{vaultUrl}</code>
                <CopyButton value={vaultUrl} />
              </span>
            </Step>
          </ol>
          <Alert kind="info">{t('extension.storeHint')}</Alert>
        </div>
      </Card>

      <Card title="Firefox" actions={<Badge color="yellow">{t('extension.inPreparation')}</Badge>}>
        <p className="text-sm text-slate-600">{t('extension.firefoxText')}</p>
      </Card>

      <div className="flex gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" />
        <p>{t('extension.security')}</p>
      </div>
    </div>
  );
}
