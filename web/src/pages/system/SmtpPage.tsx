import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Card, ErrorAlert, Field, Input, PageHeader, PasswordInput, Select } from '../../components/ui';
import { get, post, put } from '../../lib/api';
import { useUnlocked } from '../../state/session';

interface Smtp {
  host: string;
  port: number;
  security: 'tls' | 'starttls' | 'none';
  username: string;
  fromAddress: string;
  fromName: string;
  hasPassword: boolean;
}

export function SmtpPage({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { info } = useUnlocked();
  const smtp = useQuery({ queryKey: ['smtp'], queryFn: () => get<Smtp | null>('/system/smtp') });
  const [form, setForm] = useState({ host: '', port: 587, security: 'starttls' as Smtp['security'], username: '', fromAddress: '', fromName: 'Bastion' });
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const [testTo, setTestTo] = useState(info.user.email);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (smtp.data) {
      const { hasPassword: _h, ...rest } = smtp.data;
      void _h;
      setForm(rest);
    }
  }, [smtp.data]);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className={embedded ? 'space-y-6' : 'mx-auto max-w-3xl space-y-6 p-6'}>
      {embedded ? <p className="text-sm text-slate-600">{t('smtp.description')}</p> : <PageHeader title={t('smtp.title')} description={t('smtp.description')} />}
      <Card title={t('smtp.server')}>
        <div className="space-y-4">
          <ErrorAlert error={error} />
          {saved && <Alert kind="success">{t('common.saved')}</Alert>}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <Field label={t('smtp.host')}>
                <Input value={form.host} onChange={(e) => set('host', e.target.value)} placeholder="smtp.example.com" />
              </Field>
            </div>
            <Field label={t('smtp.port')}>
              <Input type="number" value={form.port} onChange={(e) => set('port', Number(e.target.value))} />
            </Field>
          </div>
          <Field label={t('smtp.security')}>
            <Select value={form.security} onChange={(e) => set('security', e.target.value as Smtp['security'])}>
              <option value="starttls">STARTTLS (587)</option>
              <option value="tls">TLS / SMTPS (465)</option>
              <option value="none">{t('smtp.noneInsecure')}</option>
            </Select>
          </Field>
          {form.security === 'none' && <Alert kind="warning">{t('smtp.insecureWarning')}</Alert>}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('smtp.username')}>
              <Input value={form.username} onChange={(e) => set('username', e.target.value)} autoComplete="off" />
            </Field>
            <Field label={t('smtp.password')} hint={smtp.data?.hasPassword ? t('smtp.passwordKeep') : undefined}>
              <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('smtp.fromAddress')}>
              <Input type="email" value={form.fromAddress} onChange={(e) => set('fromAddress', e.target.value)} placeholder="bastion@example.com" />
            </Field>
            <Field label={t('smtp.fromName')}>
              <Input value={form.fromName} onChange={(e) => set('fromName', e.target.value)} />
            </Field>
          </div>
          <p className="text-xs text-slate-500">{t('smtp.encryptedHint')}</p>
          <Button
            loading={busy}
            disabled={!form.host || !form.fromAddress}
            onClick={async () => {
              setBusy(true);
              setError(null);
              setSaved(false);
              try {
                await put('/system/smtp', { ...form, password: password || undefined });
                setPassword('');
                await qc.invalidateQueries({ queryKey: ['smtp'] });
                setSaved(true);
              } catch (e) {
                setError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('common.save')}
          </Button>
        </div>
      </Card>
      <Card title={t('smtp.test')}>
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Field label={t('smtp.testTo')}>
              <Input type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
            </Field>
          </div>
          <Button
            variant="secondary"
            icon={<Send className="h-4 w-4" />}
            loading={testing}
            onClick={async () => {
              setTesting(true);
              setTestResult(null);
              try {
                setTestResult(await post('/system/smtp/test', { to: testTo }));
              } catch (e) {
                setTestResult({ ok: false, error: (e as Error).message });
              } finally {
                setTesting(false);
              }
            }}
          >
            {t('smtp.sendTest')}
          </Button>
        </div>
        {testResult && (
          <Alert kind={testResult.ok ? 'success' : 'error'} className="mt-3">
            {testResult.ok ? t('smtp.testOk') : `${t('smtp.testFailed')}: ${/^[A-Z_]+$/.test(testResult.error ?? '') ? t(`errors.${testResult.error}`, { defaultValue: testResult.error }) : testResult.error}`}
          </Alert>
        )}
      </Card>
    </div>
  );
}
