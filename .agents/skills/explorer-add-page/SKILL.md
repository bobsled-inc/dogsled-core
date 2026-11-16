---
name: explorer-add-page
description: Add a new page to the Dogsled Explorer app. Scaffolds the page component, API route, sidebar entry, and docs update.
argument-hint: '<page-name> — e.g., "connections" or "schedules"'
---

# Explorer Add Page — Scaffold a New Explorer Page

Add a complete new page to the Dogsled Explorer at `apps/explorer/`.

## Usage

```
/explorer-add-page <page-name>
```

Example: `/explorer-add-page connections`

## Workflow

### Step 1: Validate

Check the page doesn't already exist:

```bash
ls apps/explorer/src/app/<page-name>/
```

If it exists, ask the user whether to modify or abort.

### Step 2: Create the page component

Create `apps/explorer/src/app/<page-name>/page.tsx`.

Follow these conventions:

- Add `'use client';` at top if the page has interactivity (most pages do)
- Use Server Components (no `'use client'`) for read-only pages that only need data at build time
- Import `Link` from `next/link` for navigation
- Use consistent styling: `p-6 max-w-5xl mx-auto space-y-6` for container
- Page title: `text-xl font-bold tracking-tight`
- Subtitle: `text-xs text-muted-foreground mt-1`
- Loading state: `<div className="p-6 text-xs text-muted-foreground">Loading...</div>`
- Error state: show error message + back link

Example skeleton:

```tsx
'use client';

import { useState, useEffect } from 'react';

export default function PageNamePage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/<page-name>')
      .then((r) => {
        if (!r.ok) throw new Error('Failed to load');
        return r.json();
      })
      .then((data) => {
        /* setState */ setLoading(false);
      })
      .catch((err) => {
        setError(String(err));
        setLoading(false);
      });
  }, []);

  if (loading) return <div className="p-6 text-xs text-muted-foreground">Loading...</div>;
  if (error)
    return (
      <div className="p-6">
        <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-4">
          <div className="text-xs text-destructive">{error}</div>
        </div>
      </div>
    );

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Page Title</h1>
        <p className="text-xs text-muted-foreground mt-1">Page description</p>
      </div>
      {/* Content */}
    </div>
  );
}
```

### Step 3: Create the API route (if needed)

Create `apps/explorer/src/app/api/<page-name>/route.ts`.

Follow these conventions:

- Import from `@/lib/integrations` or `@/lib/models` (wrappers with cache clearing)
- For CLI subprocess calls, use `spawnBobsledCommand` from `@/lib/dogsled-cli`
- Return `NextResponse.json()` for simple responses
- Return SSE `ReadableStream` for streaming responses
- Handle errors with proper status codes

Example:

```tsx
import { NextResponse } from 'next/server';

export async function GET() {
  try {
    // ... data fetching logic
    return NextResponse.json({ data });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
```

### Step 4: Add to sidebar

Edit `apps/explorer/src/components/layout/sidebar.tsx`:

1. Add entry to `NAV_ITEMS` array (maintain logical ordering):

   ```ts
   { href: '/<page-name>', label: 'Display Name', icon: '<icon-name>' },
   ```

2. Add icon case to `NavIcon` switch:
   ```tsx
   case '<icon-name>':
     return (
       <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
         <path strokeLinecap="round" strokeLinejoin="round" d="..." />
       </svg>
     );
   ```

Use Heroicons (outline style, 24x24 viewBox, strokeWidth 1.5). Pick from: https://heroicons.com

### Step 5: Add to dashboard (optional)

If the page is a primary feature, add it to `apps/explorer/src/app/page.tsx`:

- Add a quick action card in the quick actions section
- Or add to the capabilities overview if it's a core Dogsled capability

### Step 6: Update docs

Add a subsection to `apps/explorer/src/app/docs/page.tsx`:

1. Add to the `toc` array
2. Add a `<SubSection>` with description and feature list

Also update `apps/explorer/README.md` with a section for the new page.

### Step 7: Build and verify

```bash
pnpm --filter @bobsled-inc/explorer build
```

All routes should appear in the build output. Fix any type errors.

## Detail Page Pattern

If the page needs a detail sub-page (e.g., `/connections/[name]`):

1. Create `apps/explorer/src/app/<page-name>/[name]/page.tsx`
2. Use `useParams()` to get the name
3. Add breadcrumb navigation back to list page
4. Create matching API route: `apps/explorer/src/app/api/<page-name>/[name]/route.ts`

## Checklist

- [ ] Page component created with loading/error/empty states
- [ ] API route created (if needed)
- [ ] Sidebar entry added with icon
- [ ] Dashboard link added (if primary feature)
- [ ] Docs page updated
- [ ] README.md updated
- [ ] Build passes
