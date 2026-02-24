const state = {
  token: localStorage.getItem("dashboard_token") || "",
  settings: null,
  actions: []
};

const el = {
  token: document.getElementById("dashboard-token"),
  saveToken: document.getElementById("save-token"),
  runtimeState: document.getElementById("runtime-state"),
  totalCost: document.getElementById("total-cost"),
  replyCount: document.getElementById("reply-count"),
  messageCount: document.getElementById("message-count"),
  reactionCount: document.getElementById("reaction-count"),
  settingsForm: document.getElementById("settings-form"),
  botName: document.getElementById("bot-name"),
  replyLevel: document.getElementById("reply-level"),
  replyValue: document.getElementById("reply-value"),
  reactionLevel: document.getElementById("reaction-level"),
  reactionValue: document.getElementById("reaction-value"),
  allowReplies: document.getElementById("allow-replies"),
  allowInitiative: document.getElementById("allow-initiative"),
  allowReactions: document.getElementById("allow-reactions"),
  memoryEnabled: document.getElementById("memory-enabled"),
  provider: document.getElementById("provider"),
  model: document.getElementById("model"),
  temperature: document.getElementById("temperature"),
  maxTokens: document.getElementById("max-tokens"),
  maxMessages: document.getElementById("max-messages"),
  maxReactions: document.getElementById("max-reactions"),
  minGap: document.getElementById("min-gap"),
  catchupEnabled: document.getElementById("catchup-enabled"),
  catchupLookback: document.getElementById("catchup-lookback"),
  catchupMaxMessages: document.getElementById("catchup-max-messages"),
  catchupMaxReplies: document.getElementById("catchup-max-replies"),
  initiativeEnabled: document.getElementById("initiative-enabled"),
  initiativeStartupPost: document.getElementById("initiative-startup-post"),
  initiativePostsPerDay: document.getElementById("initiative-posts-per-day"),
  initiativeMinMinutes: document.getElementById("initiative-min-minutes"),
  initiativeImageEnabled: document.getElementById("initiative-image-enabled"),
  initiativeImageChance: document.getElementById("initiative-image-chance"),
  initiativeImageModel: document.getElementById("initiative-image-model"),
  initiativeChannels: document.getElementById("initiative-channels"),
  allowedChannels: document.getElementById("allowed-channels"),
  blockedChannels: document.getElementById("blocked-channels"),
  blockedUsers: document.getElementById("blocked-users"),
  saveStatus: document.getElementById("save-status"),
  actionFilter: document.getElementById("action-filter"),
  actionsBody: document.getElementById("actions-body"),
  memoryBox: document.getElementById("memory-box"),
  refreshMemory: document.getElementById("refresh-memory"),
  dailyCost: document.getElementById("daily-cost")
};

el.token.value = state.token;

el.saveToken.addEventListener("click", () => {
  state.token = el.token.value.trim();
  localStorage.setItem("dashboard_token", state.token);
  setStatus("Token saved.");
  loadAll();
});

el.replyLevel.addEventListener("input", () => {
  el.replyValue.textContent = el.replyLevel.value;
});

el.reactionLevel.addEventListener("input", () => {
  el.reactionValue.textContent = el.reactionLevel.value;
});

el.actionFilter.addEventListener("change", renderActions);

el.refreshMemory.addEventListener("click", async () => {
  try {
    await api("/api/memory/refresh", { method: "POST" });
    await loadMemory();
    setStatus("Memory regenerated.");
  } catch (error) {
    setStatus(error.message, true);
  }
});

el.settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const patch = {
    botName: el.botName.value.trim(),
    activity: {
      replyLevel: Number(el.replyLevel.value),
      reactionLevel: Number(el.reactionLevel.value),
      minSecondsBetweenMessages: Number(el.minGap.value)
    },
    llm: {
      provider: el.provider.value,
      model: el.model.value.trim(),
      temperature: Number(el.temperature.value),
      maxOutputTokens: Number(el.maxTokens.value)
    },
    startup: {
      catchupEnabled: el.catchupEnabled.checked,
      catchupLookbackHours: Number(el.catchupLookback.value),
      catchupMaxMessagesPerChannel: Number(el.catchupMaxMessages.value),
      maxCatchupRepliesPerChannel: Number(el.catchupMaxReplies.value)
    },
    permissions: {
      allowReplies: el.allowReplies.checked,
      allowInitiativeReplies: el.allowInitiative.checked,
      allowReactions: el.allowReactions.checked,
      initiativeChannelIds: parseIdList(el.initiativeChannels.value),
      allowedChannelIds: parseIdList(el.allowedChannels.value),
      blockedChannelIds: parseIdList(el.blockedChannels.value),
      blockedUserIds: parseIdList(el.blockedUsers.value),
      maxMessagesPerHour: Number(el.maxMessages.value),
      maxReactionsPerHour: Number(el.maxReactions.value)
    },
    initiative: {
      enabled: el.initiativeEnabled.checked,
      maxPostsPerDay: Number(el.initiativePostsPerDay.value),
      minMinutesBetweenPosts: Number(el.initiativeMinMinutes.value),
      postOnStartup: el.initiativeStartupPost.checked,
      allowImagePosts: el.initiativeImageEnabled.checked,
      imagePostChancePercent: Number(el.initiativeImageChance.value),
      imageModel: el.initiativeImageModel.value.trim()
    },
    memory: {
      enabled: el.memoryEnabled.checked
    }
  };

  try {
    state.settings = await api("/api/settings", {
      method: "PUT",
      body: patch
    });
    hydrateSettings(state.settings);
    setStatus("Settings saved.");
    await loadStats();
  } catch (error) {
    setStatus(error.message, true);
  }
});

async function loadAll() {
  try {
    await Promise.all([loadSettings(), loadStats(), loadActions(), loadMemory()]);
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function loadSettings() {
  const settings = await api("/api/settings");
  state.settings = settings;
  hydrateSettings(settings);
}

function hydrateSettings(settings) {
  const startup = settings.startup || {};
  const initiative = settings.initiative || {};
  const activity = settings.activity || {};
  const replyLevel = activity.replyLevel ?? 35;
  const reactionLevel = activity.reactionLevel ?? 20;

  el.botName.value = settings.botName || "clanker conk";
  el.replyLevel.value = replyLevel;
  el.replyValue.textContent = String(replyLevel);
  el.reactionLevel.value = reactionLevel;
  el.reactionValue.textContent = String(reactionLevel);

  el.allowReplies.checked = settings.permissions.allowReplies;
  el.allowInitiative.checked = settings.permissions.allowInitiativeReplies !== false;
  el.allowReactions.checked = settings.permissions.allowReactions;
  el.memoryEnabled.checked = settings.memory.enabled;

  el.provider.value = settings.llm.provider;
  el.model.value = settings.llm.model;
  el.temperature.value = settings.llm.temperature;
  el.maxTokens.value = settings.llm.maxOutputTokens;

  el.maxMessages.value =
    settings.permissions.maxMessagesPerHour ?? settings.permissions.maxRepliesPerHour ?? 20;
  el.maxReactions.value = settings.permissions.maxReactionsPerHour;
  el.minGap.value = activity.minSecondsBetweenMessages ?? 20;

  el.catchupEnabled.checked = startup.catchupEnabled !== false;
  el.catchupLookback.value = startup.catchupLookbackHours ?? 6;
  el.catchupMaxMessages.value = startup.catchupMaxMessagesPerChannel ?? 20;
  el.catchupMaxReplies.value = startup.maxCatchupRepliesPerChannel ?? 2;

  el.initiativeEnabled.checked = Boolean(initiative.enabled);
  el.initiativeStartupPost.checked = Boolean(initiative.postOnStartup);
  el.initiativePostsPerDay.value = initiative.maxPostsPerDay ?? 6;
  el.initiativeMinMinutes.value = initiative.minMinutesBetweenPosts ?? 120;
  el.initiativeImageEnabled.checked = Boolean(initiative.allowImagePosts);
  el.initiativeImageChance.value = initiative.imagePostChancePercent ?? 25;
  el.initiativeImageModel.value = initiative.imageModel || "gpt-image-1";

  el.initiativeChannels.value = formatIdList(settings.permissions.initiativeChannelIds);
  el.allowedChannels.value = formatIdList(settings.permissions.allowedChannelIds);
  el.blockedChannels.value = formatIdList(settings.permissions.blockedChannelIds);
  el.blockedUsers.value = formatIdList(settings.permissions.blockedUserIds);
}

async function loadStats() {
  const payload = await api("/api/stats");

  const stats = payload.stats;
  const runtime = payload.runtime;

  el.runtimeState.textContent = runtime.isReady
    ? `online (${runtime.guildCount} guilds)`
    : "connecting";

  el.totalCost.textContent = `$${Number(stats.totalCostUsd || 0).toFixed(6)}`;
  el.replyCount.textContent = String(stats.last24h.sent_reply || 0);
  el.messageCount.textContent = String(
    Number(stats.last24h.sent_message || 0) + Number(stats.last24h.initiative_post || 0)
  );
  el.reactionCount.textContent = String(stats.last24h.reacted || 0);

  renderDailyCost(stats.dailyCost || []);
}

function renderDailyCost(rows) {
  el.dailyCost.innerHTML = "";

  if (!rows.length) {
    const li = document.createElement("li");
    li.textContent = "No usage yet";
    el.dailyCost.appendChild(li);
    return;
  }

  for (const row of rows) {
    const li = document.createElement("li");
    const day = document.createElement("span");
    day.textContent = row.day;
    const value = document.createElement("strong");
    value.textContent = `$${Number(row.usd || 0).toFixed(6)}`;

    li.append(day, value);
    el.dailyCost.appendChild(li);
  }
}

async function loadActions() {
  state.actions = await api("/api/actions?limit=220");
  renderActions();
}

function renderActions() {
  const filter = el.actionFilter.value;
  const rows =
    filter === "all" ? state.actions : state.actions.filter((action) => action.kind === filter);

  el.actionsBody.innerHTML = "";

  for (const action of rows) {
    const tr = document.createElement("tr");

    const created = new Date(action.created_at).toLocaleString();
    const channel = action.channel_id || "-";
    const content = String(action.content || "").slice(0, 180);
    const cost = Number(action.usd_cost || 0).toFixed(6);

    tr.innerHTML = `
      <td>${escapeHtml(created)}</td>
      <td>${escapeHtml(action.kind)}</td>
      <td>${escapeHtml(channel)}</td>
      <td>${escapeHtml(content)}</td>
      <td>$${cost}</td>
    `;

    el.actionsBody.appendChild(tr);
  }
}

async function loadMemory() {
  const payload = await api("/api/memory");
  el.memoryBox.textContent = payload.markdown || "";
}

async function api(url, options = {}) {
  const headers = {
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(state.token ? { "x-dashboard-token": state.token } : {})
  };

  const response = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API ${response.status}: ${text}`);
  }

  return response.json();
}

function parseIdList(value) {
  return [...new Set(value.split(/[\n,]/g).map((x) => x.trim()).filter(Boolean))];
}

function formatIdList(items) {
  return (items || []).join("\n");
}

function setStatus(message, isError = false) {
  el.saveStatus.textContent = message;
  el.saveStatus.className = isError ? "status error" : "status";
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

loadAll();
setInterval(() => {
  loadStats().catch((error) => setStatus(error.message, true));
}, 10_000);
setInterval(() => {
  loadActions().catch((error) => setStatus(error.message, true));
}, 10_000);
setInterval(() => {
  loadMemory().catch((error) => setStatus(error.message, true));
}, 30_000);
