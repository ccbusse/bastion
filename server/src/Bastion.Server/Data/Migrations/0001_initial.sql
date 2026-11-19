-- Bastion – Ausgangsschema (erzeugt mit "Bastion.Server schema" aus dem Datenmodell in Data/)

CREATE TABLE audit_logs (
    id bigint GENERATED ALWAYS AS IDENTITY,
    tenant_id uuid,
    actor_id uuid,
    actor_email text,
    action text NOT NULL,
    target_type text,
    target_id text,
    metadata jsonb,
    ip text,
    user_agent text,
    created_at timestamp with time zone NOT NULL,
    prev_hash text NOT NULL,
    hash text NOT NULL,
    CONSTRAINT pk_audit_logs PRIMARY KEY (id)
);

CREATE TABLE emergency_keys (
    id uuid NOT NULL,
    public_key text NOT NULL,
    protected_private_key text NOT NULL,
    kdf_salt text NOT NULL,
    kdf_memory integer NOT NULL,
    kdf_iterations integer NOT NULL,
    kdf_parallelism integer NOT NULL,
    created_by_id uuid,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT pk_emergency_keys PRIMARY KEY (id)
);

CREATE TABLE emergency_targets (
    id uuid NOT NULL,
    name text NOT NULL,
    type text NOT NULL,
    enabled boolean NOT NULL,
    config jsonb NOT NULL,
    secrets_enc text,
    keep integer NOT NULL,
    last_run_at timestamp with time zone,
    last_success_at timestamp with time zone,
    last_file text,
    last_error text,
    failures integer NOT NULL,
    created_by_id uuid,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT pk_emergency_targets PRIMARY KEY (id)
);

CREATE TABLE system_settings (
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT pk_system_settings PRIMARY KEY (key)
);

CREATE TABLE tenants (
    id uuid NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    require_mfa boolean NOT NULL,
    recovery_public_key text,
    protected_recovery_private_key text,
    signing_public_key text,
    protected_signing_private_key text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT pk_tenants PRIMARY KEY (id)
);

CREATE TABLE departments (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    description text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT pk_departments PRIMARY KEY (id),
    CONSTRAINT fk_departments_tenants_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);

CREATE TABLE emergency_approvals (
    id uuid NOT NULL,
    key_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    signature text NOT NULL,
    approved_by_id uuid,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT pk_emergency_approvals PRIMARY KEY (id),
    CONSTRAINT fk_emergency_approvals_emergency_keys_key_id FOREIGN KEY (key_id) REFERENCES emergency_keys (id) ON DELETE CASCADE,
    CONSTRAINT fk_emergency_approvals_tenants_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);

CREATE TABLE roles (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    key text,
    name text NOT NULL,
    description text NOT NULL,
    permissions text[] NOT NULL,
    is_system boolean NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT pk_roles PRIMARY KEY (id),
    CONSTRAINT fk_roles_tenants_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);

CREATE TABLE users (
    id uuid NOT NULL,
    email text NOT NULL,
    name text NOT NULL,
    system_role text NOT NULL,
    status text NOT NULL,
    locale text NOT NULL,
    tenant_id uuid,
    setup_password_hash text,
    auth_hash text,
    kdf_salt text,
    kdf_memory integer NOT NULL,
    kdf_iterations integer NOT NULL,
    kdf_parallelism integer NOT NULL,
    protected_account_key text,
    protected_personal_key text,
    public_key text,
    protected_private_key text,
    recovery_account_key text,
    recovery_verifier text,
    force_password_change boolean NOT NULL,
    totp_secret_enc text,
    totp_enabled boolean NOT NULL,
    totp_last_step bigint,
    mfa_recovery_codes text[] NOT NULL,
    failed_logins integer NOT NULL,
    locked_until timestamp with time zone,
    confirmed_at timestamp with time zone,
    confirmed_by_id uuid,
    password_changed_at timestamp with time zone,
    last_login_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT pk_users PRIMARY KEY (id),
    CONSTRAINT fk_users_tenants_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);

CREATE TABLE folders (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    department_id uuid NOT NULL,
    parent_id uuid,
    name text NOT NULL,
    description text NOT NULL,
    inherit_permissions boolean NOT NULL,
    secret_keyed boolean NOT NULL,
    key_rotation_recommended boolean NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT pk_folders PRIMARY KEY (id),
    CONSTRAINT fk_folders_departments_department_id FOREIGN KEY (department_id) REFERENCES departments (id) ON DELETE CASCADE,
    CONSTRAINT fk_folders_folders_parent_id FOREIGN KEY (parent_id) REFERENCES folders (id) ON DELETE CASCADE,
    CONSTRAINT fk_folders_tenants_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);

CREATE TABLE emergency_anchors (
    id uuid NOT NULL,
    key_id uuid NOT NULL,
    user_id uuid NOT NULL,
    data text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT pk_emergency_anchors PRIMARY KEY (id),
    CONSTRAINT fk_emergency_anchors_emergency_keys_key_id FOREIGN KEY (key_id) REFERENCES emergency_keys (id) ON DELETE CASCADE,
    CONSTRAINT fk_emergency_anchors_users_user_id FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE emergency_personal_keys (
    id uuid NOT NULL,
    key_id uuid NOT NULL,
    user_id uuid NOT NULL,
    wrapped_key text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT pk_emergency_personal_keys PRIMARY KEY (id),
    CONSTRAINT fk_emergency_personal_keys_emergency_keys_key_id FOREIGN KEY (key_id) REFERENCES emergency_keys (id) ON DELETE CASCADE,
    CONSTRAINT fk_emergency_personal_keys_users_user_id FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE invitations (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    tenant_id uuid,
    token_hash text NOT NULL,
    invited_by_id uuid,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT pk_invitations PRIMARY KEY (id),
    CONSTRAINT fk_invitations_tenants_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
    CONSTRAINT fk_invitations_users_user_id FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE key_endorsements (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    signature text NOT NULL,
    signed_by_id uuid,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT pk_key_endorsements PRIMARY KEY (id),
    CONSTRAINT fk_key_endorsements_tenants_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
    CONSTRAINT fk_key_endorsements_users_user_id FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE recovery_grants (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    wrapped_key text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT pk_recovery_grants PRIMARY KEY (id),
    CONSTRAINT fk_recovery_grants_tenants_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
    CONSTRAINT fk_recovery_grants_users_user_id FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE sessions (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    scope text NOT NULL,
    client text NOT NULL,
    label text,
    created_at timestamp with time zone NOT NULL,
    last_seen_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    ip text,
    user_agent text,
    CONSTRAINT pk_sessions PRIMARY KEY (id),
    CONSTRAINT fk_sessions_users_user_id FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE trust_anchors (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    data text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT pk_trust_anchors PRIMARY KEY (id),
    CONSTRAINT fk_trust_anchors_tenants_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
    CONSTRAINT fk_trust_anchors_users_user_id FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE emergency_folder_keys (
    id uuid NOT NULL,
    key_id uuid NOT NULL,
    folder_id uuid NOT NULL,
    wrapped_key text NOT NULL,
    wrapped_secret_key text,
    created_by_id uuid,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT pk_emergency_folder_keys PRIMARY KEY (id),
    CONSTRAINT fk_emergency_folder_keys_emergency_keys_key_id FOREIGN KEY (key_id) REFERENCES emergency_keys (id) ON DELETE CASCADE,
    CONSTRAINT fk_emergency_folder_keys_folders_folder_id FOREIGN KEY (folder_id) REFERENCES folders (id) ON DELETE CASCADE
);

CREATE TABLE folder_keys (
    id uuid NOT NULL,
    folder_id uuid NOT NULL,
    user_id uuid NOT NULL,
    wrapped_key text NOT NULL,
    wrapped_secret_key text,
    created_by_id uuid,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT pk_folder_keys PRIMARY KEY (id),
    CONSTRAINT fk_folder_keys_folders_folder_id FOREIGN KEY (folder_id) REFERENCES folders (id) ON DELETE CASCADE,
    CONSTRAINT fk_folder_keys_users_user_id FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE items (
    id uuid NOT NULL,
    type text NOT NULL,
    tenant_id uuid,
    folder_id uuid,
    owner_id uuid,
    overview text NOT NULL,
    secret text NOT NULL,
    revision integer NOT NULL,
    created_by_id uuid,
    updated_by_id uuid,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT pk_items PRIMARY KEY (id),
    CONSTRAINT fk_items_folders_folder_id FOREIGN KEY (folder_id) REFERENCES folders (id) ON DELETE CASCADE,
    CONSTRAINT fk_items_tenants_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
    CONSTRAINT fk_items_users_owner_id FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE role_assignments (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role_id uuid NOT NULL,
    scope_type text NOT NULL,
    department_id uuid,
    folder_id uuid,
    created_by_id uuid,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT pk_role_assignments PRIMARY KEY (id),
    CONSTRAINT fk_role_assignments_departments_department_id FOREIGN KEY (department_id) REFERENCES departments (id) ON DELETE CASCADE,
    CONSTRAINT fk_role_assignments_folders_folder_id FOREIGN KEY (folder_id) REFERENCES folders (id) ON DELETE CASCADE,
    CONSTRAINT fk_role_assignments_roles_role_id FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE,
    CONSTRAINT fk_role_assignments_tenants_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
    CONSTRAINT fk_role_assignments_users_user_id FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX ix_audit_logs_created_at ON audit_logs (created_at);

CREATE INDEX ix_audit_logs_tenant_id_created_at ON audit_logs (tenant_id, created_at);

CREATE UNIQUE INDEX ix_departments_tenant_id_name ON departments (tenant_id, name);

CREATE UNIQUE INDEX ix_emergency_anchors_key_id_user_id ON emergency_anchors (key_id, user_id);

CREATE INDEX ix_emergency_anchors_user_id ON emergency_anchors (user_id);

CREATE UNIQUE INDEX ix_emergency_approvals_key_id_tenant_id ON emergency_approvals (key_id, tenant_id);

CREATE INDEX ix_emergency_approvals_tenant_id ON emergency_approvals (tenant_id);

CREATE INDEX ix_emergency_folder_keys_folder_id ON emergency_folder_keys (folder_id);

CREATE UNIQUE INDEX ix_emergency_folder_keys_key_id_folder_id ON emergency_folder_keys (key_id, folder_id);

CREATE UNIQUE INDEX ix_emergency_personal_keys_key_id_user_id ON emergency_personal_keys (key_id, user_id);

CREATE INDEX ix_emergency_personal_keys_user_id ON emergency_personal_keys (user_id);

CREATE UNIQUE INDEX ix_folder_keys_folder_id_user_id ON folder_keys (folder_id, user_id);

CREATE INDEX ix_folder_keys_user_id ON folder_keys (user_id);

CREATE UNIQUE INDEX ix_folders_department_id_parent_id_name ON folders (department_id, parent_id, name) NULLS NOT DISTINCT;

CREATE INDEX ix_folders_parent_id ON folders (parent_id);

CREATE INDEX ix_folders_tenant_id ON folders (tenant_id);

CREATE INDEX ix_invitations_tenant_id ON invitations (tenant_id);

CREATE UNIQUE INDEX ix_invitations_token_hash ON invitations (token_hash);

CREATE INDEX ix_invitations_user_id ON invitations (user_id);

CREATE INDEX ix_items_folder_id ON items (folder_id);

CREATE INDEX ix_items_owner_id ON items (owner_id);

CREATE INDEX ix_items_tenant_id ON items (tenant_id);

CREATE UNIQUE INDEX ix_key_endorsements_tenant_id_user_id ON key_endorsements (tenant_id, user_id);

CREATE INDEX ix_key_endorsements_user_id ON key_endorsements (user_id);

CREATE UNIQUE INDEX ix_recovery_grants_tenant_id_user_id ON recovery_grants (tenant_id, user_id);

CREATE INDEX ix_recovery_grants_user_id ON recovery_grants (user_id);

CREATE INDEX ix_role_assignments_department_id ON role_assignments (department_id);

CREATE INDEX ix_role_assignments_folder_id ON role_assignments (folder_id);

CREATE INDEX ix_role_assignments_role_id ON role_assignments (role_id);

CREATE INDEX ix_role_assignments_tenant_id ON role_assignments (tenant_id);

CREATE INDEX ix_role_assignments_user_id ON role_assignments (user_id);

CREATE UNIQUE INDEX ix_role_assignments_user_id_role_id_scope_type_department_id_f ON role_assignments (user_id, role_id, scope_type, department_id, folder_id) NULLS NOT DISTINCT;

CREATE UNIQUE INDEX ix_roles_tenant_id_name ON roles (tenant_id, name);

CREATE UNIQUE INDEX ix_sessions_token_hash ON sessions (token_hash);

CREATE INDEX ix_sessions_user_id ON sessions (user_id);

CREATE UNIQUE INDEX ix_tenants_slug ON tenants (slug);

CREATE INDEX ix_trust_anchors_tenant_id ON trust_anchors (tenant_id);

CREATE UNIQUE INDEX ix_trust_anchors_user_id_tenant_id ON trust_anchors (user_id, tenant_id);

CREATE UNIQUE INDEX ix_users_email ON users (email);

CREATE INDEX ix_users_tenant_id ON users (tenant_id);


-- Audit-Log ist append-only: UPDATE, DELETE und TRUNCATE werden auf Datenbankebene verhindert.
-- Zusätzlich fehlen dem Datenbankkonto der Anwendung diese Rechte (siehe Migrator.SetupAppRole).
CREATE FUNCTION bastion_audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION bastion_audit_log_immutable();

CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION bastion_audit_log_immutable();
