-- Beitritt von System-Admins nur mit Zustimmung eines Tenant-Admins (Standard: eingeschaltet, auch für bestehende Tenants)
ALTER TABLE tenants ADD COLUMN require_join_approval boolean NOT NULL DEFAULT true;

CREATE TABLE tenant_join_requests (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT pk_tenant_join_requests PRIMARY KEY (id),
    CONSTRAINT fk_tenant_join_requests_tenants_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
    CONSTRAINT fk_tenant_join_requests_users_user_id FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX ix_tenant_join_requests_tenant_id_user_id ON tenant_join_requests (tenant_id, user_id);

CREATE INDEX ix_tenant_join_requests_user_id ON tenant_join_requests (user_id);
