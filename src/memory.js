import fs from "node:fs/promises";
import path from "node:path";

export class MemoryManager {
  constructor({ store, memoryFilePath }) {
    this.store = store;
    this.memoryFilePath = memoryFilePath;
    this.pendingWrite = false;
  }

  async ingestMessage({ messageId, authorId, authorName, content }) {
    if (!content || content.length < 4) return;

    const extracted = extractFactsHeuristic({ authorName, content });
    if (!extracted.length) return;

    let insertedAny = false;
    for (const factText of extracted) {
      const inserted = this.store.addMemoryFact({
        subject: authorId,
        fact: factText,
        sourceMessageId: messageId,
        confidence: 0.55
      });

      if (inserted) {
        insertedAny = true;
        this.store.logAction({
          kind: "memory_fact",
          userId: authorId,
          messageId,
          content: factText
        });
      }
    }

    if (insertedAny) {
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
      } finally {
        this.pendingWrite = false;
      }
    }, 1000);
  }

  async refreshMemoryMarkdown() {
    const facts = this.store.getRecentFacts(120);
    const highlights = this.store.getRecentHighlights(24);

    const groupedFacts = new Map();
    for (const fact of facts) {
      if (!groupedFacts.has(fact.subject)) groupedFacts.set(fact.subject, []);
      groupedFacts.get(fact.subject).push(fact.fact);
    }

    const peopleSection = [];
    for (const [subject, subjectFacts] of groupedFacts.entries()) {
      const uniqueFacts = [...new Set(subjectFacts)].slice(0, 4);
      peopleSection.push(`- ${subject}: ${uniqueFacts.join(" | ")}`);
    }

    const highlightsSection = highlights.map((row) => {
      const text = String(row.content || "").replace(/\s+/g, " ").trim();
      return `- ${row.author_name}: ${text}`;
    });

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
      "## People",
      ...(peopleSection.length ? peopleSection : ["- (No stable people facts yet.)"]),
      "",
      "## Ongoing Lore",
      "- Captured from recurring topics in recent chat.",
      "",
      "## Recent Highlights",
      ...(highlightsSection.length ? highlightsSection : ["- (No highlights yet.)"])
    ].join("\n");

    await fs.mkdir(path.dirname(this.memoryFilePath), { recursive: true });
    await fs.writeFile(this.memoryFilePath, markdown, "utf8");
  }

  async readMemoryMarkdown() {
    try {
      return await fs.readFile(this.memoryFilePath, "utf8");
    } catch {
      return "# Memory\n\n(no memory file yet)";
    }
  }
}

function extractFactsHeuristic({ authorName, content }) {
  const text = String(content).trim();
  const lowered = text.toLowerCase();
  const facts = [];

  const nameSafe = String(authorName).replace(/[\n\r]/g, " ").trim();

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
