import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Download, FileLock2, FlaskConical, KeyRound, Printer, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Alert, Badge, Button, Card, Checkbox, ConfirmModal, cx, ErrorAlert, Field, formatDate, Input, Modal, PageHeader, PasswordInput, Spinner } from '../../components/ui';
import { get, post, put } from '../../lib/api';
import { createEmergencyKey, EmergencyKeyProtection, openEmergencyKey, parseSheetCode, PASSPHRASE_MIN_LENGTH, sealEmergencyAnchor } from '../../lib/crypto/emergency';
import { randomBytes } from '../../lib/crypto/encoding';
import { rsaUnwrap, rsaWrap } from '../../lib/crypto/primitives';
import { loadZxcvbn } from '../../lib/password-policy';
import { useUnlocked } from '../../state/session';
import { runKeyMaintenance } from '../../state/vault';
import { ReauthModal } from '../settings/AccountPage';
import { EmergencyAutoCard } from './EmergencyAutoCard';

interface PersonalCoverage {
  users: number;
  coveredUsers: number;
  items: number;
  coveredItems: number;
  /** Persönliche Einträge deaktivierter Konten ohne Schlüsselpaket */
  disabledItems: number;
}

interface EmergencyStatus {
  key:
    | (EmergencyKeyProtection & {
        id: string;
        publicKey: string;
        fingerprint: string;
        createdAt: string;
        createdBy: string | null;
      })
    | null;
  anchor: string | null;
  coverage: {
    tenants: {
      id: string;
      name: string;
      approved: boolean;
      approvedAt: string | null;
      approvedBy: string | null;
      folders: number;
      coveredFolders: number;
      items: number;
      coveredItems: number;
      personal: PersonalCoverage;
    }[];
    systemAdmins: PersonalCoverage;
  } | null;
  lastExport: { createdAt: string; actorEmail: string | null } | null;
}

export const TOOL_URL = '/tools/bastion-notfall-werkzeug.html';
export const TOOL_FILE = 'bastion-notfall-werkzeug.html';

export function saveFile(data: BlobPart, fileName: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Notfall-Werkzeug über die bestehende Verbindung laden (direkte Links scheitern bei selbstsignierten Zertifikaten). */
export async function downloadTool() {
  const res = await fetch(TOOL_URL, { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) throw new Error('TOOL_UNAVAILABLE');
  saveFile(await res.arrayBuffer(), TOOL_FILE, 'text/html');
}

/** Notfall-Backup: Notfallschlüssel, Abdeckung je Tenant, Export und Notfall-Werkzeug (nur System-Admins). */
export function EmergencyPage() {
  const { t } = useTranslation();
  const status = useQuery({ queryKey: ['emergency-status'], queryFn: () => get<EmergencyStatus>('/emergency/status') });
  const [wizard, setWizard] = useState<false | 'create' | 'replace'>(false);

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <PageHeader title={t('emergency.title')} description={t('emergency.description')} help="emergency-backup" />
      {status.isLoading ? (
        <Spinner />
      ) : status.error ? (
        <ErrorAlert error={status.error} />
      ) : wizard ? (
        <SetupWizard replaceKeyId={wizard === 'replace' ? (status.data?.key?.id ?? null) : null} onDone={() => setWizard(false)} />
      ) : !status.data?.key ? (
        <Intro onStart={() => setWizard('create')} />
      ) : (
        <KeyDashboard status={status.data as EmergencyStatus & { key: NonNullable<EmergencyStatus['key']> }} onReplace={() => setWizard('replace')} />
      )}
    </div>
  );
}

function Intro({ onStart }: { onStart: () => void }) {
  const { t } = useTranslation();
  return (
    <Card title={t('emergency.introTitle')}>
      <div className="space-y-4 text-sm text-slate-700">
        <p>{t('emergency.introText')}</p>
        <ol className="list-decimal space-y-2 pl-5">
          {(['key', 'approve', 'wrap', 'export', 'tool'] as const).map((k) => (
            <li key={k}>{t(`emergency.introSteps.${k}`)}</li>
          ))}
        </ol>
        <Alert kind="warning">{t('emergency.introWarning')}</Alert>
        <Button icon={<KeyRound className="h-4 w-4" />} onClick={onStart}>
          {t('emergency.setup')}
        </Button>
      </div>
    </Card>
  );
}

// ---------- Einrichtung ----------

type Created = Awaited<ReturnType<typeof createEmergencyKey>>;

function SetupWizard({ replaceKeyId, onDone }: { replaceKeyId: string | null; onDone: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { info, keys, refresh } = useUnlocked();
  const [step, setStep] = useState<'intro' | 'passphrase' | 'sheet' | 'verify'>('intro');
  const [understood, setUnderstood] = useState(false);
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [score, setScore] = useState<number | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [printed, setPrinted] = useState(false);
  const [codeCheck, setCodeCheck] = useState('');
  const [reauth, setReauth] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let alive = true;
    if (!pass) return setScore(null);
    void loadZxcvbn().then((z) => alive && setScore(z(pass, [info.user.email, info.user.name]).score));
    return () => {
      alive = false;
    };
  }, [pass, info.user.email, info.user.name]);

  const passOk = pass.length >= PASSPHRASE_MIN_LENGTH && (score ?? 0) >= 3 && pass === pass2;
  const steps = ['intro', 'passphrase', 'sheet', 'verify'] as const;

  const verifyCode = async () => {
    setError(null);
    try {
      const a = await parseSheetCode(codeCheck);
      const b = await parseSheetCode(created!.sheetCode);
      if (a.length !== b.length || a.some((x, i) => x !== b[i])) throw new Error('SHEET_CODE_MISMATCH');
      setReauth(true);
    } catch (e) {
      setError(e);
    }
  };

  return (
    <div className="space-y-4">
      <ol className="flex flex-wrap gap-2 text-xs font-medium">
        {steps.map((s, i) => (
          <li key={s} className={cx('rounded-full px-3 py-1', s === step ? 'bg-brand-900 text-white' : steps.indexOf(step) > i ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-500')}>
            {i + 1}. {t(`emergency.steps.${s}`)}
          </li>
        ))}
      </ol>
      <Card title={replaceKeyId ? t('emergency.replaceTitle') : t('emergency.setupTitle')}>
        <div className="space-y-4">
          <ErrorAlert error={error} />
          {step === 'intro' && (
            <>
              {replaceKeyId && <Alert kind="warning">{t('emergency.replaceWarning')}</Alert>}
              <div className="space-y-2 text-sm text-slate-700">
                <p>{t('emergency.wizardIntro')}</p>
                <ul className="list-disc space-y-1 pl-5">
                  <li>{t('emergency.factorSheet')}</li>
                  <li>{t('emergency.factorPassphrase')}</li>
                </ul>
              </div>
              <Alert kind="warning">{t('emergency.lossWarning')}</Alert>
              <Checkbox label={t('emergency.understood')} checked={understood} onChange={setUnderstood} />
              <div className="flex gap-2">
                <Button variant="secondary" onClick={onDone}>
                  {t('common.cancel')}
                </Button>
                <Button disabled={!understood} onClick={() => setStep('passphrase')}>
                  {t('common.continue')}
                </Button>
              </div>
            </>
          )}
          {step === 'passphrase' && (
            <>
              <p className="text-sm text-slate-700">{t('emergency.passphraseText', { min: PASSPHRASE_MIN_LENGTH })}</p>
              <Field label={t('emergency.passphrase')} hint={t('emergency.passphraseHint')}>
                <PasswordInput value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" autoFocus />
              </Field>
              <Field label={t('emergency.passphraseRepeat')} error={pass2 && pass !== pass2 ? t('emergency.passphraseMismatch') : undefined}>
                <PasswordInput value={pass2} onChange={(e) => setPass2(e.target.value)} autoComplete="new-password" />
              </Field>
              <ul className="space-y-1 text-xs">
                <Check ok={pass.length >= PASSPHRASE_MIN_LENGTH}>{t('emergency.checkLength', { min: PASSPHRASE_MIN_LENGTH })}</Check>
                <Check ok={(score ?? 0) >= 3}>{t('emergency.checkStrength')}</Check>
                <Check ok={!!pass && pass === pass2}>{t('emergency.checkRepeat')}</Check>
              </ul>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={onDone}>
                  {t('common.cancel')}
                </Button>
                <Button
                  disabled={!passOk}
                  loading={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError(null);
                    try {
                      setCreated(await createEmergencyKey(pass));
                      setStep('sheet');
                    } catch (e) {
                      setError(e);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? t('emergency.generating') : t('emergency.generate')}
                </Button>
              </div>
            </>
          )}
          {step === 'sheet' && created && (
            <>
              <p className="text-sm text-slate-700">{t('emergency.sheetText')}</p>
              <SheetPreview created={created} />
              <Button variant="secondary" icon={<Printer className="h-4 w-4" />} onClick={() => window.print()}>
                {t('emergency.print')}
              </Button>
              <Alert kind="info">{t('emergency.sheetStorage')}</Alert>
              <Checkbox label={t('emergency.printedTwice')} checked={printed} onChange={setPrinted} />
              <Button disabled={!printed} onClick={() => setStep('verify')}>
                {t('common.continue')}
              </Button>
            </>
          )}
          {step === 'verify' && created && (
            <>
              <p className="text-sm text-slate-700">{t('emergency.verifyText')}</p>
              <Field label={t('emergency.sheetCode')}>
                <Input value={codeCheck} onChange={(e) => setCodeCheck(e.target.value)} className="font-mono" autoComplete="off" spellCheck={false} placeholder="XXXXX-XXXXX-…" />
              </Field>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => setStep('sheet')}>
                  {t('common.back')}
                </Button>
                <Button disabled={!codeCheck.trim()} onClick={() => void verifyCode()}>
                  {t('emergency.finish')}
                </Button>
              </div>
            </>
          )}
        </div>
      </Card>
      {created && <PrintableSheet created={created} />}
      {reauth && created && (
        <ReauthModal
          title={t('emergency.confirmSetup')}
          onClose={() => setReauth(false)}
          onConfirm={async (authHash) => {
            await post('/emergency/key', {
              authHash,
              replaceKeyId,
              id: created.id,
              publicKey: created.publicKey,
              ...created.protection,
              anchor: await sealEmergencyAnchor(keys.accountKeyRaw, created.id, created.publicKey),
            });
            // Eigenen persönlichen Tresor sofort einbeziehen
            const s = await refresh();
            if (s) await runKeyMaintenance(s, keys).catch(() => undefined);
            await qc.invalidateQueries({ queryKey: ['emergency-status'] });
            setReauth(false);
            onDone();
          }}
        />
      )}
    </div>
  );
}

function Check({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className={cx('flex items-center gap-2', ok ? 'text-emerald-700' : 'text-slate-500')}>
      <CheckCircle2 className={cx('h-3.5 w-3.5', ok ? 'text-emerald-600' : 'text-slate-300')} />
      {children}
    </li>
  );
}

function SheetPreview({ created }: { created: Created }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 p-4">
      <p className="text-xs font-medium uppercase text-slate-500">{t('emergency.sheetCode')}</p>
      <p className="mt-1 break-all font-mono text-lg font-semibold tracking-wide text-slate-900">{created.sheetCode}</p>
      <p className="mt-3 text-xs font-medium uppercase text-slate-500">{t('emergency.fingerprint')}</p>
      <p className="font-mono text-sm text-slate-800">{created.fingerprint}</p>
    </div>
  );
}

/** Nur im Druck sichtbar (siehe index.css, .print-sheet). */
function PrintableSheet({ created }: { created: Created }) {
  const { t, i18n } = useTranslation();
  return (
    <div className="print-sheet" aria-hidden>
      <h1>{t('emergency.sheet.title')}</h1>
      <p className="sub">{t('emergency.sheet.subtitle')}</p>
      <table>
        <tbody>
          <tr>
            <th>{t('emergency.sheet.installation')}</th>
            <td>{window.location.origin}</td>
          </tr>
          <tr>
            <th>{t('emergency.sheet.created')}</th>
            <td>{formatDate(new Date().toISOString(), i18n.language)}</td>
          </tr>
          <tr>
            <th>{t('emergency.fingerprint')}</th>
            <td className="mono">{created.fingerprint}</td>
          </tr>
          <tr>
            <th>{t('emergency.sheet.keyId')}</th>
            <td className="mono">{created.id}</td>
          </tr>
        </tbody>
      </table>
      <h2>{t('emergency.sheetCode')}</h2>
      <div className="code">
        {created.sheetCode.split('-').map((g, i) => (
          <span key={i}>{g}</span>
        ))}
      </div>
      <h2>{t('emergency.sheet.howTo')}</h2>
      <ol>
        {(['file', 'tool', 'sheet', 'passphrase'] as const).map((k) => (
          <li key={k}>{t(`emergency.sheet.needs.${k}`)}</li>
        ))}
      </ol>
      <p className="warn">{t('emergency.sheet.warning')}</p>
      <p className="copy">{t('emergency.sheet.copy')}</p>
    </div>
  );
}

// ---------- Übersicht bei eingerichtetem Schlüssel ----------

function KeyDashboard({ status, onReplace }: { status: EmergencyStatus & { key: NonNullable<EmergencyStatus['key']> }; onReplace: () => void }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const { keys, refresh } = useUnlocked();
  const key = status.key;
  const [probe, setProbe] = useState(false);
  const [confirmAnchor, setConfirmAnchor] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const reload = () => qc.invalidateQueries({ queryKey: ['emergency-status'] });
  const cov = status.coverage;

  return (
    <div className="space-y-6">
      <ErrorAlert error={error} />
      {!status.anchor && (
        <Alert kind="warning" title={t('emergency.notConfirmedTitle')}>
          <p>{t('emergency.notConfirmedText')}</p>
          <Button size="sm" className="mt-2" onClick={() => setConfirmAnchor(true)}>
            {t('emergency.confirmFingerprint')}
          </Button>
        </Alert>
      )}

      <Card
        title={
          <span className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-gold-500" /> {t('emergency.keyTitle')}
          </span>
        }
        actions={<Badge color="green">{t('emergency.active')}</Badge>}
      >
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
          <dt className="text-slate-500">{t('emergency.fingerprint')}</dt>
          <dd className="font-mono font-semibold text-slate-900">{key.fingerprint}</dd>
          <dt className="text-slate-500">{t('emergency.createdAt')}</dt>
          <dd className="text-slate-800">
            {formatDate(key.createdAt, i18n.language)}
            {key.createdBy && <span className="text-slate-500"> · {key.createdBy}</span>}
          </dd>
          <dt className="text-slate-500">{t('emergency.protection')}</dt>
          <dd className="text-slate-800">{t('emergency.protectionValue', { mib: key.kdfMemory / 1024, t: key.kdfIterations })}</dd>
        </dl>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button variant="secondary" icon={<FlaskConical className="h-4 w-4" />} onClick={() => setProbe(true)}>
            {t('emergency.probe')}
          </Button>
          <Button variant="secondary" icon={<RefreshCw className="h-4 w-4" />} onClick={onReplace}>
            {t('emergency.replace')}
          </Button>
          <Button variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={() => setDeleting(true)}>
            {t('emergency.delete')}
          </Button>
        </div>
      </Card>

      <Card
        title={
          <span className="flex items-center gap-2">
            <FileLock2 className="h-4 w-4 text-brand-500" /> {t('emergency.exportTitle')}
          </span>
        }
      >
        <div className="space-y-4 text-sm text-slate-700">
          <p>{t('emergency.exportText')}</p>
          <div className="flex flex-wrap gap-2">
            <Button icon={<Download className="h-4 w-4" />} onClick={() => setExporting(true)}>
              {t('emergency.exportNow')}
            </Button>
            <Button
              variant="secondary"
              icon={<Download className="h-4 w-4" />}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await downloadTool();
                } catch (e) {
                  setError(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t('emergency.downloadTool')}
            </Button>
          </div>
          <p className="text-xs text-slate-500">
            {status.lastExport
              ? t('emergency.lastExport', { date: formatDate(status.lastExport.createdAt, i18n.language), by: status.lastExport.actorEmail ?? '–' })
              : t('emergency.neverExported')}
          </p>
          <Alert kind="info">{t('emergency.toolHint')}</Alert>
        </div>
      </Card>

      <EmergencyAutoCard />

      {cov && (
        <Card title={t('emergency.coverageTitle')}>
          <p className="mb-4 text-sm text-slate-600">{t('emergency.coverageText')}</p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-slate-500">
                <tr>
                  <th className="py-2 pr-4 font-medium">{t('emergency.colTenant')}</th>
                  <th className="py-2 pr-4 font-medium">{t('emergency.colApproval')}</th>
                  <th className="py-2 pr-4 font-medium">{t('emergency.colFolders')}</th>
                  <th className="py-2 pr-4 font-medium">{t('emergency.colItems')}</th>
                  <th className="py-2 font-medium">{t('emergency.colPersonal')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {cov.tenants.map((tn) => (
                  <tr key={tn.id}>
                    <td className="py-2 pr-4 font-medium text-slate-900">{tn.name}</td>
                    <td className="py-2 pr-4">
                      {tn.approved ? (
                        <span title={tn.approvedBy ?? ''}>
                          <Badge color="green">{t('emergency.approved')}</Badge>
                        </span>
                      ) : (
                        <Badge color="yellow">{t('emergency.pendingApproval')}</Badge>
                      )}
                    </td>
                    <td className="py-2 pr-4"><Ratio a={tn.coveredFolders} b={tn.folders} /></td>
                    <td className="py-2 pr-4"><Ratio a={tn.coveredItems} b={tn.items} /></td>
                    <td className="py-2"><Ratio a={tn.personal.coveredUsers} b={tn.personal.users} suffix={t('emergency.users')} /></td>
                  </tr>
                ))}
                <tr>
                  <td className="py-2 pr-4 font-medium text-slate-900">{t('emergency.systemAdmins')}</td>
                  <td className="py-2 pr-4 text-xs text-slate-500">{t('emergency.ownConfirmation')}</td>
                  <td className="py-2 pr-4 text-slate-400">–</td>
                  <td className="py-2 pr-4 text-slate-400">–</td>
                  <td className="py-2"><Ratio a={cov.systemAdmins.coveredUsers} b={cov.systemAdmins.users} suffix={t('emergency.users')} /></td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-xs text-slate-500">{t('emergency.coverageHint')}</p>
        </Card>
      )}

      {probe && <ProbeModal keyInfo={key} onClose={() => setProbe(false)} />}
      <ConfirmModal
        open={confirmAnchor}
        onClose={() => setConfirmAnchor(false)}
        title={t('emergency.confirmFingerprint')}
        loading={busy}
        onConfirm={async () => {
          setBusy(true);
          setError(null);
          try {
            await put('/emergency/anchor', { keyId: key.id, data: await sealEmergencyAnchor(keys.accountKeyRaw, key.id, key.publicKey) });
            const s = await refresh();
            if (s) await runKeyMaintenance(s, keys).catch(() => undefined);
            await reload();
            setConfirmAnchor(false);
          } catch (e) {
            setError(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>{t('emergency.confirmFingerprintText')}</p>
        <p className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-center font-mono font-semibold text-slate-900">{key.fingerprint}</p>
      </ConfirmModal>
      {exporting && (
        <ReauthModal
          title={t('emergency.exportNow')}
          onClose={() => setExporting(false)}
          onConfirm={async (authHash) => {
            const file = await post<unknown>('/emergency/export', { authHash });
            const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
            saveFile(JSON.stringify(file), `bastion-notfall-backup-${stamp}.json`, 'application/json');
            await reload();
            setExporting(false);
          }}
        >
          <CoverageGaps coverage={cov} />
        </ReauthModal>
      )}
      {deleting && (
        <ReauthModal
          danger
          title={t('emergency.deleteTitle')}
          onClose={() => setDeleting(false)}
          onConfirm={async (authHash) => {
            await post('/emergency/key/delete', { authHash });
            await reload();
            await refresh();
            setDeleting(false);
          }}
        />
      )}
    </div>
  );
}

/** Was im Backup fehlt, als Hinweis vor dem Export. */
function CoverageGaps({ coverage }: { coverage: EmergencyStatus['coverage'] }) {
  const { t } = useTranslation();
  if (!coverage) return null;
  const gaps: string[] = [];
  for (const tn of coverage.tenants) {
    if (!tn.approved) {
      if (tn.items || tn.personal.users) gaps.push(t('emergency.gapNotApproved', { tenant: tn.name, items: tn.items }));
      continue;
    }
    if (tn.coveredFolders < tn.folders) gaps.push(t('emergency.gapFolders', { tenant: tn.name, count: tn.folders - tn.coveredFolders, items: tn.items - tn.coveredItems }));
    if (tn.personal.coveredUsers < tn.personal.users) {
      gaps.push(t('emergency.gapPersonal', { tenant: tn.name, count: tn.personal.users - tn.personal.coveredUsers, items: tn.personal.items - tn.personal.coveredItems }));
    }
    if (tn.personal.disabledItems) gaps.push(t('emergency.gapDisabled', { tenant: tn.name, items: tn.personal.disabledItems }));
  }
  const sa = coverage.systemAdmins;
  if (sa.coveredUsers < sa.users) gaps.push(t('emergency.gapSystemAdmins', { count: sa.users - sa.coveredUsers, items: sa.items - sa.coveredItems }));
  if (!gaps.length) return <Alert kind="success">{t('emergency.gapNone')}</Alert>;
  return (
    <Alert kind="warning" title={t('emergency.gapTitle')}>
      <ul className="list-disc space-y-1 pl-4">
        {gaps.map((g) => (
          <li key={g}>{g}</li>
        ))}
      </ul>
      <p className="mt-2">{t('emergency.gapHint')}</p>
    </Alert>
  );
}

function Ratio({ a, b, suffix }: { a: number; b: number; suffix?: string }) {
  const full = a >= b;
  return (
    <span className={cx('font-mono text-xs', b === 0 ? 'text-slate-400' : full ? 'text-emerald-700' : 'text-amber-700')}>
      {a} / {b}
      {suffix ? ` ${suffix}` : ''}
    </span>
  );
}

function ProbeModal({ keyInfo, onClose }: { keyInfo: NonNullable<EmergencyStatus['key']>; onClose: () => void }) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [ok, setOk] = useState(false);
  return (
    <Modal
      open
      onClose={onClose}
      title={t('emergency.probe')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.close')}
          </Button>
          <Button
            loading={busy}
            disabled={!code || !pass}
            onClick={async () => {
              setBusy(true);
              setError(null);
              setOk(false);
              try {
                const privateKey = await openEmergencyKey(keyInfo.id, keyInfo, code, pass);
                // Gegenprobe: passt der private Schlüssel zum öffentlichen auf dem Server?
                const probe = randomBytes(32);
                const back = await rsaUnwrap(privateKey, await rsaWrap(keyInfo.publicKey, probe));
                if (back.some((b, i) => b !== probe[i])) throw new Error('EMERGENCY_KEY_MISMATCH');
                setOk(true);
              } catch (e) {
                setError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? t('emergency.probing') : t('emergency.runProbe')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-600">{t('emergency.probeText')}</p>
        <ErrorAlert error={error} />
        {ok && (
          <Alert kind="success" title={t('emergency.probeOkTitle')}>
            {t('emergency.probeOk')}
          </Alert>
        )}
        <Field label={t('emergency.sheetCode')}>
          <Input value={code} onChange={(e) => setCode(e.target.value)} className="font-mono" autoComplete="off" spellCheck={false} />
        </Field>
        <Field label={t('emergency.passphrase')}>
          <PasswordInput value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="off" />
        </Field>
        <p className="flex items-center gap-1.5 text-xs text-slate-500">
          <ShieldAlert className="h-3.5 w-3.5" />
          <Trans i18nKey="emergency.probeLocal" />
        </p>
      </div>
    </Modal>
  );
}
