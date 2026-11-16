import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="p-6 max-w-xl mx-auto mt-20 text-center space-y-4">
      <div className="text-6xl font-bold text-muted-foreground">404</div>
      <h1 className="text-xl font-bold">Page Not Found</h1>
      <p className="text-xs text-muted-foreground">
        The page you&apos;re looking for doesn&apos;t exist in Bobsled Core Explorer.
      </p>
      <div className="flex justify-center gap-3">
        <Link
          href="/"
          className="px-4 py-2 text-xs bg-primary text-primary-foreground rounded-md hover:bg-primary/80"
        >
          Dashboard
        </Link>
        <Link
          href="/docs"
          className="px-4 py-2 text-xs text-muted-foreground border border-border rounded-md hover:bg-secondary"
        >
          Documentation
        </Link>
      </div>
    </div>
  );
}
