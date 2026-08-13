import {
  assertResolverConsent,
  type ResolveContext,
  type SourceResolver,
} from "../domain/adapters";
import type {
  ExperimentalConsent,
  MediaCandidate,
  ResolvedSource,
} from "../domain/schemas";
import {
  GenericSourceResolver,
  TikTokExperimentalResolver,
  VimeoSourceResolver,
  YouTubeExperimentalResolver,
} from "./resolvers";

export class SourceResolverRegistry {
  readonly #resolvers = new Map<string, SourceResolver>();

  constructor(resolvers: readonly SourceResolver[]) {
    for (const resolver of resolvers) {
      if (this.#resolvers.has(resolver.id)) {
        throw new Error(`Duplicate source resolver: ${resolver.id}`);
      }
      this.#resolvers.set(resolver.id, resolver);
    }
  }

  get(id: string): SourceResolver | undefined {
    return this.#resolvers.get(id);
  }

  supporting(
    candidate: MediaCandidate,
    consent: ExperimentalConsent,
  ): readonly SourceResolver[] {
    return [...this.#resolvers.values()].filter(
      (resolver) =>
        resolver.supports(candidate) &&
        (!resolver.experimental || consent.granted),
    );
  }

  async resolve(
    candidate: MediaCandidate,
    context: ResolveContext,
  ): Promise<readonly ResolvedSource[]> {
    const sources: ResolvedSource[] = [];
    for (const resolver of this.#resolvers.values()) {
      if (!resolver.supports(candidate)) {
        continue;
      }
      assertResolverConsent(resolver, context.consent);
      sources.push(...(await resolver.resolve(candidate, context)));
    }
    return [...new Map(sources.map((source) => [source.url, source])).values()];
  }
}

export function createDefaultResolverRegistry(): SourceResolverRegistry {
  return new SourceResolverRegistry([
    new GenericSourceResolver(),
    new VimeoSourceResolver(),
    new YouTubeExperimentalResolver(),
    new TikTokExperimentalResolver(),
  ]);
}
