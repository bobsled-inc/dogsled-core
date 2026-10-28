import { NextResponse } from 'next/server';
import { getIntegration, getResources } from '@/lib/integrations';
import { listModelPackages } from '@/lib/models';

export async function GET(_request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;

  try {
    const integration = getIntegration(name);
    const resources = getResources(name);

    // Check if a model bundle exists for this integration
    const allModels = listModelPackages();
    const modelBundle = allModels.find(
      (m) =>
        m.name === name || m.name === name.replace(/-/g, '_') || m.name === name.replace(/_/g, '-')
    );

    return NextResponse.json({
      ...integration,
      resources: resources.map((r) => r.resource),
      modelBundle: modelBundle
        ? {
            name: modelBundle.name,
            displayName: modelBundle.displayName,
            martCount: modelBundle.martCount,
          }
        : null,
    });
  } catch (error) {
    const message = String(error);
    const isNotFound = /not found/i.test(message);
    return NextResponse.json({ error: message }, { status: isNotFound ? 404 : 500 });
  }
}
