import { NextResponse } from 'next/server';
import { getModelPackage } from '@/lib/models';
import { listIntegrations } from '@/lib/integrations';

export async function GET(_request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;

  try {
    const pkg = getModelPackage(name);

    // Check if a matching integration exists
    const allIntegrations = listIntegrations();
    const integration = allIntegrations.find(
      (i) =>
        i.name === name || i.name === name.replace(/-/g, '_') || i.name === name.replace(/_/g, '-')
    );

    return NextResponse.json({
      ...pkg,
      integration: integration
        ? {
            name: integration.name,
            displayName: integration.display_name,
            resourceCount: integration.resource_count,
          }
        : null,
    });
  } catch (error) {
    const message = String(error);
    const isNotFound = /not found/i.test(message);
    return NextResponse.json(
      { error: isNotFound ? message : 'Failed to load model package' },
      { status: isNotFound ? 404 : 500 }
    );
  }
}
