import { AlertTriangle, Copy as CopyIcon, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Alert, Badge, Button, Card, PageHeader, Spinner } from '../../components/ui';
import { breachCount, loadZxcvbn } from '../../lib/password-policy';
import type { DecryptedItem } from '../../lib/types';
import { useVaultItems } from '../../state/vault';

interface Finding {
  item: DecryptedItem;
  breached: number | null;
  weak: boolean;
  reused: number;
}

/** Sicherheitsbericht: kompromittierte (HIBP), schwache und mehrfach verwendete Passwörter. */
export function ReportPage({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation();
  const items = useVaultItems();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [findings, setFindings] = useState<Finding[] | null>(null);

  const run = async () => {
    const logins = (items.data ?? []).filter((i) => i.type === 'LOGIN' && i.secret?.password);
    setRunning(true);
    setProgress(0);
    const zxcvbn = await loadZxcvbn();
    const counts = new Map<string, number>();
    for (const i of logins) counts.set(i.secret!.password, (counts.get(i.secret!.password) ?? 0) + 1);
    const out: Finding[] = [];
    let done = 0;
    for (const i of logins) {
      const pw = i.secret!.password;
      const breached = await breachCount(pw);
      const weak = zxcvbn(pw).score < 3;
      const reused = counts.get(pw)! > 1 ? counts.get(pw)! : 0;
      if ((breached ?? 0) > 0 || weak || reused) out.push({ item: i, breached, weak, reused });
      setProgress(Math.round((++done / logins.length) * 100));
    }
    setFindings(out);
    setRunning(false);
  };

  const checked = (items.data ?? []).filter((i) => i.type === 'LOGIN' && i.secret?.password).length;
  const link = (i: DecryptedItem) => `/vault?f=${i.personal ? 'personal' : i.folderId}&item=${i.id}`;

  return (
    <div className={embedded ? '' : 'mx-auto max-w-4xl p-6'}>
      {embedded ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-slate-600">{t('report.description')}</p>
          <Button onClick={run} loading={running} disabled={!items.data}>
            {t('report.run')}
          </Button>
        </div>
      ) : (
        <PageHeader
          title={t('report.title')}
          description={t('report.description')}
          help="tools"
          actions={
            <Button onClick={run} loading={running} disabled={!items.data}>
              {t('report.run')}
            </Button>
          }
        />
      )}
      <Alert kind="info" className="mb-4">
        {t('report.privacy')}
      </Alert>
      {running && (
        <Card>
          <div className="flex items-center gap-3 text-sm text-slate-600">
            <Spinner /> {t('report.running', { progress })}
          </div>
        </Card>
      )}
      {findings && !running && (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-3">
            <Card>
              <p className="text-xs uppercase text-slate-500">{t('report.breached')}</p>
              <p className="mt-1 text-2xl font-semibold text-red-600">{findings.filter((f) => (f.breached ?? 0) > 0).length}</p>
            </Card>
            <Card>
              <p className="text-xs uppercase text-slate-500">{t('report.weak')}</p>
              <p className="mt-1 text-2xl font-semibold text-amber-600">{findings.filter((f) => f.weak).length}</p>
            </Card>
            <Card>
              <p className="text-xs uppercase text-slate-500">{t('report.reused')}</p>
              <p className="mt-1 text-2xl font-semibold text-amber-600">{findings.filter((f) => f.reused).length}</p>
            </Card>
          </div>
          <Card title={t('report.findings', { checked })}>
            {findings.length === 0 ? (
              <div className="flex items-center gap-2 text-sm text-emerald-700">
                <ShieldCheck className="h-5 w-5" /> {t('report.allGood')}
              </div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {findings.map((f) => (
                  <li key={f.item.id} className="flex flex-wrap items-center gap-3 py-2.5">
                    <Link to={link(f.item)} className="mr-auto text-sm font-medium text-brand-700 hover:underline">
                      {f.item.overview.name}
                    </Link>
                    {(f.breached ?? 0) > 0 && (
                      <Badge color="red">
                        <ShieldAlert className="mr-1 h-3 w-3" />
                        {t('report.breachedCount', { count: f.breached! })}
                      </Badge>
                    )}
                    {f.weak && (
                      <Badge color="yellow">
                        <AlertTriangle className="mr-1 h-3 w-3" />
                        {t('report.weakBadge')}
                      </Badge>
                    )}
                    {f.reused > 0 && (
                      <Badge color="yellow">
                        <CopyIcon className="mr-1 h-3 w-3" />
                        {t('report.reusedBadge', { count: f.reused })}
                      </Badge>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
