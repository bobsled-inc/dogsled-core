import { z } from 'zod';

import { identifierMsg, identifierRegex } from '@bobsled-inc/model-spec/shared';

const objectNameSchema = z
  .string()
  .trim()
  .min(1, 'Object name is required')
  .regex(identifierRegex, identifierMsg);

export const ObjectLinkDirectionSchema = z.enum(['inbound', 'outbound', 'bidirectional']);
export type ObjectLinkDirection = z.infer<typeof ObjectLinkDirectionSchema>;

export const ObjectActionRefSchema = z
  .object({
    action_ref: z.string().trim().min(1, 'actions[].action_ref is required'),
    label: z.string().trim().optional(),
  })
  .strict();

export const ObjectSpecSchema = z
  .object({
    spec_version: z.literal('1'),
    type: z.literal('object'),
    name: objectNameSchema,
    identity: z
      .object({
        resolution_ref: z.string().trim().min(1, 'identity.resolution_ref is required'),
      })
      .strict(),
    links: z
      .array(
        z
          .object({
            relation_ref: z.string().trim().min(1, 'links[].relation_ref is required'),
            direction: ObjectLinkDirectionSchema,
          })
          .strict()
      )
      .default(() => []),
    actions: z.array(ObjectActionRefSchema).default(() => []),
  })
  .strict();

export type ObjectActionRef = z.infer<typeof ObjectActionRefSchema>;

export type ObjectSpec = z.infer<typeof ObjectSpecSchema>;
