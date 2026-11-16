import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const connections = vi.hoisted(() => ({
  localStateTakeoverRoot: vi.fn<(start: string) => string | undefined>(),
  prepareLocalStateDir: vi.fn(async (_root: string, _options: unknown) => ''),
}));
vi.mock('@bobsled-inc/connections', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...connections,
}));

const { takeOverLocalState } = await import('../../../src/runtime/local-state-takeover.js');

// The takeover itself is tested in @bobsled-inc/connections; this is where the CLI points it.
let root: string;
const write = (relative: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), text);
};
const referencedBy = () => {
  const options = connections.prepareLocalStateDir.mock.calls[0]![1] as {
    referencedBy: (folder: string) => string[];
  };
  return options.referencedBy('.legacy');
};

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'takeover-cli-')));
  write('project/dogsled.yml', 'pipelines: {}\n');
  write('project/sub/keep.txt', '');
  vi.clearAllMocks();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('where the CLI takes over a local state folder', () => {
  it('does nothing without an earlier folder', async () => {
    connections.localStateTakeoverRoot.mockReturnValue(undefined);
    await takeOverLocalState([]);
    expect(connections.prepareLocalStateDir).not.toHaveBeenCalled();
  });

  it('never acts on the home folder unless it is itself a Project', async () => {
    connections.localStateTakeoverRoot.mockReturnValue(os.homedir());
    await takeOverLocalState(['--project-root', path.join(root, 'project')]);
    expect(connections.prepareLocalStateDir).not.toHaveBeenCalled();
  });

  it('never acts on a folder above the Project root the command resolves', async () => {
    connections.localStateTakeoverRoot.mockReturnValue(root);
    await takeOverLocalState([`--project-root=${path.join(root, 'project')}`]);
    expect(connections.prepareLocalStateDir).not.toHaveBeenCalled();
  });

  it('takes over at the Project root, from a subfolder, with either --project-root form', async () => {
    const project = path.join(root, 'project');
    connections.localStateTakeoverRoot.mockReturnValue(project);
    await takeOverLocalState([`--project-root=${path.join(project, 'sub')}`]);
    await takeOverLocalState(['--project-root', project]);
    expect(connections.prepareLocalStateDir.mock.calls.map(([dir]) => dir)).toEqual([
      project,
      project,
    ]);
  });

  it('lists project files and the command line that name the folder in a path', async () => {
    const project = path.join(root, 'project');
    write(
      'project/integrations/warehouse.yml',
      'type: integration\nname: warehouse\nsource_type: duckdb\nconnection:\n  path: .legacy/w.duckdb\n'
    );
    write(
      'project/integrations/other.yml',
      'type: integration\nname: other\nsource_type: duckdb\n# path: .legacy/old.duckdb\nconnection:\n  path: data/o.duckdb\n'
    );
    connections.localStateTakeoverRoot.mockReturnValue(project);
    await takeOverLocalState(['--project-root', project]);
    expect(referencedBy()).toEqual([path.join('integrations', 'warehouse.yml')]);
    vi.clearAllMocks();
    await takeOverLocalState(['query', '--project-root', project, '--db-path', '.legacy/x.duckdb']);
    expect(referencedBy()).toEqual([path.join('integrations', 'warehouse.yml'), 'this command']);
  });
});
