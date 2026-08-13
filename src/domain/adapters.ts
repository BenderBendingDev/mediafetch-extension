import type {
  ExperimentalConsent,
  JobProgress,
  MediaCandidate,
  MediaJob,
  OutputArtifact,
  OutputRequest,
  ResolvedSource,
} from "./schemas";

export interface DetectionContext {
  readonly pageUrl: string;
  readonly documentTitle?: string;
  readonly signal: AbortSignal;
}

export interface CandidateDetector {
  readonly id: string;
  detect(context: DetectionContext): Promise<readonly MediaCandidate[]>;
}

export interface ResolveContext {
  readonly signal: AbortSignal;
  readonly consent: ExperimentalConsent;
}

export interface SourceResolver {
  readonly id: string;
  readonly experimental: boolean;
  supports(candidate: MediaCandidate): boolean;
  resolve(
    candidate: MediaCandidate,
    context: ResolveContext,
  ): Promise<readonly ResolvedSource[]>;
}

export interface TransferProgress {
  readonly completedBytes: number;
  readonly totalBytes?: number;
}

export interface TransferResult {
  readonly data: Blob;
  readonly mimeType?: string;
  readonly suggestedFilename?: string;
}

export interface SourceTransfer {
  readonly id: string;
  supports(source: ResolvedSource): boolean;
  transfer(
    source: ResolvedSource,
    options: {
      readonly signal: AbortSignal;
      readonly onProgress: (progress: TransferProgress) => void | Promise<void>;
    },
  ): Promise<TransferResult>;
}

export interface ProcessingInput {
  readonly jobId: string;
  readonly source: TransferResult;
  readonly output: OutputRequest;
}

export interface MediaProcessor {
  readonly id: string;
  supports(input: ProcessingInput): boolean;
  process(
    input: ProcessingInput,
    options: {
      readonly signal: AbortSignal;
      readonly onProgress: (progress: JobProgress) => void | Promise<void>;
    },
  ): Promise<OutputArtifact>;
}

export interface DownloadSaver {
  save(
    data: Blob,
    filename: string,
    options: { readonly signal: AbortSignal },
  ): Promise<OutputArtifact>;
}

export interface Clock {
  now(): number;
}

export interface IdGenerator {
  createId(): string;
}

export interface JobExecutor {
  execute(
    job: MediaJob,
    options: {
      readonly signal: AbortSignal;
      readonly onProgress: (progress: JobProgress) => void | Promise<void>;
    },
  ): Promise<OutputArtifact>;
}

export function assertResolverConsent(
  resolver: Pick<SourceResolver, "experimental">,
  consent: ExperimentalConsent,
): void {
  if (resolver.experimental && !consent.granted) {
    throw new Error("Experimental resolver consent is required");
  }
}
