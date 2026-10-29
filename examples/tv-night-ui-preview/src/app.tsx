import { useEffect, useRef, useState, type ReactElement } from 'react';
import { ActionIcon } from '@dogsled/ui/ActionIcon';
import { Button } from '@dogsled/ui/Button';
import { CodeBlock } from '@dogsled/ui/CodeBlock';
import { Collapsible } from '@dogsled/ui/Collapsible';
import { CopyButton } from '@dogsled/ui/CopyButton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@dogsled/ui/DropdownMenu';
import { EmptyState } from '@dogsled/ui/EmptyState';
import { Input } from '@dogsled/ui/Input';
import { PageHeader } from '@dogsled/ui/PageHeader';
import {
  ResultsTable,
  type ResultsTableColumn,
  type ResultsTableRow,
} from '@dogsled/ui/ResultsTable';
import { useSectionFilter } from '@dogsled/ui/SectionToolbar';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarItem,
  SidebarProvider,
} from '@dogsled/ui/Sidebar';
import { Tag } from '@dogsled/ui/Tag';
import { Tab, TabList, TabPanel, Tabs } from '@dogsled/ui/Tabs';
import { Toolbar } from '@dogsled/ui/Toolbar';
import { TooltipProvider } from '@dogsled/ui/Tooltip';
import { TreeItem, TreeView } from '@dogsled/ui/TreeView';
import { ArrowLeft } from '@dogsled/ui/icons/ArrowLeft';
import { ArrowRight } from '@dogsled/ui/icons/ArrowRight';
import { Dogsled } from '@dogsled/ui/icons/Dogsled';
import { CodeSnippet } from '@dogsled/ui/icons/CodeSnippet';
import { Clear } from '@dogsled/ui/icons/Clear';
import { FailKnockout } from '@dogsled/ui/icons/FailKnockout';
import { ExpandAlt } from '@dogsled/ui/icons/ExpandAlt';
import { Folder } from '@dogsled/ui/icons/Folder';
import { LoadingSpinnerHold } from '@dogsled/ui/icons/LoadingSpinnerHold';
import { MoreVert } from '@dogsled/ui/icons/MoreVert';
import { Pipeline } from '@dogsled/ui/icons/Pipeline';
import { RadioSelected } from '@dogsled/ui/icons/RadioSelected';
import { Row } from '@dogsled/ui/icons/Row';
import { Search } from '@dogsled/ui/icons/Search';
import { SuccessKnockout } from '@dogsled/ui/icons/SuccessKnockout';
import { Table as TableIcon } from '@dogsled/ui/icons/Table';
import { Tick } from '@dogsled/ui/icons/Tick';
import { ThemeMoon } from '@dogsled/ui/icons/ThemeMoon';
import { ThemeSun } from '@dogsled/ui/icons/ThemeSun';
import { LineagePreview } from './lineage';
import { chapterContent } from './chapters';
import type { Chapter, Snapshot, Table } from './contract';

type Inspection = { table: string; row: Table['rows'][number] } | null;

function chapterTitle(chapter: Pick<Chapter, 'id' | 'label'>): string {
  return chapter.id === 'resolve' ? 'Entity resolution (optional)' : chapter.label;
}

function ChapterNavigation({
  snapshot,
  selected,
  reviewed,
  onSelect,
}: {
  snapshot: Snapshot;
  selected: string;
  reviewed: Set<string>;
  onSelect: (id: string) => void;
}): ReactElement {
  const labels: Record<string, string> = {
    connect: 'Connect an API',
    load: 'ETL pipeline',
    model: 'Semantic models',
    query: 'Query the data',
    federate: 'Federated queries',
    transform: 'Agentic transformation',
  };
  return (
    <Sidebar aria-label="Tutorial chapters" collapsible="none" widthMode="fill">
      <SidebarHeader icon={<Dogsled />}>Dogsled</SidebarHeader>
      <SidebarContent>
        <SidebarGroup label="TV Night · Your journey">
          {snapshot.state.steps.map((chapter, index) => {
            const icon =
              selected === chapter.id ? (
                <RadioSelected color="brand" aria-label="Current chapter" />
              ) : reviewed.has(chapter.id) ? (
                <SuccessKnockout color="positive" aria-label="Reviewed" />
              ) : chapter.status === 'failed' ? (
                <FailKnockout color="danger" aria-label="Check failed" />
              ) : (
                <LoadingSpinnerHold color="secondary" aria-label="Not reviewed" />
              );
            return (
              <SidebarItem
                key={chapter.id}
                icon={icon}
                label={labels[chapter.id] ?? chapterTitle(chapter)}
                isActive={selected === chapter.id}
                onClick={() => onSelect(chapter.id)}
                trailing={
                  chapter.id === 'resolve' ? undefined : (
                    <span className="text-caption text-secondary">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                  )
                }
              />
            );
          })}
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}

function DataPreview({
  table,
  tables,
  navigation,
  inspection,
  onInspect,
}: {
  table: Table;
  tables: Table[];
  navigation?: ReactElement;
  inspection: Inspection;
  onInspect: (inspection: Inspection) => void;
}): ReactElement {
  const items = table.rows.map((row, index) => ({
    id: String(row.id ?? index),
    name: String(row.name ?? row.id ?? index),
    type: table.name,
    row,
  }));
  const filter = useSectionFilter(items);
  const searchToggle = useRef<HTMLButtonElement>(null);
  const { setQuery, setSearchOpen, setTypeFilter } = filter;
  useEffect(() => {
    setQuery('');
    setSearchOpen(false);
    setTypeFilter('all');
  }, [table.name, setQuery, setSearchOpen, setTypeFilter]);
  const closeSearch = () => {
    setSearchOpen(false);
    setQuery('');
    requestAnimationFrame(() => searchToggle.current?.focus());
  };
  const labels: Record<string, string> = {
    id: 'ID',
    show_id: 'Show ID',
    name: 'Name',
    runtime: 'Runtime',
    episode_count: 'Episodes',
    genres: 'Genres',
    status: 'Status',
    show: 'Show',
    season: 'Season',
    number: 'Episode',
    source: 'Source',
  };
  const preferred =
    table.name === 'Shows'
      ? ['id', 'name', 'runtime', 'episode_count']
      : table.name === 'Episodes'
        ? ['show_id', 'name', 'number', 'runtime']
        : table.columns;
  const visibleColumns = preferred.filter((key) => table.columns.includes(key));
  const columns: ResultsTableColumn[] = [
    ...visibleColumns.map((key) => ({
      key,
      header: labels[key] ?? key,
      align: ['id', 'show_id', 'runtime', 'episode_count', 'season', 'number'].includes(key)
        ? ('end' as const)
        : ('start' as const),
      minWidth: key === 'name' ? 200 : 96,
    })),
    {
      key: '_inspect',
      header: 'Details',
      sortable: false,
      resizable: false,
      align: 'end',
      minWidth: 64,
    },
  ];
  const rows: ResultsTableRow[] = filter.filtered.map((item) => {
    const original = item.row;
    const inspected = inspection?.table === table.name && inspection.row === original;
    return {
      ...Object.fromEntries(
        table.columns.map((key) => {
          const value =
            original[key] == null
              ? 'Unknown'
              : key === 'runtime'
                ? `${original[key]} min`
                : String(original[key]);
          return [
            key,
            {
              value:
                inspected && key === 'name' ? (
                  <Tag label={value} variant="info" leftIcon={<ExpandAlt />} />
                ) : (
                  value
                ),
              copyValue: value,
              raw: original[key] ?? null,
            },
          ];
        })
      ),
      _inspect: (
        <ActionIcon
          aria-label={`Inspect ${String(original.name ?? original.id ?? table.name)} record`}
          aria-expanded={inspected}
          aria-controls={inspected ? 'record-inspection' : undefined}
          tooltip={inspected ? 'Close record' : 'Inspect record'}
          icon={<ExpandAlt />}
          variant={inspected ? 'branded' : 'default'}
          size="md"
          onClick={() => onInspect(inspected ? null : { table: table.name, row: original })}
        />
      ),
    };
  });
  const content = (
    <div className="results-spacing">
      <ResultsTable
        aria-label={`${table.name} records`}
        columns={columns}
        data={rows}
        variant="body-sm"
        size="compact"
        bordered={false}
        maxHeight={440}
        copyableCells
        stickyHeader
        emptyLabel="No records match your search."
      />
    </div>
  );
  return (
    <section className="result-preview" aria-label={`${table.name} saved preview`}>
      <Toolbar
        aria-label="Result controls"
        leading={
          navigation ?? (
            <div className="result-heading">
              <TableIcon />
              <h3 className="text-heading-sm">{table.name}</h3>
            </div>
          )
        }
        trailing={
          <>
            <span
              className="row-count text-caption text-secondary"
              role="status"
              aria-live="polite"
            >
              <Row size={12} color="secondary" />
              <span aria-hidden="true">
                {filter.filtered.length}/{table.totalRows}
              </span>
              <span className="sr-only">
                {filter.filtered.length} of {table.totalRows} rows
              </span>
            </span>
            <ActionIcon
              ref={searchToggle}
              icon={filter.searchOpen ? <Clear /> : <Search />}
              aria-label={filter.searchOpen ? 'Close search' : `Search ${table.name}`}
              tooltip={filter.searchOpen ? 'Close search' : 'Search'}
              onClick={() => (filter.searchOpen ? closeSearch() : setSearchOpen(true))}
            />
          </>
        }
      />
      {filter.searchOpen ? (
        <div className="result-search">
          <Input
            autoFocus
            size="md"
            leftIcon={<Search />}
            aria-label={`Search ${table.name}`}
            placeholder={`Search ${table.name.toLowerCase()}…`}
            value={filter.query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') closeSearch();
            }}
          />
        </div>
      ) : null}
      {navigation
        ? tables.map((item) => (
            <TabPanel key={item.name} value={item.name}>
              {item.name === table.name ? content : null}
            </TabPanel>
          ))
        : content}
    </section>
  );
}

function FilesPreview({
  snapshot,
  selectedFile,
  onSelect,
  emptyDescription,
}: {
  snapshot: Snapshot;
  selectedFile: string;
  onSelect: (path: string) => void;
  emptyDescription: string;
}): ReactElement {
  const files = snapshot.files ?? [];
  const selected = files.find((file) => file.path === selectedFile) ?? files[0];
  const folders = [...new Set(files.map((file) => file.path.split('/')[0] ?? 'Files'))];
  return files.length ? (
    <div className="file-workspace">
      <div className="file-navigation">
        <TreeView
          aria-label="Working files"
          selected={selected?.path}
          onSelectionChange={(value) => onSelect(Array.isArray(value) ? (value[0] ?? '') : value)}
          defaultExpanded={new Set(folders)}
        >
          {folders.map((folder) => (
            <TreeItem id={folder} key={folder} label={folder} icon={<Folder />} selectable={false}>
              {files
                .filter((file) => file.path.startsWith(`${folder}/`))
                .map((file) => (
                  <TreeItem
                    key={file.path}
                    id={file.path}
                    label={file.path.split('/').slice(1).join('/')}
                    icon={<CodeSnippet />}
                  />
                ))}
            </TreeItem>
          ))}
        </TreeView>
      </div>
      <section className="file-content" aria-label="Selected file">
        <div className="file-heading">
          <span className="text-code">{selected?.path}</span>
          <Tag label="Read only" variant="ghost" />
        </div>
        <pre className="code-preview text-code">
          <code>{selected?.content}</code>
        </pre>
      </section>
    </div>
  ) : (
    <EmptyState
      size="sm"
      icon={<Folder color="secondary" />}
      title="No files for this step yet"
      description={emptyDescription}
    />
  );
}

function MoreMenu({
  theme,
  onThemeChange,
}: {
  theme: 'light' | 'dark';
  onThemeChange: (theme: 'light' | 'dark') => void;
}): ReactElement {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <ActionIcon
          aria-label="More options"
          tooltip="More options"
          icon={<MoreVert />}
          size="md"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={224}>
        <DropdownMenuItem
          leftIcon={theme === 'light' ? <ThemeMoon /> : <ThemeSun />}
          onSelect={() => onThemeChange(theme === 'light' ? 'dark' : 'light')}
        >
          {theme === 'light' ? 'Use dark theme' : 'Use light theme'}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Compare layouts</DropdownMenuLabel>
        <DropdownMenuItem
          leftIcon={<ArrowLeft />}
          onSelect={() => window.location.assign('./comparisons/workspace.html')}
        >
          Previous layout
        </DropdownMenuItem>
        <DropdownMenuItem
          leftIcon={<CodeSnippet />}
          onSelect={() => window.location.assign('./comparisons/original.html')}
        >
          Original tutorial
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TutorialArtifact({ snapshot }: { snapshot: Snapshot }): ReactElement {
  const currentId = snapshot.progress?.current ?? snapshot.state.steps[0]?.id ?? 'connect';
  const [selectedChapter, setSelectedChapter] = useState(currentId);
  const [selectedTable, setSelectedTable] = useState('');
  const [selectedFile, setSelectedFile] = useState(snapshot.files?.[0]?.path ?? '');
  const [inspection, setInspection] = useState<Inspection>(null);
  const [reviewed, setReviewed] = useState(new Set(snapshot.progress?.reviewed ?? []));
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const requestBlock = useRef<HTMLDivElement>(null);
  const app = useRef<HTMLDivElement>(null);
  const actions = useRef<HTMLElement>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [lineageOpen, setLineageOpen] = useState(false);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    const bar = actions.current;
    const root = app.current;
    if (!bar || !root) return;
    const measure = () => {
      const height = bar.getBoundingClientRect().height;
      if (height > 0) root.style.setProperty('--action-bar-height', `${height}px`);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    measure();
    return () => observer.disconnect();
  }, []);
  const chapter =
    snapshot.state.steps.find((item) => item.id === selectedChapter) ?? snapshot.state.steps[0]!;
  const content = chapterContent(snapshot, chapter.id);
  const lesson = content.lesson;
  const index = snapshot.state.steps.findIndex((item) => item.id === chapter.id);
  const previousChapter = snapshot.state.steps[index - 1];
  const nextChapter = snapshot.state.steps[index + 1];
  const chapterTables = chapter.evidence?.tables ?? [];
  const activeTable =
    chapterTables.find((table) => table.name === selectedTable) ?? chapterTables[0];
  const isReviewed = reviewed.has(chapter.id);
  const continueRequest = [
    isReviewed
      ? `I’ve reviewed “${chapterTitle(chapter)}”.`
      : `Help me work through “${chapterTitle(chapter)}”.`,
    isReviewed
      ? nextChapter
        ? `Continue with “${chapterTitle(nextChapter)}”.`
        : 'Recap what I’ve learned and suggest what to explore next.'
      : chapter.status === 'failed'
        ? 'Retry this step and explain the result.'
        : 'Explain this step and walk me through its result before continuing.',
    `Goal: ${isReviewed && nextChapter ? chapterContent(snapshot, nextChapter.id).lesson.outcome : lesson.outcome}`,
    'Use only the synthetic TV Night fixtures. Update the tutorial preview with any new results, then pause for my review.',
  ].join(' ');
  const status =
    chapter.status === 'complete'
      ? isReviewed
        ? 'Reviewed'
        : 'Ready to review'
      : {
          not_started: 'Not started',
          running: 'Working',
          failed: 'Check failed',
          needs_input: 'Needs your input',
          stale: 'Inputs changed',
        }[chapter.status];
  const timestamp = new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/London',
  }).format(new Date(snapshot.renderedAt));
  const shortTime = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/London',
  }).format(new Date(snapshot.renderedAt));
  const chooseChapter = (id: string) => {
    setSelectedChapter(id);
    setSelectedTable('');
    setSelectedFile('');
    setInspection(null);
    setFilesOpen(false);
    setLineageOpen(false);
    window.scrollTo?.({ top: 0, behavior: 'instant' });
  };
  const openFile = (path: string) => {
    setSelectedFile(path);
    setFilesOpen(true);
    requestAnimationFrame(() =>
      document.getElementById('working-files')?.scrollIntoView({ block: 'start' })
    );
  };
  return (
    <TooltipProvider>
      <SidebarProvider open breakpoint={1} keyboardShortcut={null}>
        <div className="artifact-app" ref={app}>
          <div className="journey-rail">
            <ChapterNavigation
              snapshot={snapshot}
              selected={chapter.id}
              reviewed={reviewed}
              onSelect={chooseChapter}
            />
          </div>
          <SidebarInset aria-label="TV Night tutorial workspace">
            <div className="workspace-header">
              <PageHeader
                icon={<Pipeline color="brand" />}
                title="TV Night"
                center={
                  <time
                    className="header-timestamp text-caption text-secondary"
                    dateTime={snapshot.renderedAt}
                    title={`Saved ${timestamp}`}
                  >
                    <span className="header-timestamp-full">Saved {timestamp}</span>
                    <span className="header-timestamp-short">Saved {shortTime}</span>
                  </time>
                }
                trailing={
                  <>
                    <span className="header-demo-label">
                      <Tag label="Dummy data" variant="neutral" />
                    </span>
                    <MoreMenu theme={theme} onThemeChange={setTheme} />
                  </>
                }
              />
            </div>
            <div className="workspace-content">
              <section className="chapter-introduction">
                <div className="chapter-eyebrow">
                  <span className="text-caption text-secondary">
                    {chapter.id === 'resolve' ? 'Optional' : `${index + 1}/6`}
                  </span>
                  <Tag
                    label={status}
                    variant={
                      chapter.status === 'failed' ? 'danger' : isReviewed ? 'positive' : 'neutral'
                    }
                    showDot
                  />
                </div>
                <h1 className="text-heading-lg">{chapterTitle(chapter)}</h1>
                <p className="chapter-summary text-body text-secondary">{lesson.intro}</p>
                <dl
                  className="chapter-meta text-caption text-secondary"
                  aria-label="Chapter context"
                >
                  <div>
                    <dt className="sr-only">Source</dt>
                    <dd>Fictional TV catalog</dd>
                  </div>
                  <div>
                    <dt className="sr-only">Saved result</dt>
                    <dd>
                      {chapterTables.length
                        ? chapterTables
                            .map((table) => `${table.totalRows} ${table.name.toLowerCase()}`)
                            .join(' · ')
                        : 'No saved result yet'}
                    </dd>
                  </div>
                  <div>
                    <dt className="sr-only">Execution</dt>
                    <dd>Offline demo</dd>
                  </div>
                </dl>
              </section>
              <div className="checkout-flow">
                <section className="flow-section" aria-labelledby="understand-heading">
                  <div className="flow-section-heading">
                    <span className="flow-number text-caption" aria-hidden="true">
                      01
                    </span>
                    <h2 id="understand-heading" className="text-heading-md">
                      {chapter.status === 'complete'
                        ? 'Understand what you built'
                        : 'Understand the step'}
                    </h2>
                  </div>
                  <p className="text-body-sm text-secondary">{lesson.learn}</p>
                </section>
                <section className="flow-section" aria-labelledby="results-heading">
                  <div className="flow-section-heading">
                    <span className="flow-number text-caption" aria-hidden="true">
                      02
                    </span>
                    <h2 id="results-heading" className="text-heading-md">
                      Inspect the saved result
                    </h2>
                  </div>
                  <p className="inspection-task text-body-sm text-secondary">
                    {content.inspectionTask}
                  </p>
                  {activeTable ? (
                    chapterTables.length > 1 ? (
                      <Tabs
                        key={chapter.id}
                        theme="header"
                        fill
                        size="md"
                        value={activeTable.name}
                        onValueChange={(value) => {
                          setSelectedTable(value);
                          setInspection(null);
                        }}
                      >
                        <DataPreview
                          table={activeTable}
                          tables={chapterTables}
                          inspection={inspection}
                          onInspect={setInspection}
                          navigation={
                            <TabList aria-label="Saved tables">
                              {chapterTables.map((table) => (
                                <Tab key={table.name} value={table.name} leftIcon={<TableIcon />}>
                                  {table.name}
                                </Tab>
                              ))}
                            </TabList>
                          }
                        />
                      </Tabs>
                    ) : (
                      <DataPreview
                        key={chapter.id}
                        table={activeTable}
                        tables={chapterTables}
                        inspection={inspection}
                        onInspect={setInspection}
                      />
                    )
                  ) : (
                    <div className="empty-results">
                      <EmptyState
                        size="sm"
                        variant="floating"
                        icon={
                          chapter.status === 'failed' ? (
                            <FailKnockout color="danger" />
                          ) : (
                            <TableIcon color="secondary" />
                          )
                        }
                        title={chapter.status === 'failed' ? 'Load failed' : 'No results yet'}
                        description={
                          chapter.status === 'failed'
                            ? 'This demo simulates a source timeout. Your connection result is preserved.'
                            : `You’ll create: ${lesson.outcome}`
                        }
                        actions={
                          chapter.id !== currentId ? (
                            <Button
                              variant="outline"
                              size="sm"
                              leftIcon={<ArrowLeft />}
                              onClick={() => chooseChapter(currentId)}
                            >
                              Return to current chapter
                            </Button>
                          ) : undefined
                        }
                      />
                    </div>
                  )}
                  {inspection ? (
                    <section
                      id="record-inspection"
                      className="record-inspection"
                      aria-label="Record inspection"
                    >
                      <div className="pane-heading">
                        <div>
                          <span className="text-caption text-secondary">
                            {inspection.table} · Saved preview
                          </span>
                          <h3 className="text-body-semibold">
                            {String(inspection.row.name ?? inspection.row.id)}
                          </h3>
                        </div>
                        <ActionIcon
                          aria-label="Close record inspection"
                          tooltip="Close"
                          icon={<Clear />}
                          size="md"
                          onClick={() => setInspection(null)}
                        />
                      </div>
                      <dl className="record-fields">
                        {Object.entries(inspection.row).map(([key, value]) => (
                          <div key={key}>
                            <dt className="text-caption text-secondary">
                              {key.replaceAll('_', ' ')}
                            </dt>
                            <dd className="text-body-sm">
                              {value == null ? 'Unknown' : String(value)}
                            </dd>
                          </div>
                        ))}
                      </dl>
                      {inspection.row.runtime == null ? (
                        <p className="text-body-sm text-secondary">
                          An unknown runtime stays missing; it does not become zero.
                        </p>
                      ) : null}
                    </section>
                  ) : null}
                </section>
                <section className="flow-section" aria-labelledby="definitions-heading">
                  <div className="flow-section-heading">
                    <span className="flow-number text-caption" aria-hidden="true">
                      03
                    </span>
                    <h2 id="definitions-heading" className="text-heading-md">
                      Connect the files to the result
                    </h2>
                  </div>
                  <p className="text-body-sm text-secondary">{lesson.definitions}</p>
                  <div className="definitions-stack">
                    <div id="working-files" className="definition-disclosure">
                      <Collapsible
                        title={`Working files · ${content.snapshot.files?.length ?? 0} definitions`}
                        chevronPosition="right"
                        open={filesOpen}
                        onOpenChange={setFilesOpen}
                      >
                        <FilesPreview
                          key={chapter.id}
                          snapshot={content.snapshot}
                          selectedFile={selectedFile}
                          onSelect={setSelectedFile}
                          emptyDescription={lesson.definitions}
                        />
                      </Collapsible>
                    </div>
                    <div className="definition-disclosure">
                      <Collapsible
                        title="Model lineage"
                        chevronPosition="right"
                        open={lineageOpen}
                        onOpenChange={setLineageOpen}
                      >
                        <LineagePreview
                          key={chapter.id}
                          snapshot={content.snapshot}
                          onFile={openFile}
                          emptyDescription={lesson.outcome}
                        />
                      </Collapsible>
                    </div>
                    {chapter.evidence ? (
                      <div className="definition-disclosure">
                        <Collapsible title="Saved execution evidence" chevronPosition="right">
                          <ul className="receipt-list text-body-sm text-secondary">
                            {chapter.evidence.receipts.map((receipt) => (
                              <li key={receipt}>{receipt}</li>
                            ))}
                          </ul>
                        </Collapsible>
                      </div>
                    ) : null}
                  </div>
                </section>
                <section className="flow-section" aria-labelledby="review-heading">
                  <div className="flow-section-heading">
                    <span className="flow-number text-caption" aria-hidden="true">
                      04
                    </span>
                    <h2 id="review-heading" className="text-heading-md">
                      Ready to move on?
                    </h2>
                  </div>
                  <p className="text-body-sm text-secondary">
                    {chapter.status === 'complete'
                      ? 'Check that you understand the files and can trace one record to the result, then mark this step as reviewed.'
                      : 'Work through this step with your agent to create its result.'}
                  </p>
                  <div className="agent-handoff">
                    <h3 id="agent-handoff-heading" className="text-heading-sm">
                      Share this with your agent
                    </h3>
                    <CodeBlock
                      ref={requestBlock}
                      role="region"
                      aria-labelledby="agent-handoff-heading"
                      tabIndex={-1}
                      type="multi"
                      language="text"
                      actions={
                        <CopyButton
                          key={`${chapter.id}:${isReviewed}`}
                          text={continueRequest}
                          size="lg"
                          copyLabel="Copy request"
                          copiedLabel="Request copied"
                          onCopyFail={() => {
                            const block = requestBlock.current;
                            if (block) {
                              block.focus();
                              const range = document.createRange();
                              range.selectNodeContents(block.querySelector('code') ?? block);
                              const selection = window.getSelection();
                              selection?.removeAllRanges();
                              selection?.addRange(range);
                            }
                          }}
                        />
                      }
                    >
                      <code className="agent-request-text">{continueRequest}</code>
                    </CodeBlock>
                  </div>
                  <p className="text-caption text-secondary">
                    Review status applies to this preview only.
                  </p>
                </section>
              </div>
            </div>
            <nav className="checkout-actions" ref={actions} aria-label="Chapter actions">
              {previousChapter ? (
                <Button
                  variant="secondary"
                  size="md"
                  leftIcon={<ArrowLeft />}
                  onClick={() => chooseChapter(previousChapter.id)}
                >
                  Previous
                </Button>
              ) : null}
              <div className="action-buttons">
                <Button
                  variant="outline"
                  size="md"
                  disabled={chapter.status !== 'complete' || isReviewed}
                  leftIcon={isReviewed ? <Tick /> : undefined}
                  onClick={() => setReviewed(new Set([...reviewed, chapter.id]))}
                >
                  {isReviewed ? 'Reviewed' : 'Mark as reviewed'}
                </Button>
                {nextChapter ? (
                  <Button
                    variant="primary"
                    size="md"
                    rightIcon={<ArrowRight />}
                    onClick={() => chooseChapter(nextChapter.id)}
                  >
                    Next step
                  </Button>
                ) : null}
              </div>
            </nav>
          </SidebarInset>
        </div>
      </SidebarProvider>
    </TooltipProvider>
  );
}
