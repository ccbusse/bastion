import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../components/ui';
import { AuditTable } from './AuditTable';

export function AuditPage() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-6xl p-6">
      <PageHeader title={t('audit.title')} description={t('audit.description')} help="audit" />
      <AuditTable endpoint="/tenant/audit" />
    </div>
  );
}
