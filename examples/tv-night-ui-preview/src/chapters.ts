import type { Snapshot } from './contract';

interface Lesson {
  intro: string;
  learn: string;
  inspect: string;
  outcome: string;
  definitions: string;
  paths: string[];
  prefixes: string[];
}

const lessons: Record<string, Lesson> = {
  connect: {
    intro: 'Connect a source and understand its response before choosing what to load.',
    learn:
      'A connection describes where records come from. Check one response for the identifiers and fields you will need later.',
    inspect:
      'Find a show identifier and title in the response. These fields will connect the records you load next.',
    outcome: 'A checked catalog response with a show identifier and title.',
    definitions: 'Inspect the catalog connection and compare it with the saved response.',
    paths: ['integrations/dummy-catalog.yml'],
    prefixes: [],
  },
  load: {
    intro: 'Extract shows and episodes from the catalog, then load them into local tables.',
    learn:
      'ETL means extract, transform, and load. Shows has one row per series; Episodes has one row per episode. A shared show ID connects them.',
    inspect:
      'Open a show, then find its episodes using show_id. An unknown runtime should stay unknown.',
    outcome: 'Shows and Episodes tables joined by the show identifier.',
    definitions: 'Follow the catalog through the pipeline to the Shows and Episodes definitions.',
    paths: [
      'integrations/dummy-catalog.yml',
      'pipelines/tv-night.yml',
      'sources/shows.yml',
      'sources/episodes.yml',
    ],
    prefixes: [],
  },
  model: {
    intro: 'Give the catalog meaning with descriptions, relationships, and reusable rules.',
    learn:
      'Source models describe existing records. Derived models save the rules for turning those records into a result you can reuse.',
    inspect:
      'Trace a derived field to its rule, then check how the Shows and Episodes definitions describe their shared identifier.',
    outcome:
      'A reusable watchlist model with documented fields and a relationship between Shows and Episodes.',
    definitions:
      'Start with the saved source definitions. Derived model files appear here when your agent creates them.',
    paths: ['sources/shows.yml', 'sources/episodes.yml'],
    prefixes: ['models/'],
  },
  query: {
    intro: 'Ask what to watch next and inspect the rules behind the answer.',
    learn:
      'A query answers a question now. A saved model makes useful selection rules available to later queries.',
    inspect:
      'Choose one recommendation and check which genre or runtime rule included it. Compare its values with the source record.',
    outcome: 'A saved recommendation query and results that can be traced to the catalog.',
    definitions:
      'Compare the show definition with saved models and query files. Queries appear here after this step runs.',
    paths: ['sources/shows.yml'],
    prefixes: ['models/', 'queries/'],
  },
  federate: {
    intro: 'Bring article context and local catalog facts into the same query.',
    learn:
      'Federation joins records across sources. A source receipt explains where each remote record came from.',
    inspect:
      'Pick one result and separate its catalog fields from its article fields. Check the source receipt for the article.',
    outcome: 'A combined result with catalog fields, article context, and source receipts.',
    definitions:
      'Use Shows as the local input. Article and federation definitions appear here when they are saved.',
    paths: ['sources/shows.yml'],
    prefixes: ['integrations/articles', 'sources/articles', 'models/federat', 'queries/federat'],
  },
  transform: {
    intro: 'Turn article passages into structured assessments with traceable evidence.',
    learn:
      'An agentic model specifies its inputs, instructions, and output fields. Inspect a small pilot before processing more shows.',
    inspect:
      'Follow an assessment’s passage reference to its saved text. Check whether that passage supports the assessment.',
    outcome: 'A pilot assessment with structured fields and a reference to its supporting passage.',
    definitions:
      'Review saved passage inputs and assessment definitions. This step’s files appear after they are created.',
    paths: [],
    prefixes: [
      'sources/articles',
      'sources/passages',
      'models/assessment',
      'models/transform',
      'transformations/',
    ],
  },
  resolve: {
    intro: 'Link records that refer to the same show, even when their names differ.',
    learn:
      'Entity resolution combines identifiers and matching rules. Keep ambiguous candidates available for review.',
    inspect:
      'Compare a proposed match’s identifier and title with Shows. Leave uncertain candidates unresolved.',
    outcome: 'A reviewed set of show matches with ambiguous candidates kept separate.',
    definitions:
      'Use Shows as the reference. Matching rules and candidate definitions appear here when saved.',
    paths: ['sources/shows.yml'],
    prefixes: ['sources/aliases', 'models/match', 'entities/', 'resolutions/'],
  },
};

export function chapterContent(
  snapshot: Snapshot,
  id: string
): { lesson: Lesson; snapshot: Snapshot; inspectionTask: string } {
  const lesson = lessons[id] ?? lessons.connect!;
  const files = (snapshot.files ?? []).filter(
    (file) =>
      lesson.paths.includes(file.path) ||
      lesson.prefixes.some((prefix) => file.path.startsWith(prefix))
  );
  const paths = new Set(files.map((file) => file.path));
  const nodes = (snapshot.lineage?.nodes ?? []).filter((node) => paths.has(node.id));
  const ids = new Set(nodes.map((node) => node.id));
  const edges = (snapshot.lineage?.edges ?? []).filter(
    (edge) => ids.has(edge.from) && ids.has(edge.to)
  );
  const tables = snapshot.state.steps.find((chapter) => chapter.id === id)?.evidence?.tables ?? [];
  let inspectionTask = lesson.inspect;
  if (id === 'connect') {
    const row = tables[0]?.rows[0];
    if (row?.name != null && row.id != null)
      inspectionTask = `Find ${row.name} in the response and confirm its identifier is ${row.id}. This is the key you will carry into the local tables.`;
  }
  if (id === 'load') {
    const shows = tables.find((table) => table.name === 'Shows');
    const first = shows?.rows[0];
    const unknown = shows?.rows.find((row) => row.runtime == null);
    if (first?.id != null && first.name != null)
      inspectionTask = `Open ${first.name} (ID ${first.id}), then find its episodes using show_id ${first.id}.${unknown?.name ? ` Check that ${unknown.name} keeps its unknown runtime.` : ''}`;
  }
  return { lesson, inspectionTask, snapshot: { ...snapshot, files, lineage: { nodes, edges } } };
}
