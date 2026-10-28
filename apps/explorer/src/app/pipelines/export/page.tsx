import { redirect } from 'next/navigation';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function buildQueryString(params: Record<string, string | string[] | undefined>): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') {
      search.set(key, value);
      continue;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        search.append(key, entry);
      }
    }
  }

  const rendered = search.toString();
  return rendered.length > 0 ? `?${rendered}` : '';
}

export default async function LegacyPipelineExportPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  redirect(`/pipelines/new/export${buildQueryString(params)}`);
}
