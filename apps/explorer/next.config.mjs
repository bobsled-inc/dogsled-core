/** @type {import('next').NextConfig} */
const nextConfig = {
  async redirects() {
    return [
      { source: '/ops/data', destination: '/operate/data', permanent: false },
      { source: '/data', destination: '/operate/data', permanent: false },
      { source: '/runs', destination: '/terminal?tab=history', permanent: false },
    ];
  },
  transpilePackages: ['@bobsled-inc/integrations', '@bobsled-inc/models', '@bobsled-inc/protocol'],
  serverExternalPackages: [
    'yaml',
    'tsx',
    '@duckdb/node-api',
    '@duckdb/node-bindings',
    '@bobsled-inc/extractor',
  ],
  // Resolve `.js`/`.mjs` relative imports to their `.ts`/`.tsx`/`.mts` sources.
  // The monorepo uses ESM `.js` extensions (NodeNext); Next.js bundler needs
  // this mapping so those same imports compile here too. See apps/explorer/AGENTS.md.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};

export default nextConfig;
