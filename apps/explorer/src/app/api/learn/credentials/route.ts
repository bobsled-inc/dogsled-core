import { NextResponse } from 'next/server';
import { getLearnModuleById } from '@/lib/learn-curriculum';

export const dynamic = 'force-dynamic';

interface LearnCredentialsErrorResponse {
  error: string;
  code: 'invalid_request';
}

interface LearnCredentialPresence {
  name: string;
  present: boolean;
}

interface LearnCredentialsSuccessResponse {
  module: string;
  credentials: LearnCredentialPresence[];
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const moduleId = url.searchParams.get('module');

  if (!moduleId) {
    const body: LearnCredentialsErrorResponse = {
      error: 'Missing module parameter',
      code: 'invalid_request',
    };
    return NextResponse.json(body, { status: 400 });
  }

  const module = getLearnModuleById(moduleId);
  if (!module) {
    const body: LearnCredentialsErrorResponse = {
      error: `Unsupported module: ${moduleId}`,
      code: 'invalid_request',
    };
    return NextResponse.json(body, { status: 400 });
  }

  const envVars = module.credentialEnvVars ?? [];
  const body: LearnCredentialsSuccessResponse = {
    module: module.id,
    credentials: envVars.map((name) => ({
      name,
      present: typeof process.env[name] === 'string' && process.env[name] !== '',
    })),
  };
  return NextResponse.json(body);
}
