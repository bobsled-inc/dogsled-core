import { NextResponse } from 'next/server';
import { spawnBobsledCommand, collectOutput } from '@/lib/dogsled-cli';

export async function POST(request: Request) {
  const body = (await request.json()) as { goal?: string };
  const { goal } = body;

  if (!goal || typeof goal !== 'string') {
    return NextResponse.json({ error: 'goal is required' }, { status: 400 });
  }
  if (goal.length > 1_000) {
    return NextResponse.json({ error: 'goal too long (max 1,000 chars)' }, { status: 400 });
  }

  try {
    const child = spawnBobsledCommand('setup', ['recommend', '--goal', goal, '--json']);
    const { stdout, stderr, code } = await collectOutput(child);

    if (code !== 0) {
      return NextResponse.json(
        { error: stderr || `Process exited with code ${code}` },
        { status: 500 }
      );
    }

    try {
      const data = JSON.parse(stdout);
      return NextResponse.json(data);
    } catch {
      return NextResponse.json({ raw: stdout }, { status: 500 });
    }
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
