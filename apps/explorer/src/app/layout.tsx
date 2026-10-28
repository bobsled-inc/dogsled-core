import { headers } from 'next/headers';
import { Suspense } from 'react';
import type { Metadata } from 'next';
import { JourneyBanner } from '@/components/journey/banner';
import { Sidebar } from '@/components/layout/sidebar';
import { NAV_ITEMS, type NavItem } from '@/components/layout/sidebar-nav-items';
import { ThemeProvider } from '@/components/layout/theme-provider';
import { isEntityGraphWorkspaceReady } from '@/lib/entity-graph-workspace';
import './globals.css';

export const metadata: Metadata = {
  title: 'Dogsled Explorer',
  description: 'Explore and demo the Dogsled data engineering toolkit',
};

// `buildNavItems()` reads the workspace via `existsSync()` to decide whether to
// show the Entity Graph sidebar group. Without `force-dynamic`, Next 15 can prerender the
// layout at build time and freeze that result until the next deploy, so adding
// or removing `workspace/entity-graph-demo/` after build wouldn't update the sidebar.
export const dynamic = 'force-dynamic';

function SidebarFallback() {
  return (
    <aside className="sticky top-0 z-40 flex w-full flex-col border-b border-border bg-card md:h-screen md:w-56 md:border-b-0 md:border-r" />
  );
}

function buildNavItems(): readonly NavItem[] {
  // Hide the company-sandbox Entity Graph section entirely when the
  // `workspace/entity-graph-demo/` workspace is missing — the surfaces only
  // show a "company sandbox unavailable" warning when the workspace is absent.
  const entityGraphReady = isEntityGraphWorkspaceReady();
  if (entityGraphReady) return NAV_ITEMS;
  return NAV_ITEMS.filter((item) => item.group !== 'ENTITY GRAPH');
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const navItems = buildNavItems();
  const token = (await headers()).get('x-dogsled-explorer-token') ?? '';
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="dogsled-explorer-token" content={token} />
      </head>
      <body className="antialiased">
        <ThemeProvider>
          <div className="flex min-h-screen flex-col md:flex-row">
            <Suspense fallback={<SidebarFallback />}>
              <Sidebar items={navItems} />
            </Suspense>
            <main className="min-w-0 flex-1 overflow-auto">
              <JourneyBanner />
              {children}
            </main>
          </div>
        </ThemeProvider>
      </body>
    </html>
  );
}
