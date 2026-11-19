import { useQuery } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { MasterPasswordFields } from '../../components/MasterPasswordFields';
import { Alert, Button, ErrorAlert, Field, FullPageSpinner, Input } from '../../components/ui';
import { post } from '../../lib/api';
import { createAccount } from '../../lib/crypto/account';
import { fingerprint } from '../../lib/crypto/primitives';
import { organizationCodeMatches, tenantFingerprint } from '../../lib/crypto/trust';
import { AuthLayout } from './AuthLayout';

interface InvitationInfo {
  email: string;
  name: string;
  tenantName: string | null;
  systemAdmin: boolean;
  tenantId: string | null;
  recoveryPublicKey: string | null;
  signingPublicKey: string | null;
  expiresAt: string;
}

export function InvitePage() {
  const { t } = useTranslation();
  // Token steht im URL-Fragment und wird nur im Request-Body übertragen (nie in einer URL, die protokolliert werden könnte)
  const token = useMemo(() => window.location.hash.replace(/^#/, ''), []);
  const inv = useQuery({ queryKey: ['invitation', token], queryFn: () => post<InvitationInfo>('/invitations/describe', { token }), retry: false, enabled: !!token });
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [master, setMaster] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<{ fingerprint: string; tenantFingerprint: string | null } | null>(null);
  useEffect(() => {
    if (inv.data?.name) setName((n) => n || inv.data!.name);
  }, [inv.data]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!master || !inv.data) return;
    setBusy(true);
    setError(null);
    try {
      const d = inv.data;
      // Den Organisationsschlüsseln aus der Einladung erst vertrauen, wenn sie zum Code der Administration passen
      if (d.signingPublicKey && d.recoveryPublicKey && !(await organizationCodeMatches({ signingPublicKey: d.signingPublicKey, recoveryPublicKey: d.recoveryPublicKey }, code))) {
        throw new Error('ORGANIZATION_CODE_MISMATCH');
      }
      const { bundle } = await createAccount(master, d.tenantId ? { id: d.tenantId, recoveryPublicKey: d.recoveryPublicKey, signingPublicKey: d.signingPublicKey } : null);
      await post('/invitations/accept', { ...bundle, token, name: name.trim() });
      setDone({
        fingerprint: await fingerprint(bundle.publicKey),
        tenantFingerprint: d.signingPublicKey && d.recoveryPublicKey ? await tenantFingerprint({ signingPublicKey: d.signingPublicKey, recoveryPublicKey: d.recoveryPublicKey }) : null,
      });
      window.history.replaceState(null, '', '/invite');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <AuthLayout title={t('invite.title')}>
        <Alert kind="error">{t('errors.INVITATION_INVALID')}</Alert>
      </AuthLayout>
    );
  }
  if (inv.isLoading) return <FullPageSpinner />;
  if (inv.error) {
    return (
      <AuthLayout title={t('invite.title')}>
        <ErrorAlert error={inv.error} />
      </AuthLayout>
    );
  }

  if (done) {
    return (
      <AuthLayout title={t('invite.doneTitle')}>
        <div className="space-y-4 text-sm text-slate-600">
          <div className="flex items-center gap-2 text-emerald-700">
            <CheckCircle2 className="h-5 w-5" /> {t('invite.doneText')}
          </div>
          <p>{t('invite.fingerprintHint')}</p>
          <p className="rounded-md bg-slate-100 p-3 text-center font-mono text-base tracking-wider text-slate-900">{done.fingerprint}</p>
          {done.tenantFingerprint && (
            <>
              <p>{t('invite.tenantFingerprintHint')}</p>
              <p className="rounded-md bg-slate-100 p-3 text-center font-mono text-sm tracking-wider text-slate-900">{done.tenantFingerprint}</p>
            </>
          )}
          <Link to="/login" className="block">
            <Button className="w-full">{t('invite.toLogin')}</Button>
          </Link>
        </div>
      </AuthLayout>
    );
  }

  const data = inv.data!;
  const needsCode = !!(data.signingPublicKey && data.recoveryPublicKey);
  return (
    <AuthLayout title={t('invite.title')} subtitle={data.tenantName ? t('invite.subtitleTenant', { tenant: data.tenantName }) : t('invite.subtitleSystem')} wide>
      <form onSubmit={submit} className="space-y-4">
        <ErrorAlert error={error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('common.email')}>
            <Input value={data.email} disabled />
          </Field>
          <Field label={t('common.name')}>
            <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoFocus />
          </Field>
        </div>
        {needsCode && (
          <Field label={t('invite.organizationCode')} hint={t('invite.organizationCodeHint')}>
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXX-XXXX-XXXX-XXXX" className="font-mono uppercase" autoComplete="off" spellCheck={false} required />
          </Field>
        )}
        <MasterPasswordFields userInputs={[data.email, name, data.tenantName ?? '', 'bastion']} onChange={setMaster} label={t('common.masterPassword')} />
        <Alert kind="info">{data.recoveryPublicKey ? t('invite.recoveryHint') : data.tenantName ? t('invite.firstAdminRecoveryHint') : t('invite.noRecoveryHint')}</Alert>
        <Button type="submit" className="w-full" disabled={!master || !name.trim() || (needsCode && !code.trim())} loading={busy}>
          {busy ? t('setup.creatingKeys') : t('invite.submit')}
        </Button>
      </form>
    </AuthLayout>
  );
}
