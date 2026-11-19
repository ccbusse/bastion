import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router';
import { Layout } from './components/Layout';
import { FullPageSpinner } from './components/ui';
import { AuditPage } from './pages/admin/AuditPage';
import { RolesPage } from './pages/admin/RolesPage';
import { StructurePage } from './pages/admin/StructurePage';
import { TenantSettingsPage } from './pages/admin/TenantSettingsPage';
import { UsersPage } from './pages/admin/UsersPage';
import { InvitePage } from './pages/auth/InvitePage';
import { LoginPage } from './pages/auth/LoginPage';
import { ForcePasswordChangePage, MfaRequiredPage, PendingConfirmationPage } from './pages/auth/RestrictedPages';
import { SetupPage } from './pages/auth/SetupPage';
import { UnlockPage } from './pages/auth/UnlockPage';
import { AccountPage } from './pages/settings/AccountPage';
import { HelpPage } from './pages/help/HelpPage';
import { EmergencyPage } from './pages/system/EmergencyPage';
import { SystemAdminsPage } from './pages/system/SystemAdminsPage';
import { SystemAuditPage } from './pages/system/SystemAuditPage';
import { SystemSettingsPage } from './pages/system/SystemSettingsPage';
import { TenantsPage } from './pages/system/TenantsPage';
import { GeneratorPage } from './pages/tools/GeneratorPage';
import { ReportPage } from './pages/tools/ReportPage';
import { ExtensionPage } from './pages/tools/ExtensionPage';
import { TrashPage } from './pages/vault/TrashPage';
import { TransferPage } from './pages/tools/TransferPage';
import { VaultPage } from './pages/vault/VaultPage';
import { useSession } from './state/session';

/** Zugriff nur angemeldet + entsperrt; eingeschränkte Konten sehen ausschließlich die jeweilige Pflichtseite. */
function RequireUnlocked() {
  const { status, info, keys } = useSession();
  const location = useLocation();
  if (status === 'loading') return <FullPageSpinner />;
  if (status === 'anonymous' || !info) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (!keys) return <UnlockPage />;
  if (info.restrictions.pendingConfirmation) return <PendingConfirmationPage />;
  if (info.restrictions.forcePasswordChange) return <ForcePasswordChangePage />;
  if (info.restrictions.mfaSetupRequired) return <MfaRequiredPage />;
  return <Outlet />;
}

function PublicOnly({ children }: { children: React.ReactNode }) {
  const { status } = useSession();
  if (status === 'loading') return <FullPageSpinner />;
  if (status === 'authenticated') return <Navigate to="/" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <PublicOnly>
            <LoginPage />
          </PublicOnly>
        }
      />
      <Route
        path="/setup"
        element={
          <PublicOnly>
            <SetupPage />
          </PublicOnly>
        }
      />
      <Route path="/invite" element={<InvitePage />} />
      <Route element={<RequireUnlocked />}>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/vault" replace />} />
          <Route path="/vault" element={<VaultPage />} />
          <Route path="/trash" element={<TrashPage />} />
          <Route path="/tools/generator" element={<GeneratorPage />} />
          <Route path="/tools/report" element={<ReportPage />} />
          <Route path="/tools/transfer" element={<TransferPage />} />
          <Route path="/tools/extension" element={<ExtensionPage />} />
          <Route path="/account" element={<AccountPage />} />
          <Route path="/help" element={<HelpPage />} />
          <Route path="/help/:id" element={<HelpPage />} />
          <Route path="/admin/users" element={<UsersPage />} />
          <Route path="/admin/structure" element={<StructurePage />} />
          <Route path="/admin/roles" element={<RolesPage />} />
          <Route path="/admin/audit" element={<AuditPage />} />
          <Route path="/admin/settings" element={<TenantSettingsPage />} />
          <Route path="/system/tenants" element={<TenantsPage />} />
          <Route path="/system/admins" element={<SystemAdminsPage />} />
          <Route path="/system/smtp" element={<Navigate to="/system/settings?tab=smtp" replace />} />
          <Route path="/system/settings" element={<SystemSettingsPage />} />
          <Route path="/system/audit" element={<SystemAuditPage />} />
          <Route path="/system/emergency" element={<EmergencyPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
