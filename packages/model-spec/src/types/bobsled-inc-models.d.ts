declare module '@bobsled-inc/models' {
  export interface ModelSpecFile {
    name: string;
  }

  export interface GeneratedFile {
    path: string;
    content: string;
    kind: 'source' | 'model' | 'metric' | 'relationship';
  }

  export interface ModelPackage {
    name: string;
    displayName: string;
    description: string;
    connection: string;
    tags: string[];
    resourceNames: string[];
    sourceSpecs: ModelSpecFile[];
    stagingSpecs: ModelSpecFile[];
    martSpecs: ModelSpecFile[];
    metricSpecs: ModelSpecFile[];
    relationshipSpecs: ModelSpecFile[];
    files: GeneratedFile[];
  }

  export interface ModelPackageSummary {
    name: string;
    displayName: string;
    description: string;
    tags: string[];
    resourceCount: number;
    stagingCount: number;
    martCount: number;
    metricCount: number;
    relationshipCount: number;
    totalFiles: number;
  }

  export interface InstallModelPackageOptions {
    cwd?: string;
    rawSchema?: string;
    sourceDir?: string;
    modelDir?: string;
    metricDir?: string;
    relationshipDir?: string;
    overwrite?: boolean;
  }

  export interface InstallModelPackageResult {
    packageName: string;
    writtenFiles: string[];
    sourceCount: number;
    stagingCount: number;
    martCount: number;
    metricCount: number;
    relationshipCount: number;
  }

  export function clearModelPackageCache(): void;
  export function getModelPackage(name: string): ModelPackage;
  export function installModelPackage(
    name: string,
    options?: InstallModelPackageOptions
  ): InstallModelPackageResult;
  export function listModelPackages(): ModelPackageSummary[];
}
