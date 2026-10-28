import type { SupportedDialect } from '@bobsled-inc/model-spec';
import { CommandError } from '@bobsled-inc/protocol';

import type { QueryableRunner } from '../../api/extract-project-utils.js';
import type { ResolvedResolutionSpec } from '../../compiler/identity/types.js';
import {
  assignMatch,
  getEntity,
  getRelationshipsForEntities,
  listEntities,
  lookupMatch,
  specSearchConfig,
  stageMatch,
  type MatchLookupResult,
  type MatchMutationResult,
} from '../services/index.js';

export interface EntityFindRequest<TFilter extends object> {
  entity: string;
  filter: TFilter;
  includes: {
    documents: boolean;
    relationships: string[];
  };
  limit?: number;
  cursor?: string;
}

export interface EntityFindResult<TProfile, TDocument = unknown> {
  profile: TProfile;
  documents: TDocument[];
  relationships: Record<string, unknown[]>;
}

export interface EntityGetRequest {
  entity: string;
  id: string;
}

export interface EntityMatchRequest<TRecord extends object = Record<string, unknown>> {
  entity: string;
  record: TRecord;
  mode?: 'lookup' | 'assign' | 'stage';
}

export interface WarehouseExecutorOptions {
  runner: QueryableRunner;
  schema: string;
  dialect?: SupportedDialect;
  specs?: readonly ResolvedResolutionSpec[];
}

export function createWarehouseExecutor(options: WarehouseExecutorOptions) {
  const dialect = options.dialect ?? 'duckdb';
  const readContext = { runner: options.runner, schema: options.schema, dialect };
  const specByEntity = new Map((options.specs ?? []).map((spec) => [spec.entity, spec]));

  return {
    async find<TProfile, TFilter extends object, TDocument = unknown>(
      request: EntityFindRequest<TFilter>
    ): Promise<Array<EntityFindResult<TProfile, TDocument>>> {
      // The warehouse executor has no document surface yet. Fail loudly rather
      // than returning documents: [] for a requested include, which would look
      // like a successful fetch that silently dropped the data.
      if (request.includes.documents) {
        throw new CommandError(
          'createWarehouseExecutor does not support document includes; request relationships only.',
          2
        );
      }
      const spec = specByEntity.get(request.entity);
      const result = await listEntities(readContext, {
        entity: request.entity,
        filters: request.filter as Record<string, unknown>,
        limit: request.limit,
        cursor: request.cursor,
        ...(spec ? { search: specSearchConfig(spec) } : {}),
      });
      const entityIds = result.entities.map((entity) => entity.entity_id);
      const relationshipsByRelation = await Promise.all(
        request.includes.relationships.map(
          async (relation) =>
            [
              relation,
              await getRelationshipsForEntities(readContext, {
                entity: request.entity,
                entityIds,
                relation,
              }),
            ] as const
        )
      );
      return result.entities.map((entity) => ({
        profile: entity.profile as TProfile,
        documents: [] as TDocument[],
        relationships: Object.fromEntries(
          relationshipsByRelation.map(([relation, byEntity]) => [
            relation,
            byEntity.get(entity.entity_id) ?? [],
          ])
        ),
      }));
    },

    async get<TProfile>(request: EntityGetRequest): Promise<TProfile | null> {
      const entity = await getEntity(readContext, { entity: request.entity, entityId: request.id });
      return entity ? (entity.profile as TProfile) : null;
    },

    async match<TRecord extends object>(
      request: EntityMatchRequest<TRecord>
    ): Promise<MatchLookupResult | MatchMutationResult | null> {
      const spec = specByEntity.get(request.entity);
      if (!spec) {
        throw new CommandError(
          `Executor match requires specs and no spec was supplied for entity '${request.entity}'.`,
          2
        );
      }
      const context = { ...readContext, spec };
      const record = request.record as Record<string, unknown>;
      if (request.mode === 'assign') return assignMatch(context, record);
      if (request.mode === 'stage') return stageMatch(context, record);
      return lookupMatch(context, record);
    },
  };
}
