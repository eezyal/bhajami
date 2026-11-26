export interface PitchInfo {
  raw: string;
  pancham: string;
  western: string;
  semitoneFromC: number;
}

export type BhajanMetadataSource =
  | 'sairhythms_verified'
  | 'sssmediacentre_verified'
  | 'local_inferred'
  | 'community_contributed'
  | 'youtube_prasanthi_mandir_live'
  | 'youtube_sss_bhajans'
  | 'admin_curated';

export type RecordingCollection =
  | 'sssmediacentre_bhajan_a_day'
  | 'ravi_mp3'
  | 'sairhythms_ref'
  | 'community_upload'
  | 'youtube_prasanthi_mandir_live'
  | 'youtube_sss_bhajans'
  | 'youtube_volume_chapter';

export interface RecordingSource {
  id: string;
  label: string;
  collection: RecordingCollection;
  localPath?: string;
  externalUrl?: string;
  fileSizeBytes?: number;
  youtubeVideoId?: string;
  startSec?: number;
  endSec?: number;
  embeddable?: boolean;
  channelId?: string;
  durationSec?: number;
  matchScore?: number;
  matchMethod?: string;
  lastVerifiedAt?: string;
  isDefault?: boolean;
}

export type LyricsScriptKind =
  | 'roman'
  | 'devanagari'
  | 'telugu'
  | 'tamil'
  | 'kannada'
  | 'malayalam'
  | 'bengali'
  | 'gujarati'
  | 'odia'
  | 'gurmukhi'
  | 'arabic'
  | 'cyrillic'
  | 'cjk'
  | 'other';

export interface LyricsSet {
  language: string;
  script: LyricsScriptKind;
  lines: string[];
}

export interface GlossaryEntry {
  term: string;
  description: string;
}

export interface RagaInfo {
  name: string;
  arohanam?: string;
  avarohanam?: string;
  westernInC?: string;
}

export type MissingFieldKey =
  | 'lyrics'
  | 'meaning'
  | 'gentsPitch'
  | 'ladiesPitch'
  | 'raga'
  | 'beat'
  | 'tempo'
  | 'notation'
  | 'alternateScripts';

export interface MatchCandidate {
  targetBhajanId: string;
  targetTitle: string;
  score: number;
  reason: string;
}

export type MatchStatus = 'verified' | 'needs_verification' | 'unmatched';

export interface Bhajan {
  id: string;
  slug: string;
  title: string;
  deity?: string | null;
  language?: string | null;
  raga?: RagaInfo | null;
  beat?: string | null;
  tala?: string | null;
  tempo?: string | null;
  level?: string | null;
  gentsPitch?: PitchInfo | null;
  ladiesPitch?: PitchInfo | null;
  gentsPitchRaw?: string | null;
  ladiesPitchRaw?: string | null;
  firstLineNotes?: {
    sargam?: string;
    westernInC?: string;
  } | null;
  notesRange?: string | null;
  meaning?: string | null;
  lyricsSets: LyricsSet[];
  glossary: GlossaryEntry[];
  recordings: RecordingSource[];
  addedRecordings?: RecordingSource[];
  defaultRecordingId?: string | null;
  sheetMusicUrl?: string | null;
  sourceUrl?: string | null;
  metadataSource: BhajanMetadataSource;
  isEstimated?: boolean;
  lyricsMissing?: boolean;
  matchStatus?: MatchStatus;
  matchCandidates?: MatchCandidate[];
  missingFields?: MissingFieldKey[];
  slugAliases?: string[];
  bhajamiOverride?: boolean;
  bhajamiNewBhajan?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface CatalogStats {
  totalBhajans: number;
  verifiedSaiRhythmsCount: number;
  totalLocalRecordings: number;
  bhajanDownloaderCount: number;
  raviMp3Count: number;
  youtubeVideosCount?: number;
  missingLyricsCount?: number;
  needsVerificationCount?: number;
}

export interface CatalogPayload {
  generatedAt: string;
  stats: CatalogStats;
  bhajans: Bhajan[];
}

export interface BhajanIndexEntry {
  id: string;
  slug: string;
  title: string;
  deity?: string;
  language?: string;
  ragaName?: string;
  beat?: string;
  gentsPitchRaw?: string;
  ladiesPitchRaw?: string;
  /** Up to 240 chars of normalized title + deity + raga + first 2 lines */
  searchText: string;
  phoneticTokens: string[];
  lyricsMissing: boolean;
  matchStatus: MatchStatus;
  missingFields: MissingFieldKey[];
  recordingCount: number;
  hasDirectAudio?: boolean;
  metadataSource: BhajanMetadataSource;
  slugAliases?: string[];
  updatedAt?: string;
}

export interface CatalogIndexPayload {
  generatedAt: string;
  version: number;
  stats: CatalogStats;
  entries: BhajanIndexEntry[];
}

export interface CatalogMetaDoc {
  version: number;
  totalBhajans: number;
  indexHash: string;
  shardIds: string[];
  stats: CatalogStats;
  updatedAt: string;
}

export interface CatalogIndexShardDoc {
  shardId: string;
  version: number;
  count: number;
  entries: BhajanIndexEntry[];
}

export interface EntityAliasDoc {
  id: string;
  variantTitle: string;
  canonicalPhrase: string;
  targetBhajanId: string;
  source: 'admin_merge' | 'sairhythms_var' | 'seed';
  createdAt: string;
  approvedBy?: string | null;
}

export interface DoNotMergePairDoc {
  id: string;
  entityA: string;
  entityB: string;
  createdBy: string;
  createdAt: string;
  note?: string | null;
}

export interface YouTubeChapterSegment {
  title: string;
  startSec: number;
  endSec: number;
}

export interface YouTubeVideoProvenanceDoc {
  videoId: string;
  channelId: string;
  playlistId?: string | null;
  rawTitle: string;
  rawDescription: string;
  cleanedTitle: string;
  durationSec: number;
  publishedAt: string;
  classification: 'single' | 'volume' | 'ambiguous_long';
  embeddable: boolean;
  chapters?: YouTubeChapterSegment[] | null;
  linkedBhajanIds: string[];
  excluded?: boolean | null;
  exclusionReason?: string | null;
  lastVerifiedAt: string;
  ingestedAt: string;
}

export interface SyncStateDoc {
  source: 'sairhythms' | 'youtube_mandir_live' | 'youtube_sss_bhajans';
  lastRunAt: string;
  lastPublishedAt?: string | null;
  watermarkToken?: string | null;
  itemsIndexedCount: number;
  livenessCursorIdx?: number | null;
}

export interface IngestionRunDoc {
  runId: string;
  source: string;
  startedAt: string;
  finishedAt: string;
  status: 'success' | 'partial' | 'failed';
  itemsScanned: number;
  matchedAuto: number;
  queuedDoubt: number;
  createdNew: number;
  skippedDuplicate: number;
  parseErrors: number;
  youtubeQuotaUnitsUsed: number;
  firestoreWrites: number;
  errorMessage?: string | null;
}

export type SubmissionType =
  | 'lyric_correction'
  | 'alternate_lyrics'
  | 'new_bhajan'
  | 'metadata_addition';

export type ModerationStatus =
  | 'pending'
  | 'info_requested'
  | 'approved'
  | 'rejected';

export interface AudioSubmissionInfo {
  url: string;
  label: string;
  mimeType?: string;
  durationSec?: number;
  sourceKind?: 'uploaded_file' | 'external_url';
}

export interface ProposedMetadataPatch {
  title?: string;
  language?: string;
  meaning?: string;
  deity?: string;
  beat?: string;
  tala?: string;
  tempo?: string | number;
  gentsPitchRaw?: string;
  ladiesPitchRaw?: string;
  pitch?: string;
  raga?: string;
  ragaName?: string;
  arohanam?: string;
  avarohanam?: string;
  firstLineSargam?: string;
  firstLineWestern?: string;
  notesRange?: string;
  sheetMusicUrl?: string;
  category?: string;
  notes?: string;
}

export interface LyricCorrection {
  id: string;
  bhajanId: string;
  bhajanTitle: string;
  submissionType: SubmissionType;
  script: string;
  alternateScriptKind?: string;
  originalLyrics: string[];
  proposedLyrics: string[];
  proposedMetadata?: ProposedMetadataPatch;
  audioSubmission?: AudioSubmissionInfo | null;
  reasonOrSource: string;
  submitterName: string;
  submitterEmail: string;
  submitterUid?: string | null;
  status: ModerationStatus;
  createdAt: string;
  reviewedAt?: string | null;
  reviewedBy?: string | null;
  reviewNote?: string | null;
  infoRequestedAt?: string | null;
  infoRequestNote?: string | null;
  contributorReply?: string | null;
  contributorRepliedAt?: string | null;
  emailNotification?: {
    to: string;
    transport: string;
    sentAt: string;
    subject: string;
  };
}

export interface BhajanRevision {
  id: string;
  bhajanId: string;
  correctionId: string;
  previousLyrics: string[];
  newLyrics: string[];
  script: string;
  contributorName: string;
  approvedBy: string;
  approvedAt: string;
}

export interface OutboxEmailRecord {
  id: string;
  correctionId: string;
  to: string;
  subject: string;
  textBody: string;
  htmlBody: string;
  transport: string;
  createdAt: string;
}

export interface DuplicateClearanceLogEntry {
  id: string;
  decision: 'merged' | 'kept_distinct';
  sourceBhajanId: string;
  sourceTitle: string;
  targetBhajanId: string;
  targetTitle: string;
  candidateScore?: number | null;
  candidateReason?: string | null;
  defaultRecordingId?: string | null;
  combinedRecordingCount?: number | null;
  adminNote?: string | null;
  reviewerEmail: string;
  decidedAt: string;
  storageSource?: 'local_jsonl' | 'firestore_do_not_merge' | 'firestore_entity_alias';
}
