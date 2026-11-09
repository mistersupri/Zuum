-- Full-text search on transcript text (PRD 4.10, 8.1). 'simple' config: PostgreSQL ships no Indonesian stemmer.
CREATE INDEX "TranscriptSegment_text_fts_idx" ON "TranscriptSegment"
  USING GIN (to_tsvector('simple', coalesce("correctedText", "originalText")));
CREATE INDEX "Meeting_title_trgm_fallback_idx" ON "Meeting" (lower("title"));
