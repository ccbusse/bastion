import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, CornerDownRight, Folder, FolderPlus, KeyRound, Pencil, Plus, Shield, Trash2, Unlink } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Badge, Button, Card, Checkbox, ConfirmModal, EmptyState, ErrorAlert, Field, IconButton, Input, Modal, PageHeader, Select, Spinner, Textarea, useErrorMessage } from '../../components/ui';
import { del, get, patch, post } from '../../lib/api';
import { uuid } from '../../lib/crypto/encoding';
import type { DepartmentInfo, FolderInfo, ScopeType } from '../../lib/types';
import { useUnlocked } from '../../state/session';
import { afterAccessChange, createFolderKeys, distributePendingKeys, rotateFolderKey, UnreadableItemsError, type RotationResult, type UnreadableItem } from '../../state/vault';
import { RotationNotice } from '../../components/RotationNotice';
import { AccessLevelPicker, accessLevels, roleLabel, useAdminStructure, useRoles } from './shared';

type Editing =
  | { kind: 'dept'; dept?: DepartmentInfo }
  | { kind: 'folder'; dept: DepartmentInfo; folder?: FolderInfo; parent?: FolderInfo }
  | { kind: 'perms'; scopeType: ScopeType; id: string; title: string }
  | { kind: 'deleteDept'; dept: DepartmentInfo }
  | { kind: 'deleteFolder'; folder: FolderInfo }
  | { kind: 'rotate'; folder: FolderInfo }
  | { kind: 'rotateUnreadable'; folder: FolderInfo; items: UnreadableItem[] }
  | { kind: 'rotateAll'; folders: FolderInfo[] }
  | null;

/** Ordner, deren Schlüssel der Benutzer erneuern kann und für die eine Erneuerung empfohlen ist. */
const rotationCandidates = (departments: DepartmentInfo[]) =>
  departments.flatMap((d) => d.folders).filter((f) => f.keyRotationRecommended && f.hasKey && f.permissions.includes('vault.manage'));

function DepartmentModal({ dept, onClose }: { dept?: DepartmentInfo; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState(dept?.name ?? '');
  const [description, setDescription] = useState(dept?.description ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (dept) await patch(`/departments/${dept.id}`, { name, description });
      else await post('/departments', { name, description });
      await qc.invalidateQueries({ queryKey: ['structure'] });
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={dept ? t('structure.editDepartment') : t('structure.newDepartment')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} loading={busy} disabled={!name.trim()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <ErrorAlert error={error} />
        <Field label={t('common.name')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus />
        </Field>
        <Field label={t('common.description')}>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
        </Field>
      </div>
    </Modal>
  );
}

function FolderModal({ dept, folder, parent, onClose }: { dept: DepartmentInfo; folder?: FolderInfo; parent?: FolderInfo; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { info, keys } = useUnlocked();
  const [name, setName] = useState(folder?.name ?? '');
  const [description, setDescription] = useState(folder?.description ?? '');
  const [inherit, setInherit] = useState(folder?.inheritPermissions ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (folder) {
        await patch(`/folders/${folder.id}`, { name, description, inheritPermissions: inherit });
      } else {
        // Ordner- und Geheim-Schlüssel lokal erzeugen und nur für beglaubigte Berechtigte verschlüsseln
        const query = new URLSearchParams({ inherit: String(inherit), ...(parent ? { parentId: parent.id } : {}) });
        const recipients = await get<{ userId: string; publicKey: string | null; reveal: boolean; endorsement: string | null }[]>(`/departments/${dept.id}/recipients?${query}`);
        const id = uuid();
        const { wrapped } = await createFolderKeys(info, keys, id, recipients);
        await post('/folders', { id, departmentId: dept.id, parentId: parent?.id ?? null, name, description, inheritPermissions: inherit, keys: wrapped });
      }
      await distributePendingKeys(info, keys).catch(() => 0);
      await Promise.all(['structure', 'items'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={folder ? t('structure.editFolder') : t('structure.newFolderIn', { dept: parent ? `${dept.name} / ${parent.path}` : dept.name })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} loading={busy} disabled={!name.trim()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <ErrorAlert error={error} />
        <Field label={t('common.name')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus />
        </Field>
        <Field label={t('common.description')}>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
        </Field>
        <Checkbox label={t('structure.inherit')} hint={t(parent ? 'structure.inheritParentHint' : 'structure.inheritHint')} checked={inherit} onChange={setInherit} />
      </div>
    </Modal>
  );
}

interface AssignmentRow {
  id: string;
  user: { id: string; name: string; email: string; status: string };
  role: { id: string; name: string; key: string | null; permissions: string[] };
}

/** Berechtigungen auf Abteilungs- oder Ordnerebene (Delegation durch Manager möglich). */
function PermissionsModal({ scopeType, id, title, onClose }: { scopeType: ScopeType; id: string; title: string; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { info, keys } = useUnlocked();
  const param = scopeType === 'DEPARTMENT' ? `departmentId=${id}` : `folderId=${id}`;
  const rows = useQuery({ queryKey: ['assignments', scopeType, id], queryFn: () => get<AssignmentRow[]>(`/assignments?scopeType=${scopeType}&${param}`) });
  const directory = useQuery({ queryKey: ['directory'], queryFn: () => get<{ id: string; name: string; email: string }[]>('/users/directory') });
  const roles = useRoles();
  const levels = accessLevels(roles.data);
  const [userId, setUserId] = useState('');
  const [roleId, setRoleId] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [rotation, setRotation] = useState<RotationResult | null>(null);

  // Nach jeder Änderung: Schlüssel an neu Berechtigte verteilen; nach einem Entzug betroffene Ordner gleich erneuern
  // Übersprungene Ordner nur nach einem Entzug melden, sonst stünde der Hinweis bei jeder Freigabe erneut da
  const after = async (revoked = false) => {
    const r = await afterAccessChange(info, keys);
    setRotation(revoked ? r : { ...r, skipped: [] });
    await Promise.all([['assignments', scopeType, id], ['structure'], ['items'], ['users']].map((k) => qc.invalidateQueries({ queryKey: k })));
  };

  return (
    <Modal open onClose={onClose} title={t('structure.permissionsOf', { name: title })} size="lg" footer={<Button onClick={onClose}>{t('common.done')}</Button>}>
      <div className="space-y-5">
        <ErrorAlert error={error} />
        <RotationNotice result={rotation} />
        {rows.isLoading ? (
          <Spinner />
        ) : rows.error ? (
          <ErrorAlert error={rows.error} />
        ) : (
          <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
            {rows.data?.length ? (
              rows.data.map((a) => (
                <li key={a.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <div className="mr-auto">
                    <p className="font-medium text-slate-800">
                      {a.user.name || a.user.email} {a.user.id === info.user.id && <span className="text-xs font-normal text-slate-400">({t('users.you')})</span>}
                    </p>
                    <p className="text-xs text-slate-500">{a.user.email}</p>
                  </div>
                  <Badge color="blue">{roleLabel(t, a.role)}</Badge>
                  {/* Eigene Rechte entzieht nur jemand anderes (der Server lehnt es ebenfalls ab) */}
                  {a.user.id === info.user.id ? (
                    <span className="w-8" title={t('users.ownRolesHint')} />
                  ) : (
                  <IconButton
                    label={t('common.remove')}
                    onClick={async () => {
                      setError(null);
                      try {
                        await del(`/assignments/${a.id}`);
                        await after(true);
                      } catch (e) {
                        setError(e);
                      }
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </IconButton>
                  )}
                </li>
              ))
            ) : (
              <li className="px-3 py-3 text-sm text-slate-400">{t('structure.noDirectPermissions')}</li>
            )}
          </ul>
        )}
        <div className="space-y-3 rounded-md bg-slate-50 p-4">
          <p className="text-sm font-medium text-slate-700">{t('structure.grantAccess')}</p>
          <Field label={t('structure.user')}>
            <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">{t('common.choose')}</option>
              {directory.data?.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name ? `${u.name} (${u.email})` : u.email}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('access.level')}>
            <AccessLevelPicker roles={levels} value={roleId} onChange={setRoleId} />
          </Field>
          <Button
            size="sm"
            icon={<Plus className="h-4 w-4" />}
            disabled={!userId || !roleId}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await post('/assignments', { userId, roleId, scopeType, ...(scopeType === 'DEPARTMENT' ? { departmentId: id } : { folderId: id }) });
                setUserId('');
                setRoleId('');
                await after();
              } catch (e) {
                setError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('common.add')}
          </Button>
          <p className="text-xs text-slate-500">{t('structure.keyDistributionHint')}</p>
        </div>
      </div>
    </Modal>
  );
}

export function StructurePage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const errMsg = useErrorMessage();
  const structure = useAdminStructure();
  const { info, keys } = useUnlocked();
  const [editing, setEditing] = useState<Editing>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const canStructure = !!structure.data?.canManageStructure;
  const candidates = rotationCandidates(structure.data?.departments ?? []);

  /**
   * Alle empfohlenen Ordner nacheinander erneuern. Ordner mit unlesbaren Einträgen werden übersprungen
   * (sie brauchen eine Einzelentscheidung), Fehler bei einem Ordner halten die übrigen nicht auf.
   */
  const rotateAll = async (folders: FolderInfo[]) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    setSkipped([]);
    const unreadable: string[] = [];
    const failed: string[] = [];
    let ok = 0;
    try {
      for (const [i, folder] of folders.entries()) {
        setProgress({ done: i, total: folders.length, current: folder.path });
        try {
          await rotateFolderKey(info, keys, folder.id);
          ok++;
        } catch (e) {
          if (e instanceof UnreadableItemsError) unreadable.push(folder.path);
          else failed.push(`${folder.path}: ${errMsg(e)}`);
        }
      }
    } finally {
      await Promise.all(['structure', 'items'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
      setProgress(null);
      setBusy(false);
      setEditing(null);
    }
    if (ok > 0) setNotice(t('structure.rotateAllDone', { count: ok }));
    setSkipped(unreadable);
    if (failed.length > 0) setError(t('structure.rotateAllFailed', { list: failed.join('; ') }));
  };

  const rotate = async (folder: FolderInfo, keepUnreadable = false) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    let next: Editing = null;
    try {
      await rotateFolderKey(info, keys, folder.id, { keepUnreadable });
      await Promise.all(['structure', 'items'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
      setNotice(t('structure.rotateDone', { name: folder.name }));
    } catch (e) {
      // Unlesbare Einträge: nichts geändert, erst nach ausdrücklicher Bestätigung fortfahren
      if (e instanceof UnreadableItemsError) next = { kind: 'rotateUnreadable', folder, items: e.items };
      else setError(errMsg(e));
    } finally {
      setBusy(false);
      setEditing(next);
    }
  };

  const remove = async (path: string) => {
    setBusy(true);
    setError(null);
    try {
      await del(path);
      await Promise.all(['structure', 'items'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
      setEditing(null);
    }
  };

  return (
    <div className="mx-auto max-w-5xl p-6">
      <PageHeader
        title={t('structure.title')}
        description={t('structure.description')}
        help="structure"
        actions={
          <>
            {candidates.length > 1 && (
              <Button variant="secondary" icon={<KeyRound className="h-4 w-4" />} onClick={() => setEditing({ kind: 'rotateAll', folders: candidates })}>
                {t('structure.rotateAll', { count: candidates.length })}
              </Button>
            )}
            {canStructure && (
              <Button icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({ kind: 'dept' })}>
                {t('structure.newDepartment')}
              </Button>
            )}
          </>
        }
      />
      {error && (
        <Alert kind="error" className="mb-4">
          {error}
        </Alert>
      )}
      {notice && (
        <Alert kind="success" className="mb-4">
          {notice}
        </Alert>
      )}
      {skipped.length > 0 && (
        <Alert kind="warning" className="mb-4" title={t('structure.rotateAllSkipped', { count: skipped.length })}>
          {skipped.join(', ')}
        </Alert>
      )}
      {structure.isLoading ? (
        <Spinner />
      ) : !structure.data?.departments.length ? (
        <Card>
          <EmptyState icon={<Building2 className="h-10 w-10" />} title={t('structure.empty')}>
            {t('structure.emptyHint')}
          </EmptyState>
        </Card>
      ) : (
        <div className="space-y-5">
          {structure.data.departments.map((d) => (
            <Card
              key={d.id}
              title={
                <span className="flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-brand-500" /> {d.name}
                </span>
              }
              actions={
                <>
                  {d.canManage && (
                    <Button size="sm" variant="secondary" icon={<Shield className="h-3.5 w-3.5" />} onClick={() => setEditing({ kind: 'perms', scopeType: 'DEPARTMENT', id: d.id, title: d.name })}>
                      {t('structure.permissions')}
                    </Button>
                  )}
                  {d.canManage && (
                    <Button size="sm" variant="secondary" icon={<FolderPlus className="h-3.5 w-3.5" />} onClick={() => setEditing({ kind: 'folder', dept: d })}>
                      {t('structure.newFolder')}
                    </Button>
                  )}
                  {canStructure && (
                    <>
                      <IconButton label={t('common.edit')} onClick={() => setEditing({ kind: 'dept', dept: d })}>
                        <Pencil className="h-4 w-4" />
                      </IconButton>
                      <IconButton label={t('common.delete')} onClick={() => setEditing({ kind: 'deleteDept', dept: d })}>
                        <Trash2 className="h-4 w-4" />
                      </IconButton>
                    </>
                  )}
                </>
              }
            >
              {d.description && <p className="mb-3 text-sm text-slate-500">{d.description}</p>}
              {d.folders.length === 0 ? (
                <p className="text-sm text-slate-400">{t('structure.noFolders')}</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {d.folders.map((f) => {
                    const canManageFolder = canStructure || f.permissions.includes('vault.manage');
                    return (
                      <li key={f.id} className="flex flex-wrap items-center gap-3 py-2.5" style={{ paddingLeft: `${f.depth * 1.5}rem` }}>
                        {f.depth > 0 ? <CornerDownRight className="h-4 w-4 text-slate-300" /> : <Folder className="h-4 w-4 text-slate-400" />}
                        <div className="mr-auto min-w-0">
                          <p className="text-sm font-medium text-slate-800">{f.name}</p>
                          {f.description && <p className="truncate text-xs text-slate-500">{f.description}</p>}
                        </div>
                        {!f.inheritPermissions && (
                          <Badge color="yellow">
                            <Unlink className="mr-1 h-3 w-3" />
                            {t('structure.noInherit')}
                          </Badge>
                        )}
                        {f.itemCount !== null && <Badge>{t('structure.items', { count: f.itemCount })}</Badge>}
                        {f.keyRotationRecommended && (
                          <Badge color="red">
                            <KeyRound className="mr-1 h-3 w-3" />
                            {t('structure.rotationRecommended')}
                          </Badge>
                        )}
                        {f.permissions.includes('vault.manage') && f.hasKey && (
                          <Button size="sm" variant={f.keyRotationRecommended ? 'secondary' : 'ghost'} icon={<KeyRound className="h-3.5 w-3.5" />} onClick={() => setEditing({ kind: 'rotate', folder: f })}>
                            {t('structure.rotateKey')}
                          </Button>
                        )}
                        {canManageFolder && (
                          <>
                            <Button size="sm" variant="ghost" icon={<FolderPlus className="h-3.5 w-3.5" />} onClick={() => setEditing({ kind: 'folder', dept: d, parent: f })}>
                              {t('structure.newSubfolder')}
                            </Button>
                            <Button size="sm" variant="ghost" icon={<Shield className="h-3.5 w-3.5" />} onClick={() => setEditing({ kind: 'perms', scopeType: 'FOLDER', id: f.id, title: `${d.name} / ${f.path}` })}>
                              {t('structure.permissions')}
                            </Button>
                            <IconButton label={t('common.edit')} onClick={() => setEditing({ kind: 'folder', dept: d, folder: f })}>
                              <Pencil className="h-4 w-4" />
                            </IconButton>
                          </>
                        )}
                        {d.canManage && (
                          <IconButton label={t('common.delete')} onClick={() => setEditing({ kind: 'deleteFolder', folder: f })}>
                            <Trash2 className="h-4 w-4" />
                          </IconButton>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          ))}
        </div>
      )}

      {editing?.kind === 'dept' && <DepartmentModal dept={editing.dept} onClose={() => setEditing(null)} />}
      {editing?.kind === 'folder' && <FolderModal dept={editing.dept} folder={editing.folder} parent={editing.parent} onClose={() => setEditing(null)} />}
      {editing?.kind === 'perms' && <PermissionsModal scopeType={editing.scopeType} id={editing.id} title={editing.title} onClose={() => setEditing(null)} />}
      {editing?.kind === 'deleteDept' && (
        <ConfirmModal open danger loading={busy} title={t('structure.deleteDepartment')} confirmLabel={t('common.delete')} onClose={() => setEditing(null)} onConfirm={() => remove(`/departments/${editing.dept.id}`)}>
          {t('structure.deleteDepartmentText', { name: editing.dept.name })}
        </ConfirmModal>
      )}
      {editing?.kind === 'rotate' && (
        <ConfirmModal open loading={busy} title={t('structure.rotateTitle')} confirmLabel={t('structure.rotateKey')} onClose={() => setEditing(null)} onConfirm={() => rotate(editing.folder)}>
          <p>{t('structure.rotateText', { name: editing.folder.name, count: editing.folder.itemCount ?? 0 })}</p>
          <p className="mt-2 text-xs text-slate-500">{t('structure.rotateHint')}</p>
        </ConfirmModal>
      )}
      {editing?.kind === 'rotateAll' && (
        <ConfirmModal
          open
          loading={busy}
          title={t('structure.rotateAllTitle')}
          confirmLabel={t('structure.rotateAll', { count: editing.folders.length })}
          onClose={() => !busy && setEditing(null)}
          onConfirm={() => rotateAll(editing.folders)}
        >
          <p>{t('structure.rotateAllText', { count: editing.folders.length })}</p>
          <ul className="my-3 max-h-48 list-disc overflow-auto pl-5 text-xs">
            {editing.folders.map((f) => (
              <li key={f.id}>
                {f.path} <span className="text-slate-400">({t('structure.items', { count: f.itemCount ?? 0 })})</span>
              </li>
            ))}
          </ul>
          {progress ? (
            <p className="text-sm font-medium text-slate-700" role="status">
              {t('structure.rotateAllProgress', { done: progress.done + 1, total: progress.total, name: progress.current })}
            </p>
          ) : (
            <p className="text-xs text-slate-500">{t('structure.rotateAllHint')}</p>
          )}
        </ConfirmModal>
      )}
      {editing?.kind === 'rotateUnreadable' && (
        <ConfirmModal
          open
          danger
          loading={busy}
          title={t('structure.unreadableTitle')}
          confirmLabel={t('structure.unreadableConfirm')}
          onClose={() => setEditing(null)}
          onConfirm={() => rotate(editing.folder, true)}
        >
          <p>{t('structure.unreadableText', { name: editing.folder.name, count: editing.items.length })}</p>
          <ul className="my-3 max-h-48 list-disc overflow-auto pl-5 text-xs" data-testid="unreadable-items">
            {editing.items.map((i) => (
              <li key={i.id}>
                {i.name ?? t('structure.unreadableNoName')} <span className="text-slate-400">({new Date(i.updatedAt).toLocaleString()} · {i.id.slice(0, 8)})</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-slate-500">{t('structure.unreadableHint')}</p>
        </ConfirmModal>
      )}
      {editing?.kind === 'deleteFolder' && (
        <ConfirmModal open danger loading={busy} title={t('structure.deleteFolder')} confirmLabel={t('common.delete')} onClose={() => setEditing(null)} onConfirm={() => remove(`/folders/${editing.folder.id}`)}>
          {t('structure.deleteFolderText', { name: editing.folder.name, count: editing.folder.itemCount ?? 0 })}
        </ConfirmModal>
      )}
    </div>
  );
}
