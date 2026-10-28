import { NextResponse } from 'next/server';
import { integrationsBatched, withIntegrationCache } from '@/lib/integrations';
import { modelPackagesBatched, withModelPackageCache } from '@/lib/models';
import { resolveAuthType } from '@/lib/integration-auth';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const search = url.searchParams.get('search');
  const category = url.searchParams.get('category');
  const type = url.searchParams.get('type');

  try {
    const modelBundleNames = await withModelPackageCache(
      () => new Set(modelPackagesBatched.list().map((modelPackage) => modelPackage.name))
    );

    const payload = await withIntegrationCache(() => {
      let results = search ? integrationsBatched.search(search) : integrationsBatched.list();

      if (category && category !== 'all') {
        results = results.filter((i) => i.category === category);
      }
      if (type && type !== 'all') {
        results = results.filter((i) => i.integration_type === type);
      }

      const enriched = results.map((integrationSummary) => {
        const detail = integrationsBatched.get(integrationSummary.name);
        return {
          ...integrationSummary,
          auth_type: resolveAuthType(detail.spec),
          description: detail.spec.description,
          hasModelBundle:
            modelBundleNames.has(integrationSummary.name) ||
            modelBundleNames.has(integrationSummary.name.replace(/-/g, '_')) ||
            modelBundleNames.has(integrationSummary.name.replace(/_/g, '-')),
        };
      });
      const categories = [...new Set(enriched.map((integration) => integration.category))].sort();

      return {
        integrations: enriched,
        categories,
        total: enriched.length,
      };
    });

    return NextResponse.json(payload);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
