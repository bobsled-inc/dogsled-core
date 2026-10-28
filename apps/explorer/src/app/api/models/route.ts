import { NextResponse } from 'next/server';
import { listModelPackages } from '@/lib/models';

export async function GET() {
  try {
    const packages = listModelPackages();
    return NextResponse.json({ packages, total: packages.length });
  } catch {
    return NextResponse.json({ error: 'Failed to list model packages' }, { status: 500 });
  }
}
