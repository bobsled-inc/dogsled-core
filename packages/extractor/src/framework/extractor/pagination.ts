import { z } from 'zod';

export const PaginationSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('none'),
    })
    .strict(),
  z
    .object({
      type: z.literal('link_header'),
    })
    .strict(),
  z
    .object({
      type: z.literal('cursor'),
      cursor_path: z.string(),
      cursor_param: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('offset'),
      offset_param: z.string().optional(),
      limit_param: z.string().optional(),
      total_path: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('page_number'),
      page_param: z.string().optional(),
      per_page_param: z.string().optional(),
      total_pages_path: z.string().optional(),
      start_page: z.number().int().nonnegative().default(1).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('next_url'),
      next_url_path: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('mcp_cursor'),
      cursor_path: z.string(),
      cursor_argument: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('mcp_offset'),
      offset_argument: z.string().default('offset'),
      limit_argument: z.string().default('limit'),
      limit_value: z.number().positive().default(100),
      total_path: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('mcp_page_number'),
      page_argument: z.string().default('page'),
      per_page_argument: z.string().default('per_page'),
      per_page_value: z.number().positive().default(25),
      total_pages_path: z.string().optional(),
      start_page: z.number().int().nonnegative().default(1),
    })
    .strict(),
]);

export type PaginationConfig = z.infer<typeof PaginationSchema>;
