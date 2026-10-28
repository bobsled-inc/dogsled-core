import { NextResponse } from 'next/server';
import { spawnDogsledCommand, collectOutput } from '@/lib/dogsled-cli';

export async function GET() {
  try {
    const child = spawnDogsledCommand('setup', ['describe', '--json']);
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
