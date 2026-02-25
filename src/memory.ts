import fs from "node:fs/promises";
import path from "node:path";

const DAILY_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.md$/;
const LORE_SUBJECT = "__lore__";
const FACT_TYPE_LABELS = {
  preference: "Preference",
  profile: "Profile",
  relationship: "Relationship",
  project: "Project"
};
const ALLOWED_FACT_TYPES = new Set(["preference", "profile", "relationship", "project", "other", "general"]);
const MAX_FACTS_PER_MESSAGE = 4;
const HYBRID_FACT_LIMIT = 10;
const HYBRID_CANDIDATE_MULTIPLIER = 6;
const HYBRID_MAX_CANDIDATES = 90;
const HYBRID_MAX_VECTOR_BACKFILL_PER_QUERY = 8;
const SUBJECT_LORE = LORE_SUBJECT;

export class MemoryManager {
  constructor({ store, llm, memoryFilePath }) {
    this.store = store;
    this.llm = llm;
    this.memoryFilePath = memoryFilePath;
    this.memoryDirPath = path.dirname(memoryFilePath);
    this.pendingWrite = false;
    this.initializedDailyFiles = new Set();
  }

  async ingestMessage({ messageId, authorId, authorName, content, settings, trace = {} }) {
    const cleanedContent = cleanDailyEntryContent(content);
    if (!cleanedContent) return;

    let wroteDailyEntry = false;
    try {
      await this.appendDailyLogEntry({
        messageId,
        authorId,
        authorName,
        content: cleanedContent
      });
      wroteDailyEntry = true;
    } catch (error) {
      this.logMemoryError("daily_log_write", error, { messageId, userId: authorId });
    }

    let insertedAnyFact = false;
    if (cleanedContent.length >= 4) {
      let extracted = [];
      try {
        extracted = await this.llm.extractMemoryFacts({
          settings,
          authorName,
          messageContent: cleanedContent,
          maxFacts: MAX_FACTS_PER_MESSAGE,
          trace
        });
      } catch (error) {
        this.logMemoryError("fact_extraction", error, { messageId, userId: authorId });
      }

      for (const row of extracted) {
        const factText = normalizeStoredFactText(row?.fact);
        if (!factText) continue;
        if (isInstructionLikeFactText(factText)) continue;
        if (!isTextGroundedInSource(factText, cleanedContent)) continue;

        const evidenceText = normalizeEvidenceText(row?.evidence, cleanedContent);
        const inserted = this.store.addMemoryFact({
          subject: authorId,
          fact: factText,
          factType: normalizeFactType(row?.type),
          evidenceText,
          sourceMessageId: messageId,
          confidence: clamp01(row?.confidence, 0.5)
        });

        if (!inserted) continue;
        insertedAnyFact = true;
        this.store.logAction({
          kind: "memory_fact",
          userId: authorId,
          messageId,
          content: factText
        });

        const factRow = this.store.getMemoryFactBySubjectAndFact(authorId, factText);
        if (factRow) {
          this.ensureFactVector({
            factRow,
            settings,
            trace: {
              ...trace,
              source: "memory_fact_ingest"
            }
          }).catch(() => undefined);
        }
      }
    }

    if (wroteDailyEntry || insertedAnyFact) {
      await this.queueMemoryRefresh();
    }
  }

  async buildPromptMemorySlice({ userId, channelId, queryText, settings, trace = {} }) {
    const userFacts = await this.selectHybridFacts({
      subjects: [userId],
      queryText,
      settings,
      trace,
      limit: 8
    });
    const relevantFacts = await this.selectHybridFacts({
      subjects: [userId, SUBJECT_LORE],
      queryText,
      settings,
      trace,
      limit: HYBRID_FACT_LIMIT
    });
    const relevantMessages = this.store.searchRelevantMessages(channelId, queryText, 8);

    return {
      userFacts,
      relevantFacts,
      relevantMessages
    };
  }

  async selectHybridFacts({ subjects, queryText, settings, trace = {}, limit = HYBRID_FACT_LIMIT }) {
    const normalizedSubjects = [...new Set((subjects || []).map((value) => String(value || "").trim()).filter(Boolean))];
    if (!normalizedSubjects.length) return [];

    const boundedLimit = clampInt(limit, 1, 24);
    const candidateLimit = Math.min(
      HYBRID_MAX_CANDIDATES,
      Math.max(boundedLimit * HYBRID_CANDIDATE_MULTIPLIER, boundedLimit)
    );
    const candidates = this.store.getFactsForSubjects(normalizedSubjects, candidateLimit);
    if (!candidates.length) return [];

    const query = String(queryText || "").trim();
    const queryTokens = extractStableTokens(query, 32);
    const queryCompact = normalizeHighlightText(query);
    const semanticScores = await this.getSemanticScoreMap({ candidates, queryText: query, settings, trace });
    const semanticAvailable = semanticScores.size > 0;

    const scored = candidates.map((row) => {
      const lexicalScore = computeLexicalFactScore(row, { queryTokens, queryCompact });
      const semanticScore = semanticScores.get(Number(row.id)) || 0;
      const recencyScore = computeRecencyScore(row.created_at);
      const confidenceScore = clamp01(row.confidence, 0.5);
      const combined = semanticAvailable
        ? 0.48 * semanticScore + 0.32 * lexicalScore + 0.12 * confidenceScore + 0.08 * recencyScore
        : 0.68 * lexicalScore + 0.2 * confidenceScore + 0.12 * recencyScore;

      return {
        ...row,
        _score: Number(combined.toFixed(6)),
        _semanticScore: Number(semanticScore.toFixed(6)),
        _lexicalScore: Number(lexicalScore.toFixed(6))
      };
    });

    const sorted = scored.sort((a, b) => {
      if (b._score !== a._score) return b._score - a._score;
      return Date.parse(b.created_at || "") - Date.parse(a.created_at || "");
    });

    const filtered = queryTokens.length || semanticAvailable
      ? sorted.filter((row) => row._score >= (semanticAvailable ? 0.16 : 0.08))
      : sorted;

    const selected = (filtered.length ? filtered : sorted).slice(0, boundedLimit);
    return selected.map((row) => ({
      id: row.id,
      created_at: row.created_at,
      subject: row.subject,
      fact: row.fact,
      fact_type: row.fact_type,
      evidence_text: row.evidence_text,
      source_message_id: row.source_message_id,
      confidence: row.confidence,
      score: row._score,
      semanticScore: row._semanticScore,
      lexicalScore: row._lexicalScore
    }));
  }

  async getSemanticScoreMap({ candidates, queryText, settings, trace = {} }) {
    if (!this.llm?.isEmbeddingReady?.()) return new Map();

    const query = String(queryText || "").trim();
    if (query.length < 3) return new Map();

    let queryEmbeddingResult = null;
    try {
      queryEmbeddingResult = await this.llm.embedText({
        settings,
        text: query,
        trace: {
          ...trace,
          source: "memory_query"
        }
      });
    } catch {
      return new Map();
    }

    const queryEmbedding = Array.isArray(queryEmbeddingResult?.embedding)
      ? queryEmbeddingResult.embedding
      : [];
    const model = String(queryEmbeddingResult?.model || "").trim();
    if (!queryEmbedding.length || !model) return new Map();

    const factIds = candidates
      .map((row) => Number(row.id))
      .filter((value) => Number.isInteger(value) && value > 0);
    if (!factIds.length) return new Map();

    const vectorRows = this.store.getMemoryFactVectors(factIds, model);
    const vectorMap = new Map(
      vectorRows.map((row) => [Number(row.fact_id), row.embedding.map((value) => Number(value))])
    );

    let backfilled = 0;
    for (const row of candidates) {
      const factId = Number(row.id);
      if (!Number.isInteger(factId) || factId <= 0) continue;
      if (vectorMap.has(factId)) continue;
      if (backfilled >= HYBRID_MAX_VECTOR_BACKFILL_PER_QUERY) break;

      const embedding = await this.ensureFactVector({
        factRow: row,
        model,
        settings,
        trace: {
          ...trace,
          source: "memory_fact"
        }
      });
      if (embedding?.length) {
        backfilled += 1;
        vectorMap.set(factId, embedding);
      }
    }

    const scoreMap = new Map();
    for (const row of candidates) {
      const factId = Number(row.id);
      const embedding = vectorMap.get(factId);
      if (!embedding?.length) continue;
      const cosine = cosineSimilarity(queryEmbedding, embedding);
      if (Number.isFinite(cosine) && cosine > 0) {
        scoreMap.set(factId, cosine);
      }
    }

    return scoreMap;
  }

  async ensureFactVector({ factRow, model = "", settings, trace = {} }) {
    const factId = Number(factRow?.id);
    if (!Number.isInteger(factId) || factId <= 0) return null;

    const resolvedModel = String(model || this.llm?.resolveEmbeddingModel?.(settings) || "").trim();
    if (!resolvedModel) return null;

    const existing = this.store.getMemoryFactVectors([factId], resolvedModel);
    if (existing.length) {
      const parsed = existing[0].embedding.map((value) => Number(value));
      return parsed.length ? parsed : null;
    }

    try {
      const payload = buildFactEmbeddingPayload(factRow);
      if (!payload) return null;
      const embedded = await this.llm.embedText({
        settings,
        text: payload,
        trace
      });
      const vector = Array.isArray(embedded?.embedding)
        ? embedded.embedding.map((value) => Number(value))
        : [];
      if (!vector.length) return null;

      this.store.upsertMemoryFactVector({
        factId,
        model: embedded.model || resolvedModel,
        embedding: vector
      });
      return vector;
    } catch {
      return null;
    }
  }

  async queueMemoryRefresh() {
    if (this.pendingWrite) return;
    this.pendingWrite = true;

    setTimeout(async () => {
      try {
        await this.refreshMemoryMarkdown();
      } catch (error) {
        this.logMemoryError("curation_refresh", error);
      } finally {
        this.pendingWrite = false;
      }
    }, 1000);
  }

  async refreshMemoryMarkdown() {
    const peopleSection = this.buildPeopleSection();
    const recentDailyEntries = await this.getRecentDailyEntries({ days: 3, maxEntries: 120 });
    const highlightsSection = buildHighlightsSection(recentDailyEntries, 24);
    const loreSection = this.buildLoreSection(6);
    const dailyFiles = await this.getRecentDailyFiles(5);
    const dailyFilesLine = dailyFiles.length
      ? dailyFiles.map((filePath) => `memory/${path.basename(filePath)}`).join(", ")
      : "(No daily files yet.)";

    const markdown = [
      "# Clanker Conk Memory",
      "",
      "## Identity",
      "- Name: clanker conk",
      "- Role: chat-native server bot with playful Gen Z/Gen A flavor.",
      "- Hard limitations:",
      "  - Cannot join voice chat.",
      "  - Cannot play non-text games.",
      "  - Cannot perform real-world actions.",
      "",
      "## Memory Workflow",
      "- Daily logs grow append-only in `memory/YYYY-MM-DD.md`.",
      "- This file is a curated snapshot distilled from durable facts + recent daily logs.",
      `- Recent daily files: ${dailyFilesLine}`,
      "",
      "## People (Durable Facts)",
      ...(peopleSection.length ? peopleSection : ["- (No stable people facts yet.)"]),
      "",
      "## Ongoing Lore",
      ...(loreSection.length ? loreSection : ["- (No durable lore lines yet.)"]),
      "",
      "## Recent Journal Highlights",
      ...(highlightsSection.length ? highlightsSection : ["- (No recent highlights yet.)"])
    ].join("\n");

    await fs.mkdir(this.memoryDirPath, { recursive: true });
    await fs.writeFile(this.memoryFilePath, markdown, "utf8");
  }

  async readMemoryMarkdown() {
    try {
      return await fs.readFile(this.memoryFilePath, "utf8");
    } catch {
      return "# Memory\n\n(no memory file yet)";
    }
  }

  buildPeopleSection() {
    const subjects = this.store.getMemorySubjects(80);
    const peopleLines = [];

    for (const subjectRow of subjects) {
      if (subjectRow.subject === LORE_SUBJECT) continue;
      const rows = this.store.getFactsForSubject(subjectRow.subject, 6);
      const cleaned = [
        ...new Set(
          rows
            .map((row) => formatTypedFactForMemory(row.fact, row.fact_type))
            .filter(Boolean)
        )
      ].slice(0, 6);
      if (!cleaned.length) continue;
      peopleLines.push(`- ${subjectRow.subject}: ${cleaned.join(" | ")}`);
    }

    return peopleLines;
  }

  buildLoreSection(maxItems = 6) {
    const durableLoreLines = [
      ...new Set(
        this.store
          .getFactsForSubject(LORE_SUBJECT, 12)
          .map((row) => normalizeLoreFactForDisplay(row.fact))
          .filter(Boolean)
      )
    ].map((fact) => `- ${fact}`);
    return durableLoreLines.slice(0, Math.max(1, maxItems));
  }

  async rememberLine({ line, sourceMessageId, userId, sourceText = "" }) {
    const cleaned = normalizeMemoryLineInput(line);
    if (!cleaned) return false;
    if (isInstructionLikeFactText(cleaned)) return false;
    if (!isTextGroundedInSource(cleaned, sourceText)) return false;

    const factText = `Memory line: ${cleaned}.`;
    const inserted = this.store.addMemoryFact({
      subject: LORE_SUBJECT,
      fact: factText,
      factType: "lore",
      evidenceText: normalizeEvidenceText(sourceText, sourceText),
      sourceMessageId,
      confidence: 0.72
    });

    if (!inserted) return false;

    this.store.logAction({
      kind: "memory_fact",
      userId,
      messageId: sourceMessageId,
      content: factText
    });
    const factRow = this.store.getMemoryFactBySubjectAndFact(LORE_SUBJECT, factText);
    if (factRow) {
      this.ensureFactVector({
        factRow,
        settings: null,
        trace: {
          userId,
          source: "memory_lore_ingest"
        }
      }).catch(() => undefined);
    }
    await this.queueMemoryRefresh();
    return true;
  }

  async appendDailyLogEntry({ authorId, authorName, content }) {
    const now = new Date();
    const dateKey = formatDateLocal(now);
    const dailyFilePath = path.join(this.memoryDirPath, `${dateKey}.md`);
    const safeAuthorName = sanitizeInline(authorName || "unknown", 80);
    const safeAuthorId = sanitizeInline(authorId || "unknown", 40);
    const line = `- ${now.toISOString()} | ${safeAuthorName} (${safeAuthorId}) | ${content}`;

    await fs.mkdir(this.memoryDirPath, { recursive: true });
    await this.ensureDailyLogHeader(dailyFilePath, dateKey);
    await fs.appendFile(dailyFilePath, `${line}\n`, "utf8");
  }

  async ensureDailyLogHeader(dailyFilePath, dateKey) {
    if (this.initializedDailyFiles.has(dailyFilePath)) return;

    try {
      await fs.access(dailyFilePath);
    } catch {
      const header = [
        `# Daily Memory Log ${dateKey}`,
        "",
        "- Append-only chat journal used to distill `memory/MEMORY.md`.",
        "",
        "## Entries",
        ""
      ].join("\n");

      try {
        await fs.writeFile(dailyFilePath, header, { encoding: "utf8", flag: "wx" });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }

    this.initializedDailyFiles.add(dailyFilePath);
  }

  async getRecentDailyFiles(limit = 5) {
    try {
      const entries = await fs.readdir(this.memoryDirPath);
      return entries
        .filter((name) => DAILY_FILE_PATTERN.test(name))
        .sort()
        .reverse()
        .slice(0, Math.max(1, limit))
        .map((name) => path.join(this.memoryDirPath, name));
    } catch {
      return [];
    }
  }

  async getRecentDailyEntries({ days = 3, maxEntries = 120 } = {}) {
    const files = await this.getRecentDailyFiles(days);
    const entries = [];

    for (const filePath of files) {
      let text = "";
      try {
        text = await fs.readFile(filePath, "utf8");
      } catch {
        continue;
      }

      for (const line of text.split("\n")) {
        const parsed = parseDailyEntryLine(line);
        if (parsed) entries.push(parsed);
      }
    }

    entries.sort((a, b) => b.timestampMs - a.timestampMs);
    return entries.slice(0, Math.max(1, maxEntries));
  }

  logMemoryError(scope, error, metadata = null) {
    try {
      this.store.logAction({
        kind: "bot_error",
        content: `memory_${scope}: ${String(error?.message || error)}`,
        metadata
      });
    } catch {
      // Avoid cascading failures while handling memory errors.
    }
  }
}

function normalizeStoredFactText(rawFact) {
  const compact = String(rawFact || "")
    .replace(/\s+/g, " ")
    .trim();
  if (compact.length < 4) return "";
  if (!/[.!?]$/.test(compact)) return `${compact}.`.slice(0, 190);
  return compact.slice(0, 190);
}

function normalizeFactType(rawType) {
  const normalized = String(rawType || "")
    .trim()
    .toLowerCase();
  if (!ALLOWED_FACT_TYPES.has(normalized)) return "other";
  if (normalized === "general") return "other";
  return normalized;
}

function normalizeEvidenceText(rawEvidence, sourceText) {
  const evidence = sanitizeInline(rawEvidence || "", 220);
  if (!evidence) return null;
  return isTextGroundedInSource(evidence, sourceText) ? evidence : null;
}

function clamp01(value, fallback = 0.5) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed <= 0) return 0;
  if (parsed >= 1) return 1;
  return parsed;
}

function clampInt(value, min, max) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return min;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

function buildFactEmbeddingPayload(factRow) {
  const fact = sanitizeInline(factRow?.fact || "", 220);
  const evidence = sanitizeInline(factRow?.evidence_text || "", 180);
  const factType = sanitizeInline(factRow?.fact_type || "", 40);
  if (!fact) return "";

  const parts = [];
  if (factType) parts.push(`type: ${factType}`);
  parts.push(`fact: ${fact}`);
  if (evidence) parts.push(`evidence: ${evidence}`);
  return parts.join("\n");
}

function computeLexicalFactScore(row, { queryTokens, queryCompact }) {
  const factCompact = normalizeHighlightText(row?.fact || "");
  const evidenceCompact = normalizeHighlightText(row?.evidence_text || "");
  const combinedCompact = `${factCompact} ${evidenceCompact}`.trim();
  if (!combinedCompact) return 0;

  if (queryCompact && combinedCompact.includes(queryCompact)) return 1;
  if (!queryTokens?.length) return 0;

  const factTokens = new Set(extractStableTokens(combinedCompact, 96));
  const overlap = queryTokens.filter((token) => factTokens.has(token));
  if (!overlap.length) return 0;

  return Math.min(1, overlap.length / Math.max(1, queryTokens.length));
}

function computeRecencyScore(createdAtIso) {
  const timestamp = Date.parse(String(createdAtIso || ""));
  if (!Number.isFinite(timestamp)) return 0;
  const ageMs = Math.max(0, Date.now() - timestamp);
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  return 1 / (1 + ageDays / 45);
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) return 0;
  const dims = Math.min(a.length, b.length);
  if (!dims) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < dims; i += 1) {
    const av = Number(a[i]) || 0;
    const bv = Number(b[i]) || 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }

  if (normA <= 0 || normB <= 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function cleanFactForMemory(rawFact) {
  let text = String(rawFact || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";

  text = text
    .replace(/\s+\b(?:bro|lol|lmao|lmfao|fr|ngl)\b[\s\S]*$/i, ".")
    .replace(/\s+\b(?:and|but|because)\b[\s\S]*$/i, ".");

  text = text.replace(/\s+/g, " ").trim();
  if (!/[.!?]$/.test(text)) text += ".";

  return text.slice(0, 190);
}

function formatTypedFactForMemory(rawFact, rawType) {
  const fact = cleanFactForMemory(rawFact);
  if (!fact) return "";

  const type = String(rawType || "")
    .trim()
    .toLowerCase();
  const label = FACT_TYPE_LABELS[type];
  return label ? `${label}: ${fact}` : fact;
}

function buildHighlightsSection(entries, maxItems = 24) {
  const byAuthorCount = new Map();
  const seen = new Set();
  const items = [];

  for (const entry of entries) {
    if (items.length >= maxItems) break;

    const author = String(entry.author || "").trim();
    const text = String(entry.text || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 220);
    if (!author || !text) continue;
    if (text.length < 8) continue;
    if (/^https?:\/\/\S+$/i.test(text)) continue;

    const normalized = normalizeHighlightText(text);
    if (!normalized || seen.has(normalized)) continue;

    const authorCount = byAuthorCount.get(author) || 0;
    if (authorCount >= 8) continue;

    byAuthorCount.set(author, authorCount + 1);
    seen.add(normalized);
    items.push(`- ${author}: ${text}`);
  }

  return items;
}

function normalizeHighlightText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/<a?:[^:>]+:\d+>/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDailyEntryLine(line) {
  if (!String(line).startsWith("- ")) return null;
  const payload = line.slice(2).trim();
  const parts = payload.split(" | ");
  if (parts.length < 3) return null;

  const [timestampIso, authorPart, ...textParts] = parts;
  const text = textParts.join(" | ").trim();
  const author = authorPart.replace(/\s*\([^)]+\)\s*$/, "").trim();
  if (!timestampIso || !author || !text) return null;

  const timestampMs = Date.parse(timestampIso);
  return {
    timestampIso,
    timestampMs: Number.isFinite(timestampMs) ? timestampMs : 0,
    author,
    text
  };
}

function normalizeLoreFactForDisplay(rawFact) {
  let text = String(rawFact || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";

  text = text
    .replace(/^alias mapping:\s*/i, "memory line: ")
    .replace(/^important tidbit:\s*/i, "memory line: ");

  if (!/^memory line:\s*/i.test(text)) {
    text = `Memory line: ${text}`;
  }

  return cleanFactForMemory(text);
}

function normalizeMemoryLineInput(input) {
  let text = String(input || "")
    .replace(/\s+/g, " ")
    .replace(/\|/g, "/")
    .trim();
  if (!text) return "";

  text = text
    .replace(/^(?:remember(?: this)?|important|note this|dont forget|don't forget|keep in mind|fyi)\b[\s:,-]*/i, "")
    .replace(/^(?:memory line|remember line)\s*:\s*/i, "")
    .replace(/^that\s+/i, "")
    .replace(/[.!?]+$/g, "")
    .trim();

  if (text.length < 4) return "";
  return text.slice(0, 180);
}

function isInstructionLikeFactText(line) {
  const text = String(line || "").toLowerCase();
  if (!text) return true;
  if (/\[\[[\s\S]*\]\]/.test(text)) return true;
  if (/(?:system|developer|prompt|instruction|policy|jailbreak|override)/.test(text)) return true;
  if (/(?:ignore|disregard|bypass)\s+(?:previous|prior|earlier)/.test(text)) return true;
  if (/(?:always|never)\s+(?:reply|respond|say|output)/.test(text)) return true;
  if (/(?:api key|token|password|credential|secret)/.test(text)) return true;
  return false;
}

function isTextGroundedInSource(memoryLine, sourceText) {
  const sourceTokens = extractStableTokens(sourceText, 64);
  if (!sourceTokens.length) return false;

  const memoryTokens = extractStableTokens(memoryLine, 32);
  if (!memoryTokens.length) return false;

  const sourceSet = new Set(sourceTokens);
  const overlap = memoryTokens.filter((token) => sourceSet.has(token));
  if (overlap.length >= 1) return true;

  const sourceCompact = normalizeHighlightText(sourceText);
  const memoryCompact = normalizeHighlightText(memoryLine);
  if (!sourceCompact || !memoryCompact) return false;
  if (sourceCompact.includes(memoryCompact)) return true;

  return false;
}

function extractStableTokens(text, maxTokens = 64) {
  return [...new Set(String(text || "").toLowerCase().match(/[a-z0-9]{3,}/g) || [])].slice(
    0,
    Math.max(1, maxTokens)
  );
}

function cleanDailyEntryContent(content) {
  const text = String(content || "")
    .replace(/\s+/g, " ")
    .replace(/\|/g, "/")
    .trim();
  if (!text) return "";
  if (text.length < 2) return "";
  return text.slice(0, 320);
}

function sanitizeInline(value, maxLen = 120) {
  return String(value || "")
    .replace(/[\r\n|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function formatDateLocal(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
