import { useQuery } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Card, Field, Input, PageHeader, Select } from '../../components/ui';
import { get } from '../../lib/api';
import { AuditTable } from '../admin/AuditTable';

interface VerifyResult {
  ok: boolean;
  checked: number;
  legacyEntries?: number;
  brokenAt?: string;
  reason?: 'CHAIN_BROKEN' | 'LEGACY_ABOVE_BASELINE' | 'BASELINE_INVALID' | 'ANCHOR_MISMATCH';
  head: { id: string; hash: string; at: string } | null;
  anchorOk?: boolean;
}

export function SystemAuditPage() {
  const { t } = useTranslation();
  const tenants = useQuery({ queryKey: ['tenants'], queryFn: () => get<{ id: string; name: string }[]>('/system/tenants') });
  const [tenant, setTenant] = useState('');
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [anchorId, setAnchorId] = useState('');
  const [anchorHash, setAnchorHash] = useState('');
  const [fileError, setFileError] = useState(false);

  const runVerify = async () => {
    setBusy(true);
    try {
      const q = anchorId.trim() && anchorHash.trim() ? `?anchorId=${encodeURIComponent(anchorId.trim())}&anchorHash=${encodeURIComponent(anchorHash.trim())}` : '';
      setVerify(await get<VerifyResult>(`/system/audit/verify${q}`));
    } finally {
      setBusy(false);
    }
  };

  /** Kettenkopf aus einer Notfall-Backup-Datei übernehmen (wird nur lokal gelesen). */
  const fromBackupFile = async (file: File | undefined) => {
    setFileError(false);
    if (!file) return;
    try {
      const head = (JSON.parse(await file.text()) as { auditHead?: { id: string; hash: string } }).auditHead;
      if (!head?.id || !head.hash) throw new Error('no head');
      setAnchorId(head.id);
      setAnchorHash(head.hash);
    } catch {
      setFileError(true);
    }
  };

  const failure = verify && !verify.ok && (verify.reason === 'CHAIN_BROKEN' ? t('audit.verifyBroken', { id: verify.brokenAt }) : t(`audit.reason.${verify.reason ?? 'CHAIN_BROKEN'}`));

  return (
    <div className="mx-auto max-w-6xl p-6">
      <PageHeader title={t('audit.systemTitle')} description={t('audit.systemDescription')} help="audit" />
      <Card title={t('audit.verifyTitle')} className="mb-4">
        <div className="space-y-3 text-sm text-slate-600">
          <p>{t('audit.verifyText')}</p>
          <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
            <Field label={t('audit.anchorId')}>
              <Input value={anchorId} onChange={(e) => setAnchorId(e.target.value)} inputMode="numeric" placeholder="1234" />
            </Field>
            <Field label={t('audit.anchorHash')}>
              <Input value={anchorHash} onChange={(e) => setAnchorHash(e.target.value)} className="font-mono text-xs" placeholder="h1:…" spellCheck={false} />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" icon={<ShieldCheck className="h-4 w-4" />} loading={busy} onClick={runVerify}>
              {t('audit.verify')}
            </Button>
            <label className="cursor-pointer text-sm text-brand-600 hover:underline">
              {t('audit.anchorFromBackup')}
              <input type="file" accept=".json,application/json" className="hidden" onChange={(e) => void fromBackupFile(e.target.files?.[0])} />
            </label>
          </div>
          {fileError && <Alert kind="error">{t('audit.anchorFileError')}</Alert>}
          {verify && (
            <Alert kind={verify.ok ? 'success' : 'error'}>
              {verify.ok ? t('audit.verifyOk', { count: verify.checked }) : failure}
              {verify.ok && verify.anchorOk && <span className="mt-1 block text-xs">{t('audit.anchorOk', { id: anchorId.trim() })}</span>}
              {verify.ok && !!verify.legacyEntries && <span className="mt-1 block text-xs">{t('audit.verifyLegacy', { count: verify.legacyEntries })}</span>}
            </Alert>
          )}
          {verify?.head && (
            <p className="text-xs text-slate-500">
              {t('audit.currentHead')} <span className="font-mono text-slate-700">#{verify.head.id} · {verify.head.hash}</span>
              <span className="mt-1 block">{t('audit.currentHeadHint')}</span>
            </p>
          )}
        </div>
      </Card>
      <AuditTable
        endpoint="/system/audit"
        extraParams={tenant ? `tenantId=${tenant}` : ''}
        toolbar={
          <div className="w-56">
            <Select value={tenant} onChange={(e) => setTenant(e.target.value)}>
              <option value="">{t('audit.allTenants')}</option>
              <option value="system">{t('audit.systemOnly')}</option>
              {tenants.data?.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </Select>
          </div>
        }
      />
    </div>
  );
}
