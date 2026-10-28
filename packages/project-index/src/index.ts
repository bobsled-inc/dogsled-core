export { classifyProjectFile } from './classify.js';
export {
  documentName,
  duplicateIdentityIssues,
  entryFilePath,
  findNamedEntry,
  resourceIntegration,
} from './identity.js';
export {
  FRONT_MATTER_PATTERN,
  normalizeDocumentText,
  splitFrontMatter,
  stripByteOrderMark,
  type FrontMatterSplit,
} from './front-matter.js';
export {
  classifySourceDocument,
  HOST_PROJECT_FILE_KINDS,
  isDogsledFileType,
  MARKDOWN_PROJECT_FILE_TYPES,
  PROJECT_FILE_KINDS,
  SINGLETON_PROJECT_FILE_KINDS,
  YAML_PROJECT_FILE_TYPES,
  type ProjectFileKind,
  type SingletonProjectFileKind,
  type SourceDocumentKind,
} from './kinds.js';
export {
  compareProjectPaths,
  conventionalProjectFileKind,
  conventionalSkillPackageDirectory,
  IGNORED_DIRECTORY_NAMES,
  isIgnoredProjectPath,
  isInConventionalObjectFolder,
  isProjectDocumentCandidate,
  markdownMayDeclareType,
  PROJECT_GUIDE_PATH,
  projectFileFormat,
  projectPathProblem,
  type ProjectFileFormat,
} from './paths.js';
export {
  assertCompleteProjectIndex,
  assertValidProjectIndex,
  buildProjectIndex,
  DEFAULT_MAX_PROJECT_FILE_BYTES,
  DEFAULT_MAX_PROJECT_FILES,
  DEFAULT_MAX_PROJECT_TOTAL_BYTES,
  entriesOfKind,
  configuredObjectFolders,
  configuredResourcesFolder,
  formatProjectIndexIssues,
  indexProjectFiles,
  isBlockingProjectIndexIssue,
  ProjectIndexError,
  singleEntryOfKind,
  type IndexProjectFilesOptions,
} from './project-index.js';
export {
  DEFAULT_MAX_PROJECT_DEPTH,
  DEFAULT_MAX_PROJECT_ENTRIES,
  findConfigurationEntry,
  resolveProjectIndex,
  scanProject,
  type ScanProjectOptions,
} from './scan.js';
export {
  PROJECT_INDEX_ISSUE_CODES,
  type ProjectFileClassification,
  type ProjectFileInput,
  type ProjectIndex,
  type ProjectIndexEntry,
  type ProjectIndexDeprecation,
  type ProjectIndexIssue,
  type ProjectIndexIssueCode,
  type UnrecognizedProjectFile,
} from './types.js';
