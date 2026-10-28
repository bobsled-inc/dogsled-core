import React from 'react';
import type { ReactNode } from 'react';

const VARIANT_STYLES = {
  default: 'bg-secondary text-muted-foreground',
  primary: 'bg-primary/12 text-primary',
  accent: 'bg-accent/12 text-accent',
  warning: 'bg-warning/12 text-warning',
  danger: 'bg-destructive/12 text-destructive',
  muted: 'bg-secondary/70 text-secondary-foreground',
  info: 'bg-info/12 text-info',
  success: 'bg-success/12 text-success',
} as const;

type BadgeVariant = keyof typeof VARIANT_STYLES;

export function Badge({
  children,
  variant = 'default',
  className = '',
}: {
  children: ReactNode;
  variant?: BadgeVariant;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${VARIANT_STYLES[variant]} ${className}`.trim()}
    >
      {children}
    </span>
  );
}
