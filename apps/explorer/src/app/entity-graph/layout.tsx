import type { ReactNode } from 'react';
import { EntityGraphShell } from '@/components/entity-graph/entity-graph-shell';

interface EntityGraphLayoutProps {
  children: ReactNode;
}

export default function EntityGraphLayout({ children }: EntityGraphLayoutProps) {
  return <EntityGraphShell>{children}</EntityGraphShell>;
}
