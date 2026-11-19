import { CreditCard, FileText, Globe, KeyRound, Landmark, Terminal } from 'lucide-react';
import type { ItemType } from '../../lib/types';

export function ItemIcon({ type, className = 'h-4 w-4' }: { type: ItemType; className?: string }) {
  switch (type) {
    case 'LOGIN':
      return <Globe className={className} />;
    case 'NOTE':
      return <FileText className={className} />;
    case 'CARD':
      return <CreditCard className={className} />;
    case 'BANK_ACCOUNT':
      return <Landmark className={className} />;
    case 'SSH_KEY':
      return <Terminal className={className} />;
    case 'API_KEY':
      return <KeyRound className={className} />;
  }
}
