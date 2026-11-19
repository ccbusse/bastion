export type ItemType = 'LOGIN' | 'NOTE' | 'CARD' | 'BANK_ACCOUNT' | 'SSH_KEY' | 'API_KEY';
export type UserStatus = 'SETUP_REQUIRED' | 'INVITED' | 'PENDING_CONFIRMATION' | 'ACTIVE' | 'DISABLED';
export type ScopeType = 'TENANT' | 'DEPARTMENT' | 'FOLDER';

export interface SessionInfo {
  user: {
    id: string;
    email: string;
    name: string;
    locale: string;
    systemRole: 'SYSTEM_ADMIN' | 'USER';
    status: UserStatus;
    tenantId: string | null;
    totpEnabled: boolean;
    recoveryCodesLeft: number;
    passwordChangedAt: string | null;
    createdAt: string;
  };
  tenant: { id: string; name: string; slug: string; requireMfa: boolean; keysInitialized: boolean; signingInitialized: boolean } | null;
  /** Tenants, zwischen denen gewechselt werden kann (System-Admins: alle eigenen) */
  tenants: { id: string; name: string }[];
  /** Commit und Build-Datum nur für System-Admins */
  build: { version: string; commit: string | null; builtAt: string | null };
  keys: {
    kdfSalt: string;
    kdfMemory: number;
    kdfIterations: number;
    kdfParallelism: number;
    protectedAccountKey: string;
    protectedPersonalKey: string;
    protectedPrivateKey: string;
    publicKey: string;
    hasRecoveryAccountKey: boolean;
    hasRecoveryVerifier: boolean;
  };
  /** Persönlicher Tresor ist im Notfall-Backup enthalten (bzw. wird beim nächsten Entsperren aufgenommen) */
  emergency: { personalIncluded: boolean };
  /** Einführung: Kurztour gesehen/übersprungen, Checkliste "Erste Schritte" ausgeblendet */
  onboarding?: { tourCompletedAt: string | null; checklistHiddenAt: string | null };
  permissions: { isSystemAdmin: boolean; isTenantAdmin: boolean; tenant: string[] };
  restrictions: { forcePasswordChange: boolean; pendingConfirmation: boolean; mfaSetupRequired: boolean };
  session: { id: string; expiresAt: string; idleMinutes: number; autoLockMinutes: number };
}

export interface FolderInfo {
  id: string;
  parentId: string | null;
  name: string;
  /** Pfad innerhalb der Abteilung, z. B. "Heiner / HW Passwörter" */
  path: string;
  /** 0 = oberste Ebene */
  depth: number;
  description: string;
  inheritPermissions: boolean;
  permissions: string[];
  hasKey: boolean;
  itemCount: number | null;
  /** Jemandem wurde der Schlüssel entzogen: Erneuerung empfohlen (nur für Manager des Ordners gesetzt) */
  keyRotationRecommended?: boolean;
}

export interface DepartmentInfo {
  id: string;
  name: string;
  description: string;
  permissions: string[];
  canManage: boolean;
  folders: FolderInfo[];
}

export interface StructureInfo {
  departments: DepartmentInfo[];
  canManageStructure?: boolean;
}

export interface EncryptedItem {
  id: string;
  type: ItemType;
  folderId: string | null;
  personal: boolean;
  overview: string;
  secret: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  canReveal: boolean;
  canEdit: boolean;
}

export type FieldValues = Record<string, string>;

export interface DecryptedItem extends Omit<EncryptedItem, 'overview' | 'secret'> {
  overview: FieldValues & { name: string };
  secret: FieldValues | null;
  error?: boolean;
}

/** Eintrag im Papierkorb (GET /items/trash). */
export interface EncryptedTrashItem extends EncryptedItem {
  deletedAt: string;
  /** Zeitpunkt, ab dem der Server den Eintrag endgültig löscht */
  purgeAt: string;
}

export interface DecryptedTrashItem extends DecryptedItem {
  deletedAt: string;
  purgeAt: string;
}

export interface UserRow {
  id: string;
  email: string;
  name: string;
  status: UserStatus;
  systemRole: 'SYSTEM_ADMIN' | 'USER';
  totpEnabled: boolean;
  hasRecoveryKey: boolean;
  fingerprint: string | null;
  publicKey: string | null;
  /** Öffentlicher Schlüssel von einem Tenant-Admin beglaubigt (nur in der Benutzerliste des Tenants) */
  endorsed?: boolean;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  confirmedAt: string | null;
  createdAt: string;
  isTenantAdmin: boolean;
  assignments?: { id: string; roleId: string; roleName: string; roleKey: string | null; scopeType: ScopeType; departmentId: string | null; folderId: string | null }[];
}

export interface Role {
  id: string;
  key: string | null;
  name: string;
  description: string;
  permissions: string[];
  isSystem: boolean;
  assignmentCount: number;
}

export interface AuditRow {
  id: string;
  tenantId: string | null;
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  hash: string;
}

export interface InviteResult {
  userId: string;
  emailSent: boolean;
  inviteUrl?: string;
}
