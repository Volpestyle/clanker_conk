import fs from "node:fs/promises";
import path from "node:path";

const DAILY_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.md$/;
const LORE_SUBJECT = "__lore__";

export class MemoryManager {
  constructor({ store, memoryFilePath }) {
    this.store = store;
    this.memoryFilePath = memoryFilePath;
    this.memoryDirPath = path.dirname(memoryFilePath);
    this.pendingWrite = false;
    this.initializedDailyFiles = new Set();
  }

  async ingestMessage({ messageId, authorId, authorName, content }) {
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
      const extracted = extractFactsHeuristic({ authorName, content: cleanedContent });

      for (const factText of extracted) {
        const inserted = this.store.addMemoryFact({
          subject: authorId,
          fact: factText,
          sourceMessageId: messageId,
          confidence: 0.55
        });

        if (inserted) {
          insertedAnyFact = true;
          this.store.logAction({
            kind: "memory_fact",
            userId: authorId,
            messageId,
            content: factText
          });
        }
      }
    }

    if (wroteDailyEntry || insertedAnyFact) {
      await this.queueMemoryRefresh();
    }
  }

  async buildPromptMemorySlice({ userId, channelId, queryText }) {
    const userFacts = this.store.getFactsForSubject(userId, 8);
    const relevantMessages = this.store.searchRelevantMessages(channelId, queryText, 8);
    const memoryMarkdown = await this.readMemoryMarkdown();

    return {
      userFacts,
      relevantMessages,
      memoryMarkdown
    };
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
            .map((row) => cleanFactForMemory(row.fact))
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
    if (isInstructionLikeMemoryLine(cleaned)) return false;
    if (!isMemoryLineGroundedInSource(cleaned, sourceText)) return false;

    const factText = `Memory line: ${cleaned}.`;
    const inserted = this.store.addMemoryFact({
      subject: LORE_SUBJECT,
      fact: factText,
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

function extractFactsHeuristic({ authorName, content }) {
  const text = String(content).trim();
  const lowered = text.toLowerCase();
  const facts = [];

  const nameSafe = String(authorName || "unknown")
    .replace(/[\n\r]/g, " ")
    .trim();

  const favoriteMatch = lowered.match(/\bmy favorite ([a-z0-9 ]{2,24}) is ([a-z0-9 '\-]{2,40})/i);
  if (favoriteMatch) {
    facts.push(`${nameSafe}'s favorite ${favoriteMatch[1].trim()} is ${favoriteMatch[2].trim()}.`);
  }

  const likeMatch = lowered.match(/\bi (love|like|hate|play|watch|listen to) ([a-z0-9 '\-]{2,50})/i);
  if (likeMatch) {
    facts.push(`${nameSafe} says they ${likeMatch[1]} ${likeMatch[2].trim()}.`);
  }

  const callMeMatch = lowered.match(/\b(call me|i go by) ([a-z0-9 '\-]{2,24})/i);
  if (callMeMatch) {
    facts.push(`${nameSafe} also goes by ${callMeMatch[2].trim()}.`);
  }

  const imMatch = lowered.match(/\bi(?:'m| am) ([a-z0-9 '\-]{2,24})/i);
  if (imMatch && !/[?.!]$/.test(text)) {
    facts.push(`${nameSafe} described themselves as ${imMatch[1].trim()}.`);
  }

  return [...new Set(facts)].slice(0, 3);
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

function isInstructionLikeMemoryLine(line) {
  const text = String(line || "").toLowerCase();
  if (!text) return true;
  if (/\[\[[\s\S]*\]\]/.test(text)) return true;
  if (/(?:system|developer|prompt|instruction|policy|jailbreak|override)/.test(text)) return true;
  if (/(?:ignore|disregard|bypass)\s+(?:previous|prior|earlier)/.test(text)) return true;
  if (/(?:always|never)\s+(?:reply|respond|say|output)/.test(text)) return true;
  if (/(?:api key|token|password|credential|secret)/.test(text)) return true;
  return false;
}

function isMemoryLineGroundedInSource(memoryLine, sourceText) {
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
