namespace Bastion.Server.Data;

// Datenmodell. Tresorinhalte liegen ausschließlich als Chiffretext vor (Overview/Secret, verpackte Schlüssel);
// der Server kennt keinen Klartext. Tabellen- und Spaltennamen werden in snake_case angelegt (siehe BastionDb).

public enum SystemRole { SYSTEM_ADMIN, USER }

public enum UserStatus
{
    /// <summary>Nur der initiale Admin vor der Ersteinrichtung.</summary>
    SETUP_REQUIRED,
    /// <summary>Einladung versendet, noch nicht angenommen.</summary>
    INVITED,
    /// <summary>Einladung angenommen, wartet auf Bestätigung durch einen Admin.</summary>
    PENDING_CONFIRMATION,
    ACTIVE,
    DISABLED,
}

public enum ScopeType { TENANT, DEPARTMENT, FOLDER }

public enum ItemType { LOGIN, NOTE, CARD, BANK_ACCOUNT, SSH_KEY, API_KEY }

public enum SessionScope { FULL, SETUP, MFA }

public enum SessionClient { WEB, EXTENSION }

public enum EmergencyTargetType { FOLDER, SMB, SFTP, WEBDAV }

public class User
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Email { get; set; } = "";
    public string Name { get; set; } = "";
    public SystemRole SystemRole { get; set; } = SystemRole.USER;
    public UserStatus Status { get; set; }
    public string Locale { get; set; } = "de";
    public Guid? TenantId { get; set; }
    public Tenant? Tenant { get; set; }

    // Authentifizierung: AuthHash = Argon2id (Server) über den im Browser abgeleiteten Auth-Hash
    public string? SetupPasswordHash { get; set; }
    public string? AuthHash { get; set; }
    public string? KdfSalt { get; set; }
    public int KdfMemory { get; set; } = 65536;
    public int KdfIterations { get; set; } = 3;
    public int KdfParallelism { get; set; } = 4;

    // Schlüssel (alle im Browser erzeugt und verschlüsselt)
    public string? ProtectedAccountKey { get; set; }
    public string? ProtectedPersonalKey { get; set; }
    public string? PublicKey { get; set; }
    public string? ProtectedPrivateKey { get; set; }
    public string? RecoveryAccountKey { get; set; }
    public string? RecoveryVerifier { get; set; }
    public bool ForcePasswordChange { get; set; }

    // Zweiter Faktor
    public string? TotpSecretEnc { get; set; }
    public bool TotpEnabled { get; set; }
    public long? TotpLastStep { get; set; }
    public List<string> MfaRecoveryCodes { get; set; } = [];

    public int FailedLogins { get; set; }
    public DateTime? LockedUntil { get; set; }
    public DateTime? ConfirmedAt { get; set; }
    public Guid? ConfirmedById { get; set; }
    public DateTime? PasswordChangedAt { get; set; }
    public DateTime? LastLoginAt { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    // Einführung für neue Benutzer: Kurztour gesehen bzw. übersprungen, Checkliste "Erste Schritte" ausgeblendet
    public DateTime? TourCompletedAt { get; set; }
    public DateTime? ChecklistHiddenAt { get; set; }

    public List<RoleAssignment> Assignments { get; set; } = [];
    public List<KeyEndorsement> Endorsements { get; set; } = [];
}

public class Tenant
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Name { get; set; } = "";
    public string Slug { get; set; } = "";
    public bool RequireMfa { get; set; }
    /// <summary>System-Admins treten nur nach Zustimmung eines Tenant-Admins bei (siehe TenantJoinRequest).</summary>
    public bool RequireJoinApproval { get; set; } = true;
    public string? RecoveryPublicKey { get; set; }
    public string? ProtectedRecoveryPrivateKey { get; set; }
    public string? SigningPublicKey { get; set; }
    public string? ProtectedSigningPrivateKey { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>Beglaubigung: Signatur des Tenant-Signaturschlüssels über den öffentlichen Schlüssel eines Mitglieds.</summary>
public class KeyEndorsement
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid UserId { get; set; }
    public string Signature { get; set; } = "";
    public Guid? SignedById { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>Vertrauensanker: öffentliche Tenant-Schlüssel, im Browser mit dem AccountKey versiegelt.</summary>
public class TrustAnchor
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid UserId { get; set; }
    public Guid TenantId { get; set; }
    public string Data { get; set; } = "";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>Beitrittsanfrage eines System-Admins; ein Tenant-Admin stimmt zu oder lehnt ab. Unbeantwortet verfällt sie.</summary>
public class TenantJoinRequest
{
    public static readonly TimeSpan Lifetime = TimeSpan.FromDays(7);

    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid UserId { get; set; }
    public User User { get; set; } = null!;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime ExpiresAt { get; set; }
}

/// <summary>Zugang eines Tenant-Admins zum Recovery- und Signaturschlüssel (AdminWrapKey, RSA-verpackt).</summary>
public class RecoveryGrant
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid UserId { get; set; }
    public string WrappedKey { get; set; } = "";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public class Department
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public string Name { get; set; } = "";
    public string Description { get; set; } = "";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public List<Folder> Folders { get; set; } = [];
}

public class Folder
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid DepartmentId { get; set; }
    /// <summary>Übergeordneter Ordner; null = oberste Ebene der Abteilung.</summary>
    public Guid? ParentId { get; set; }
    public string Name { get; set; } = "";
    public string Description { get; set; } = "";
    public bool InheritPermissions { get; set; } = true;
    /// <summary>Geheimteile mit eigenem Schlüssel verschlüsselt (nur Berechtigte mit "reveal" erhalten ihn).</summary>
    public bool SecretKeyed { get; set; }
    /// <summary>Jemandem wurde der Schlüssel entzogen: Erneuerung empfohlen.</summary>
    public bool KeyRotationRecommended { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public class FolderKey
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid FolderId { get; set; }
    public Folder Folder { get; set; } = null!;
    public Guid UserId { get; set; }
    public string WrappedKey { get; set; } = "";
    public string? WrappedSecretKey { get; set; }
    public Guid? CreatedById { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    // Herkunftsnachweis (siehe FolderKeyProof): Wer den Schlüssel für diesen Benutzer verpackt hat, signiert das Paket.
    // Der Browser des Empfängers prüft Signatur und Beglaubigung des Absenders, bevor er den Schlüssel verwendet.
    // Öffentlicher Schlüssel und Beglaubigung des Absenders liegen mit im Datensatz, damit die Prüfung auch nach dessen
    // Ausscheiden möglich bleibt. Ohne Nachweis: Schlüssel aus der Zeit davor (der Empfänger bestätigt ihn einmalig selbst).
    public Guid? SignerId { get; set; }
    public string? SignerPublicKey { get; set; }
    public string? SignerEndorsement { get; set; }
    public string? Signature { get; set; }
    /// <summary>SHA-256 eines signierten, später entfernten Geheim-Schlüssels (Recht "reveal" entzogen): Die Signatur bleibt prüfbar.</summary>
    public string? StrippedSecretHash { get; set; }
}

public class Item
{
    /// <summary>Im Browser erzeugt (Teil der Associated Data der Verschlüsselung).</summary>
    public Guid Id { get; set; }
    public ItemType Type { get; set; }
    public Guid? TenantId { get; set; }
    public Guid? FolderId { get; set; }
    public Folder? Folder { get; set; }
    public Guid? OwnerId { get; set; }
    public string Overview { get; set; } = "";
    public string Secret { get; set; } = "";
    public int Revision { get; set; } = 1;
    public Guid? CreatedById { get; set; }
    public Guid? UpdatedById { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    /// <summary>Im Papierkorb seit (null = aktiv). Endgültig gelöscht nach TRASH_RETENTION_DAYS.</summary>
    public DateTime? DeletedAt { get; set; }
    public Guid? DeletedById { get; set; }
}

public class Role
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    /// <summary>Kennung eingebauter Rollen (z. B. "tenant_admin"); null bei eigenen Rollen.</summary>
    public string? Key { get; set; }
    public string Name { get; set; } = "";
    public string Description { get; set; } = "";
    public List<string> Permissions { get; set; } = [];
    public bool IsSystem { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public List<RoleAssignment> Assignments { get; set; } = [];
}

public class RoleAssignment
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Tenant Tenant { get; set; } = null!;
    public Guid UserId { get; set; }
    public User User { get; set; } = null!;
    public Guid RoleId { get; set; }
    public Role Role { get; set; } = null!;
    public ScopeType ScopeType { get; set; }
    public Guid? DepartmentId { get; set; }
    public Guid? FolderId { get; set; }
    public Guid? CreatedById { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public class Invitation
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid UserId { get; set; }
    public User User { get; set; } = null!;
    public Guid? TenantId { get; set; }
    public Tenant? Tenant { get; set; }
    public string TokenHash { get; set; } = "";
    public Guid? InvitedById { get; set; }
    public DateTime ExpiresAt { get; set; }
    public DateTime? AcceptedAt { get; set; }
    public DateTime? RevokedAt { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public class Session
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid UserId { get; set; }
    public User User { get; set; } = null!;
    /// <summary>HMAC des Tokens; das Token selbst wird nie gespeichert.</summary>
    public string TokenHash { get; set; } = "";
    public SessionScope Scope { get; set; }
    public SessionClient Client { get; set; } = SessionClient.WEB;
    public string? Label { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime LastSeenAt { get; set; } = DateTime.UtcNow;
    public DateTime ExpiresAt { get; set; }
    public string? Ip { get; set; }
    public string? UserAgent { get; set; }
    /// <summary>Letzte erneute Eingabe des Masterpassworts in dieser Sitzung (für kritische Aktionen, siehe RequireRecentAuth).</summary>
    public DateTime? ReauthAt { get; set; }
    /// <summary>Erster vollständiger Abruf der Einträge in dieser Sitzung (Audit "items.listed" nur einmal je Sitzung).</summary>
    public DateTime? ItemsListedAt { get; set; }
}

/// <summary>Append-only (DB-Trigger) mit HMAC-Hash-Kette zur Manipulationserkennung.</summary>
public class AuditLog
{
    public long Id { get; set; }
    public Guid? TenantId { get; set; }
    public Guid? ActorId { get; set; }
    public string? ActorEmail { get; set; }
    public string Action { get; set; } = "";
    public string? TargetType { get; set; }
    public string? TargetId { get; set; }
    /// <summary>JSON (jsonb).</summary>
    public string? Metadata { get; set; }
    public string? Ip { get; set; }
    public string? UserAgent { get; set; }
    public DateTime CreatedAt { get; set; }
    public string PrevHash { get; set; } = "";
    public string Hash { get; set; } = "";
}

public class SystemSetting
{
    public string Key { get; set; } = "";
    /// <summary>JSON (jsonb).</summary>
    public string Value { get; set; } = "{}";
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

// ---------- Notfall-Backup ----------

/// <summary>Notfallschlüssel (RSA-OAEP-4096), im Browser eines System-Admins erzeugt; der private Teil ist mit Schlüsselblatt und Passphrase geschützt.</summary>
public class EmergencyKey
{
    public Guid Id { get; set; }
    public string PublicKey { get; set; } = "";
    public string ProtectedPrivateKey { get; set; } = "";
    public string KdfSalt { get; set; } = "";
    public int KdfMemory { get; set; }
    public int KdfIterations { get; set; }
    public int KdfParallelism { get; set; }
    public Guid? CreatedById { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>Freigabe je Tenant: Signatur des Tenant-Signaturschlüssels über den Notfallschlüssel.</summary>
public class EmergencyApproval
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid KeyId { get; set; }
    public Guid TenantId { get; set; }
    public string Signature { get; set; } = "";
    public Guid? ApprovedById { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public class EmergencyFolderKey
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid KeyId { get; set; }
    public Guid FolderId { get; set; }
    public Folder Folder { get; set; } = null!;
    public string WrappedKey { get; set; } = "";
    public string? WrappedSecretKey { get; set; }
    public Guid? CreatedById { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public class EmergencyPersonalKey
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid KeyId { get; set; }
    public Guid UserId { get; set; }
    public User User { get; set; } = null!;
    public string WrappedKey { get; set; } = "";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>Bestätigung des Notfallschlüssels durch einen System-Admin (mit seinem AccountKey versiegelt).</summary>
public class EmergencyAnchor
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid KeyId { get; set; }
    public Guid UserId { get; set; }
    public string Data { get; set; } = "";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>Ziel für den automatischen Export des Notfall-Backups; Zugangsdaten mit APP_SECRET verschlüsselt.</summary>
public class EmergencyTarget
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Name { get; set; } = "";
    public EmergencyTargetType Type { get; set; }
    public bool Enabled { get; set; } = true;
    /// <summary>Nicht geheime Einstellungen als JSON (Host, Pfad …).</summary>
    public string Config { get; set; } = "{}";
    public string? SecretsEnc { get; set; }
    /// <summary>Anzahl aufbewahrter Backups, 0 = nie löschen.</summary>
    public int Keep { get; set; } = 30;
    public DateTime? LastRunAt { get; set; }
    public DateTime? LastSuccessAt { get; set; }
    public string? LastFile { get; set; }
    public string? LastError { get; set; }
    public int Failures { get; set; }
    public Guid? CreatedById { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
