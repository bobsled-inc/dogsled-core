export function LoadingSkeleton({ className = '' }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded-md bg-secondary/80 ${className}`.trim()}
      aria-hidden="true"
    />
  );
}
