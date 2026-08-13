import { z } from "zod";
import { HttpUrlSchema, NonEmptyIdSchema } from "../domain/schemas";

export const PAGE_BRIDGE_CHANNEL = "mediafetch.page-snapshot" as const;
export const PAGE_BRIDGE_VERSION = 1 as const;

export const SafeExposedUrlSchema = z
  .string()
  .trim()
  .max(4_096)
  .pipe(HttpUrlSchema)
  .refine((value) => {
    const url = new URL(value);
    return url.username.length === 0 && url.password.length === 0;
  }, "URLs containing credentials are not accepted");

export const DetectedResourceSchema = z
  .object({
    url: SafeExposedUrlSchema,
    source: z.enum(["media", "source", "performance", "json-ld", "link"]),
    kind: z.enum(["audio", "video"]).optional(),
    mimeType: z.string().trim().min(1).max(200).optional(),
    title: z.string().trim().min(1).max(500).optional(),
    durationMs: z.number().int().nonnegative().max(86_400_000).optional(),
    thumbnailUrl: SafeExposedUrlSchema.optional(),
  })
  .strict();
export type DetectedResource = z.infer<typeof DetectedResourceSchema>;

export const PageSnapshotSchema = z
  .object({
    pageUrl: SafeExposedUrlSchema,
    title: z.string().trim().max(500),
    resources: z.array(DetectedResourceSchema).max(500),
  })
  .strict();
export type PageSnapshot = z.infer<typeof PageSnapshotSchema>;

export const PageBridgeRequestSchema = z
  .object({
    channel: z.literal(PAGE_BRIDGE_CHANNEL),
    version: z.literal(PAGE_BRIDGE_VERSION),
    direction: z.literal("content-to-page"),
    requestId: NonEmptyIdSchema,
    kind: z.literal("snapshot.request"),
  })
  .strict();
export type PageBridgeRequest = z.infer<typeof PageBridgeRequestSchema>;

export const PageBridgeResponseSchema = z
  .object({
    channel: z.literal(PAGE_BRIDGE_CHANNEL),
    version: z.literal(PAGE_BRIDGE_VERSION),
    direction: z.literal("page-to-content"),
    requestId: NonEmptyIdSchema,
    kind: z.literal("snapshot.result"),
    payload: PageSnapshotSchema,
  })
  .strict();
export type PageBridgeResponse = z.infer<typeof PageBridgeResponseSchema>;

export function parsePageBridgeResponse(value: unknown): PageBridgeResponse {
  return PageBridgeResponseSchema.parse(value);
}

export const SnapshotItemSchema = z
  .object({
    id: NonEmptyIdSchema,
    url: SafeExposedUrlSchema,
    title: z.string().trim().min(1).max(500).optional(),
    kind: z.enum(["audio", "video"]).optional(),
    mimeType: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type SnapshotItem = z.infer<typeof SnapshotItemSchema>;

export const PaginationSnapshotSchema = z
  .object({
    pageUrl: SafeExposedUrlSchema,
    items: z.array(SnapshotItemSchema).max(100),
    nextPageUrl: SafeExposedUrlSchema.optional(),
  })
  .strict();
export type PaginationSnapshot = z.infer<typeof PaginationSnapshotSchema>;

export const CollectionInputSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("url"),
      url: SafeExposedUrlSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("list"),
      id: NonEmptyIdSchema,
      snapshots: z.array(PaginationSnapshotSchema).min(1).max(20),
    })
    .strict(),
  z
    .object({
      type: z.literal("channel"),
      id: NonEmptyIdSchema,
      snapshots: z.array(PaginationSnapshotSchema).min(1).max(20),
    })
    .strict(),
]);
export type CollectionInput = z.infer<typeof CollectionInputSchema>;

export interface PaginationLimits {
  readonly maxPages: number;
  readonly maxItems: number;
}

export interface ParsedSnapshotCollection {
  readonly items: readonly SnapshotItem[];
  readonly visitedPages: readonly string[];
  readonly truncated: boolean;
}

const DEFAULT_PAGINATION_LIMITS: PaginationLimits = {
  maxPages: 5,
  maxItems: 200,
};

export function parseSnapshotCollection(
  input: unknown,
  limits: Partial<PaginationLimits> = {},
): ParsedSnapshotCollection {
  const parsed = CollectionInputSchema.parse(input);
  if (parsed.type === "url") {
    return {
      items: [{ id: stableReferenceId(parsed.url), url: parsed.url }],
      visitedPages: [],
      truncated: false,
    };
  }

  const maxPages = boundedLimit(
    limits.maxPages,
    DEFAULT_PAGINATION_LIMITS.maxPages,
    1,
    20,
  );
  const maxItems = boundedLimit(
    limits.maxItems,
    DEFAULT_PAGINATION_LIMITS.maxItems,
    1,
    1_000,
  );
  const byPageUrl = new Map(
    parsed.snapshots.map((snapshot) => [snapshot.pageUrl, snapshot]),
  );
  const visitedPages: string[] = [];
  const items: SnapshotItem[] = [];
  const itemIds = new Set<string>();
  let current: PaginationSnapshot | undefined = parsed.snapshots[0];

  while (
    current !== undefined &&
    visitedPages.length < maxPages &&
    items.length < maxItems &&
    !visitedPages.includes(current.pageUrl)
  ) {
    visitedPages.push(current.pageUrl);
    for (const item of current.items) {
      if (!itemIds.has(item.id)) {
        itemIds.add(item.id);
        items.push(item);
      }
      if (items.length === maxItems) {
        break;
      }
    }
    current =
      current.nextPageUrl === undefined
        ? undefined
        : byPageUrl.get(current.nextPageUrl);
  }

  const hasMore =
    current !== undefined ||
    parsed.snapshots.some(
      (snapshot) => !visitedPages.includes(snapshot.pageUrl),
    );
  return { items, visitedPages, truncated: hasMore };
}

function boundedLimit(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || !Number.isInteger(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

function stableReferenceId(value: string): string {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return `url-${(hash >>> 0).toString(36)}`;
}
