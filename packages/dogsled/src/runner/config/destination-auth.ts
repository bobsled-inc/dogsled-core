import type { DogsledConfig } from './schema.js';

export function validateDatabricksDestinationAuth(
  destinations: DogsledConfig['destinations']
): Array<{ path: string; message: string }> {
  const issues: Array<{ path: string; message: string }> = [];
  for (const [name, destination] of Object.entries(destinations)) {
    if (destination.type !== 'databricks') continue;
    const pat = destination.credentials_access_token !== undefined;
    const oauthId = destination.oauth_client_id !== undefined;
    const oauthSecret = destination.oauth_client_secret !== undefined;
    if (pat === (oauthId && oauthSecret) || oauthId !== oauthSecret) {
      issues.push({
        path: `dogsled.yml:destinations.${name}`,
        message: 'Databricks destination requires exactly one PAT or OAuth M2M credential mode',
      });
    }
  }
  return issues;
}
