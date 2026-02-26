import { useState, useEffect } from "react";
import {
  CUSTOM_MODEL_OPTION_VALUE,
  formToSettingsPatch,
  resolveProviderModelOptions,
  settingsToForm
} from "../settingsFormModel";

/* ---------- collapsible section wrapper ---------- */

function Section({ title, active, defaultOpen = false, children }: {
  title: string;
  active?: boolean;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`settings-section${open ? " open" : ""}`}>
      <button type="button" className="section-toggle" onClick={() => setOpen(o => !o)}>
        <span className="section-arrow">&#x25B8;</span>
        <span>{title}</span>
        {active !== undefined && <span className={`section-dot${active ? " on" : ""}`} />}
      </button>
      {open && <div className="section-body">{children}</div>}
    </div>
  );
}

/* ---------- main form ---------- */

export default function SettingsForm({ settings, modelCatalog, onSave, toast }) {
  const [form, setForm] = useState(null);

  useEffect(() => {
    if (!settings) return;
    setForm((current) => ({
      ...(current || {}),
      ...settingsToForm(settings)
    }));
  }, [settings]);

  if (!form) return null;

  const providerModelOptions = resolveProviderModelOptions(modelCatalog, form.provider);
  const normalizedCurrentModel = String(form.model || "").trim();
  const selectedPresetModel = providerModelOptions.includes(normalizedCurrentModel)
    ? normalizedCurrentModel
    : CUSTOM_MODEL_OPTION_VALUE;
  const isVoiceAgentMode = form.voiceMode === "voice_agent";
  const isOpenAiRealtimeMode = form.voiceMode === "openai_realtime";
  const isSttPipelineMode = form.voiceMode === "stt_pipeline";
  const showVoiceAdvanced = form.voiceEnabled;
  const showInitiativeAdvanced = form.autonomousInitiativeEnabled;
  const showInitiativeImageControls = form.initiativeImageEnabled || form.replyImageEnabled;
  const showInitiativeVideoControls = form.initiativeVideoEnabled || form.replyVideoEnabled;

  function set(key) {
    return (e) => setForm((f) => ({ ...f, [key]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  }

  function selectPresetModel(e) {
    const selected = String(e.target.value || "");
    if (selected === CUSTOM_MODEL_OPTION_VALUE) return;
    setForm((current) => ({ ...current, model: selected }));
  }

  function submit(e) {
    e.preventDefault();
    onSave(formToSettingsPatch(form));
  }

  return (
    <form className="panel settings-form" onSubmit={submit}>
      <h3>Settings</h3>

      {/* -------- CORE BEHAVIOR -------- */}
      <Section title="Core Behavior" defaultOpen>
        <label htmlFor="bot-name">Bot display name</label>
        <input id="bot-name" type="text" value={form.botName} onChange={set("botName")} />

        <label htmlFor="persona-flavor">Persona flavor</label>
        <textarea
          id="persona-flavor"
          rows="3"
          value={form.personaFlavor}
          onChange={set("personaFlavor")}
        />

        <label htmlFor="persona-hard-limits">Persona hard limits (one per line)</label>
        <textarea
          id="persona-hard-limits"
          rows="4"
          value={form.personaHardLimits}
          onChange={set("personaHardLimits")}
        />

        <label htmlFor="reply-level">
          Unsolicited reply chance: <strong>{form.replyLevel}%</strong>
        </label>
        <input
          id="reply-level"
          type="range"
          min="0"
          max="100"
          step="1"
          value={form.replyLevel}
          onChange={set("replyLevel")}
        />

        <label htmlFor="reaction-level">
          Reaction eagerness: <strong>{form.reactionLevel}%</strong>
        </label>
        <input
          id="reaction-level"
          type="range"
          min="0"
          max="100"
          step="1"
          value={form.reactionLevel}
          onChange={set("reactionLevel")}
        />

        <div className="toggles">
          <label>
            <input type="checkbox" checked={form.allowReplies} onChange={set("allowReplies")} />
            Allow replies
          </label>
          <label>
            <input type="checkbox" checked={form.allowInitiative} onChange={set("allowInitiative")} />
            Allow initiative replies
          </label>
          <label>
            <input type="checkbox" checked={form.allowReactions} onChange={set("allowReactions")} />
            Allow reactions
          </label>
          <label>
            <input type="checkbox" checked={form.memoryEnabled} onChange={set("memoryEnabled")} />
            Memory enabled
          </label>
        </div>
      </Section>

      {/* -------- LLM CONFIGURATION -------- */}
      <Section title="LLM Configuration" defaultOpen>
        <label htmlFor="provider">LLM provider</label>
        <select id="provider" value={form.provider} onChange={set("provider")}>
          <option value="openai">openai</option>
          <option value="anthropic">anthropic</option>
          <option value="xai">xai (grok)</option>
          <option value="claude-code">claude code (local)</option>
        </select>

        <label htmlFor="model-preset">Model Preset (priced models)</label>
        <select id="model-preset" value={selectedPresetModel} onChange={selectPresetModel}>
          {providerModelOptions.map((modelId) => (
            <option key={modelId} value={modelId}>
              {modelId}
            </option>
          ))}
          <option value={CUSTOM_MODEL_OPTION_VALUE}>custom model (manual)</option>
        </select>

        <label htmlFor="model">Model ID</label>
        <input
          id="model"
          type="text"
          placeholder="gpt-4.1-mini / claude-3-5-haiku-latest / grok-3-mini-latest"
          value={form.model}
          onChange={set("model")}
        />

        <div className="split">
          <div>
            <label htmlFor="temperature">Temperature</label>
            <input
              id="temperature"
              type="number"
              min="0"
              max="2"
              step="0.1"
              value={form.temperature}
              onChange={set("temperature")}
            />
          </div>
          <div>
            <label htmlFor="max-tokens">Max output tokens</label>
            <input
              id="max-tokens"
              type="number"
              min="32"
              max="1400"
              step="1"
              value={form.maxTokens}
              onChange={set("maxTokens")}
            />
          </div>
        </div>
      </Section>

      {/* -------- WEB SEARCH -------- */}
      <Section title="Web Search" active={form.webSearchEnabled}>
        <div className="toggles">
          <label>
            <input
              type="checkbox"
              checked={form.webSearchEnabled}
              onChange={set("webSearchEnabled")}
            />
            Enable live web search for replies
          </label>
        </div>

        {form.webSearchEnabled && (
          <>
            <div className="toggles">
              <label>
                <input
                  type="checkbox"
                  checked={form.webSearchSafeMode}
                  onChange={set("webSearchSafeMode")}
                />
                SafeSearch enabled
              </label>
            </div>

            <div className="split">
              <div>
                <label htmlFor="web-search-per-hour">Max searches/hour</label>
                <input
                  id="web-search-per-hour"
                  type="number"
                  min="1"
                  max="120"
                  value={form.webSearchPerHour}
                  onChange={set("webSearchPerHour")}
                />
              </div>
              <div>
                <label htmlFor="web-search-results">Search results/query</label>
                <input
                  id="web-search-results"
                  type="number"
                  min="1"
                  max="10"
                  value={form.webSearchMaxResults}
                  onChange={set("webSearchMaxResults")}
                />
              </div>
            </div>

            <div className="split">
              <div>
                <label htmlFor="web-search-pages">Result pages to inspect</label>
                <input
                  id="web-search-pages"
                  type="number"
                  min="0"
                  max="5"
                  value={form.webSearchMaxPages}
                  onChange={set("webSearchMaxPages")}
                />
              </div>
              <div>
                <label htmlFor="web-search-chars">Max chars/page extract</label>
                <input
                  id="web-search-chars"
                  type="number"
                  min="350"
                  max="4000"
                  value={form.webSearchMaxChars}
                  onChange={set("webSearchMaxChars")}
                />
              </div>
            </div>

            <div className="split">
              <div>
                <label htmlFor="web-search-provider-order">Provider order (comma or newline list)</label>
                <input
                  id="web-search-provider-order"
                  type="text"
                  value={form.webSearchProviderOrder}
                  onChange={set("webSearchProviderOrder")}
                  placeholder="brave,serpapi"
                />
              </div>
              <div>
                <label htmlFor="web-search-recency-days">Default recency days</label>
                <input
                  id="web-search-recency-days"
                  type="number"
                  min="1"
                  max="365"
                  value={form.webSearchRecencyDaysDefault}
                  onChange={set("webSearchRecencyDaysDefault")}
                />
              </div>
            </div>

            <div className="split">
              <div>
                <label htmlFor="web-search-concurrent-fetches">Max concurrent fetches</label>
                <input
                  id="web-search-concurrent-fetches"
                  type="number"
                  min="1"
                  max="10"
                  value={form.webSearchMaxConcurrentFetches}
                  onChange={set("webSearchMaxConcurrentFetches")}
                />
              </div>
            </div>
          </>
        )}
      </Section>

      {/* -------- VIDEO CONTEXT -------- */}
      <Section title="Video Context" active={form.videoContextEnabled}>
        <div className="toggles">
          <label>
            <input
              type="checkbox"
              checked={form.videoContextEnabled}
              onChange={set("videoContextEnabled")}
            />
            Enable video transcript/metadata context in replies
          </label>
        </div>

        {form.videoContextEnabled && (
          <>
            <div className="toggles">
              <label>
                <input
                  type="checkbox"
                  checked={form.videoContextAsrFallback}
                  onChange={set("videoContextAsrFallback")}
                />
                Fallback to ASR when captions are unavailable
              </label>
            </div>

            <div className="split">
              <div>
                <label htmlFor="video-context-per-hour">Max video lookups/hour</label>
                <input
                  id="video-context-per-hour"
                  type="number"
                  min="0"
                  max="120"
                  value={form.videoContextPerHour}
                  onChange={set("videoContextPerHour")}
                />
              </div>
              <div>
                <label htmlFor="video-context-max-videos">Max videos per message</label>
                <input
                  id="video-context-max-videos"
                  type="number"
                  min="0"
                  max="6"
                  value={form.videoContextMaxVideos}
                  onChange={set("videoContextMaxVideos")}
                />
              </div>
            </div>

            <div className="split">
              <div>
                <label htmlFor="video-context-max-chars">Max transcript chars per video</label>
                <input
                  id="video-context-max-chars"
                  type="number"
                  min="200"
                  max="4000"
                  value={form.videoContextMaxChars}
                  onChange={set("videoContextMaxChars")}
                />
              </div>
              <div>
                <label htmlFor="video-context-keyframe-interval">Keyframe interval (seconds)</label>
                <input
                  id="video-context-keyframe-interval"
                  type="number"
                  min="0"
                  max="120"
                  value={form.videoContextKeyframeInterval}
                  onChange={set("videoContextKeyframeInterval")}
                />
              </div>
            </div>

            <div className="split">
              <div>
                <label htmlFor="video-context-max-keyframes">Max keyframes per video</label>
                <input
                  id="video-context-max-keyframes"
                  type="number"
                  min="0"
                  max="8"
                  value={form.videoContextMaxKeyframes}
                  onChange={set("videoContextMaxKeyframes")}
                />
              </div>
              {form.videoContextAsrFallback ? (
                <div>
                  <label htmlFor="video-context-max-asr-seconds">Max ASR seconds per video</label>
                  <input
                    id="video-context-max-asr-seconds"
                    type="number"
                    min="15"
                    max="600"
                    value={form.videoContextMaxAsrSeconds}
                    onChange={set("videoContextMaxAsrSeconds")}
                  />
                </div>
              ) : (
                <div />
              )}
            </div>
          </>
        )}
      </Section>

      {/* -------- VOICE MODE -------- */}
      <Section title="Voice Mode" active={form.voiceEnabled}>
        <div className="toggles">
          <label>
            <input type="checkbox" checked={form.voiceEnabled} onChange={set("voiceEnabled")} />
            Enable voice sessions
          </label>
        </div>

        {showVoiceAdvanced && (
          <>
            <div className="toggles">
              <label>
                <input type="checkbox" checked={form.voiceJoinOnTextNL} onChange={set("voiceJoinOnTextNL")} />
                Allow NL join/leave/status triggers
              </label>
            </div>

            <label htmlFor="voice-mode">Voice runtime mode</label>
            <select id="voice-mode" value={form.voiceMode} onChange={set("voiceMode")}>
              <option value="voice_agent">Voice agent (xAI realtime low-latency)</option>
              <option value="openai_realtime">OpenAI realtime (low-latency)</option>
              <option value="stt_pipeline">STT pipeline (reuse chat LLM + memory)</option>
            </select>

            <div className="split">
              <div>
                <label htmlFor="voice-intent-threshold">Intent confidence threshold</label>
                <input
                  id="voice-intent-threshold"
                  type="number"
                  min="0.4"
                  max="0.99"
                  step="0.01"
                  value={form.voiceIntentConfidenceThreshold}
                  onChange={set("voiceIntentConfidenceThreshold")}
                />
              </div>
              <div>
                <label htmlFor="voice-max-session-minutes">Max session minutes</label>
                <input
                  id="voice-max-session-minutes"
                  type="number"
                  min="1"
                  max="120"
                  value={form.voiceMaxSessionMinutes}
                  onChange={set("voiceMaxSessionMinutes")}
                />
              </div>
            </div>

            <div className="split">
              <div>
                <label htmlFor="voice-inactivity-seconds">Inactivity leave seconds</label>
                <input
                  id="voice-inactivity-seconds"
                  type="number"
                  min="20"
                  max="3600"
                  value={form.voiceInactivityLeaveSeconds}
                  onChange={set("voiceInactivityLeaveSeconds")}
                />
              </div>
              <div>
                <label htmlFor="voice-max-sessions-day">Max sessions/day</label>
                <input
                  id="voice-max-sessions-day"
                  type="number"
                  min="0"
                  max="120"
                  value={form.voiceMaxSessionsPerDay}
                  onChange={set("voiceMaxSessionsPerDay")}
                />
              </div>
            </div>

            <label htmlFor="voice-reply-eagerness">
              Voice reply eagerness (chime-ins when not addressed): <strong>{form.voiceReplyEagerness}%</strong>
            </label>
            <input
              id="voice-reply-eagerness"
              type="range"
              min="0"
              max="100"
              step="1"
              value={form.voiceReplyEagerness}
              onChange={set("voiceReplyEagerness")}
            />

            <div className="split">
              <div>
                <label htmlFor="voice-eager-cooldown-seconds">Eager chime-in cooldown (seconds)</label>
                <input
                  id="voice-eager-cooldown-seconds"
                  type="number"
                  min="10"
                  max="300"
                  value={form.voiceEagerCooldownSeconds}
                  onChange={set("voiceEagerCooldownSeconds")}
                />
              </div>
            </div>

            {/* -- xAI voice agent -- */}
            {isVoiceAgentMode && (
              <>
                <div className="split">
                  <div>
                    <label htmlFor="voice-xai-voice">xAI voice</label>
                    <input id="voice-xai-voice" type="text" value={form.voiceXaiVoice} onChange={set("voiceXaiVoice")} />
                  </div>
                  <div>
                    <label htmlFor="voice-xai-region">xAI region</label>
                    <input id="voice-xai-region" type="text" value={form.voiceXaiRegion} onChange={set("voiceXaiRegion")} />
                  </div>
                </div>

                <div className="split">
                  <div>
                    <label htmlFor="voice-xai-audio-format">xAI audio format</label>
                    <input
                      id="voice-xai-audio-format"
                      type="text"
                      value={form.voiceXaiAudioFormat}
                      onChange={set("voiceXaiAudioFormat")}
                    />
                  </div>
                  <div>
                    <label htmlFor="voice-xai-sample-rate">xAI sample rate (Hz)</label>
                    <input
                      id="voice-xai-sample-rate"
                      type="number"
                      min="8000"
                      max="48000"
                      value={form.voiceXaiSampleRateHz}
                      onChange={set("voiceXaiSampleRateHz")}
                    />
                  </div>
                </div>
              </>
            )}

            {/* -- OpenAI realtime -- */}
            {isOpenAiRealtimeMode && (
              <>
                <div className="split">
                  <div>
                    <label htmlFor="voice-openai-realtime-model">OpenAI realtime model</label>
                    <input
                      id="voice-openai-realtime-model"
                      type="text"
                      value={form.voiceOpenAiRealtimeModel}
                      onChange={set("voiceOpenAiRealtimeModel")}
                    />
                  </div>
                  <div>
                    <label htmlFor="voice-openai-realtime-voice">OpenAI realtime voice</label>
                    <input
                      id="voice-openai-realtime-voice"
                      type="text"
                      value={form.voiceOpenAiRealtimeVoice}
                      onChange={set("voiceOpenAiRealtimeVoice")}
                    />
                  </div>
                </div>

                <div className="split">
                  <div>
                    <label htmlFor="voice-openai-realtime-input-format">OpenAI input audio format</label>
                    <input
                      id="voice-openai-realtime-input-format"
                      type="text"
                      value={form.voiceOpenAiRealtimeInputAudioFormat}
                      onChange={set("voiceOpenAiRealtimeInputAudioFormat")}
                    />
                  </div>
                  <div>
                    <label htmlFor="voice-openai-realtime-output-format">OpenAI output audio format</label>
                    <input
                      id="voice-openai-realtime-output-format"
                      type="text"
                      value={form.voiceOpenAiRealtimeOutputAudioFormat}
                      onChange={set("voiceOpenAiRealtimeOutputAudioFormat")}
                    />
                  </div>
                </div>

                <div className="split">
                  <div>
                    <label htmlFor="voice-openai-realtime-input-sample-rate">OpenAI input sample rate (Hz)</label>
                    <input
                      id="voice-openai-realtime-input-sample-rate"
                      type="number"
                      min="8000"
                      max="48000"
                      value={form.voiceOpenAiRealtimeInputSampleRateHz}
                      onChange={set("voiceOpenAiRealtimeInputSampleRateHz")}
                    />
                  </div>
                  <div>
                    <label htmlFor="voice-openai-realtime-output-sample-rate">OpenAI output sample rate (Hz)</label>
                    <input
                      id="voice-openai-realtime-output-sample-rate"
                      type="number"
                      min="8000"
                      max="48000"
                      value={form.voiceOpenAiRealtimeOutputSampleRateHz}
                      onChange={set("voiceOpenAiRealtimeOutputSampleRateHz")}
                    />
                  </div>
                </div>

                <div className="split">
                  <div>
                    <label htmlFor="voice-openai-realtime-transcription-model">
                      OpenAI realtime input transcription model
                    </label>
                    <input
                      id="voice-openai-realtime-transcription-model"
                      type="text"
                      value={form.voiceOpenAiRealtimeInputTranscriptionModel}
                      onChange={set("voiceOpenAiRealtimeInputTranscriptionModel")}
                    />
                  </div>
                  <div />
                </div>

                <div className="toggles">
                  <label>
                    <input
                      type="checkbox"
                      checked={form.voiceOpenAiRealtimeAllowNsfwHumor}
                      onChange={set("voiceOpenAiRealtimeAllowNsfwHumor")}
                    />
                    OpenAI realtime: allow adult/NSFW humor (with safety limits)
                  </label>
                </div>
              </>
            )}

            {/* -- STT pipeline -- */}
            {isSttPipelineMode && (
              <>
                <div className="split">
                  <div>
                    <label htmlFor="voice-stt-transcribe-model">STT model</label>
                    <input
                      id="voice-stt-transcribe-model"
                      type="text"
                      value={form.voiceSttTranscriptionModel}
                      onChange={set("voiceSttTranscriptionModel")}
                    />
                  </div>
                  <div>
                    <label htmlFor="voice-stt-tts-model">TTS model</label>
                    <input
                      id="voice-stt-tts-model"
                      type="text"
                      value={form.voiceSttTtsModel}
                      onChange={set("voiceSttTtsModel")}
                    />
                  </div>
                </div>

                <div className="split">
                  <div>
                    <label htmlFor="voice-stt-tts-voice">TTS voice</label>
                    <input
                      id="voice-stt-tts-voice"
                      type="text"
                      value={form.voiceSttTtsVoice}
                      onChange={set("voiceSttTtsVoice")}
                    />
                  </div>
                  <div>
                    <label htmlFor="voice-stt-tts-speed">TTS speed</label>
                    <input
                      id="voice-stt-tts-speed"
                      type="number"
                      min="0.25"
                      max="2"
                      step="0.05"
                      value={form.voiceSttTtsSpeed}
                      onChange={set("voiceSttTtsSpeed")}
                    />
                  </div>
                </div>
              </>
            )}

            {/* -- Soundboard -- */}
            <div className="toggles">
              <label>
                <input
                  type="checkbox"
                  checked={form.voiceSoundboardEnabled}
                  onChange={set("voiceSoundboardEnabled")}
                />
                Enable voice soundboard director
              </label>
              {form.voiceSoundboardEnabled && (
                <label>
                  <input
                    type="checkbox"
                    checked={form.voiceSoundboardAllowExternalSounds}
                    onChange={set("voiceSoundboardAllowExternalSounds")}
                  />
                  Allow external soundboard sounds
                </label>
              )}
            </div>

            {form.voiceSoundboardEnabled && (
              <>
                <label htmlFor="voice-sb-preferred">
                  Sound refs (`sound_id` or `sound_id@source_guild_id`, one per line). Leave empty to auto-use guild sounds.
                </label>
                <textarea
                  id="voice-sb-preferred"
                  rows="3"
                  value={form.voiceSoundboardPreferredSoundIds}
                  onChange={set("voiceSoundboardPreferredSoundIds")}
                />
              </>
            )}

            <label htmlFor="voice-allowed-channels">Allowed voice channel IDs (optional)</label>
            <textarea
              id="voice-allowed-channels"
              rows="3"
              value={form.voiceAllowedChannelIds}
              onChange={set("voiceAllowedChannelIds")}
            />

            <label htmlFor="voice-blocked-channels">Blocked voice channel IDs</label>
            <textarea
              id="voice-blocked-channels"
              rows="3"
              value={form.voiceBlockedChannelIds}
              onChange={set("voiceBlockedChannelIds")}
            />

            <label htmlFor="voice-blocked-users">Blocked voice user IDs</label>
            <textarea
              id="voice-blocked-users"
              rows="3"
              value={form.voiceBlockedUserIds}
              onChange={set("voiceBlockedUserIds")}
            />
          </>
        )}
      </Section>

      {/* -------- RATE LIMITS -------- */}
      <Section title="Rate Limits">
        <div className="split-3">
          <div>
            <label htmlFor="max-messages">Max bot messages/hour</label>
            <input
              id="max-messages"
              type="number"
              min="1"
              max="200"
              value={form.maxMessages}
              onChange={set("maxMessages")}
            />
          </div>
          <div>
            <label htmlFor="max-reactions">Max reactions/hour</label>
            <input
              id="max-reactions"
              type="number"
              min="1"
              max="300"
              value={form.maxReactions}
              onChange={set("maxReactions")}
            />
          </div>
          <div>
            <label htmlFor="min-gap">Min seconds between bot msgs</label>
            <input
              id="min-gap"
              type="number"
              min="5"
              max="300"
              value={form.minGap}
              onChange={set("minGap")}
            />
          </div>
        </div>
      </Section>

      {/* -------- STARTUP CATCH-UP -------- */}
      <Section title="Startup Catch-up" active={form.catchupEnabled}>
        <div className="toggles">
          <label>
            <input type="checkbox" checked={form.catchupEnabled} onChange={set("catchupEnabled")} />
            Catch up on recent messages at startup
          </label>
        </div>

        {form.catchupEnabled && (
          <div className="split-3">
            <div>
              <label htmlFor="catchup-lookback">Catch-up lookback (hours)</label>
              <input
                id="catchup-lookback"
                type="number"
                min="1"
                max="24"
                value={form.catchupLookbackHours}
                onChange={set("catchupLookbackHours")}
              />
            </div>
            <div>
              <label htmlFor="catchup-max-messages">Messages scanned per channel</label>
              <input
                id="catchup-max-messages"
                type="number"
                min="5"
                max="80"
                value={form.catchupMaxMessages}
                onChange={set("catchupMaxMessages")}
              />
            </div>
            <div>
              <label htmlFor="catchup-max-replies">Max startup replies per channel</label>
              <input
                id="catchup-max-replies"
                type="number"
                min="1"
                max="12"
                value={form.catchupMaxReplies}
                onChange={set("catchupMaxReplies")}
              />
            </div>
          </div>
        )}
      </Section>

      {/* -------- INITIATIVE POSTS & MEDIA -------- */}
      <Section title="Initiative Posts & Media" active={form.autonomousInitiativeEnabled}>
        <div className="toggles">
          <label>
            <input
              type="checkbox"
              checked={form.autonomousInitiativeEnabled}
              onChange={set("autonomousInitiativeEnabled")}
            />
            Enable autonomous posting
          </label>
          {showInitiativeAdvanced && (
            <label>
              <input
                type="checkbox"
                checked={form.initiativeStartupPost}
                onChange={set("initiativeStartupPost")}
              />
              Post on startup when due
            </label>
          )}
          {showInitiativeAdvanced && (
            <label>
              <input
                type="checkbox"
                checked={form.initiativeImageEnabled}
                onChange={set("initiativeImageEnabled")}
              />
              Allow image posts
            </label>
          )}
          {showInitiativeAdvanced && (
            <label>
              <input
                type="checkbox"
                checked={form.initiativeVideoEnabled}
                onChange={set("initiativeVideoEnabled")}
              />
              Allow video posts
            </label>
          )}
          <label>
            <input
              type="checkbox"
              checked={form.replyImageEnabled}
              onChange={set("replyImageEnabled")}
            />
            Allow images in regular replies
          </label>
          <label>
            <input
              type="checkbox"
              checked={form.replyVideoEnabled}
              onChange={set("replyVideoEnabled")}
            />
            Allow videos in regular replies
          </label>
          <label>
            <input
              type="checkbox"
              checked={form.replyGifEnabled}
              onChange={set("replyGifEnabled")}
            />
            Allow GIFs in regular replies
          </label>
        </div>

        {showInitiativeAdvanced && (
          <>
            <div className="split">
              <div>
                <label htmlFor="initiative-posts-per-day">Max initiative posts/day</label>
                <input
                  id="initiative-posts-per-day"
                  type="number"
                  min="0"
                  max="100"
                  value={form.initiativePostsPerDay}
                  onChange={set("initiativePostsPerDay")}
                />
              </div>
              <div>
                <label htmlFor="initiative-min-minutes">Min minutes between initiative posts</label>
                <input
                  id="initiative-min-minutes"
                  type="number"
                  min="5"
                  max="1440"
                  value={form.initiativeMinMinutes}
                  onChange={set("initiativeMinMinutes")}
                />
              </div>
            </div>

            <div className="split">
              <div>
                <label htmlFor="initiative-pacing-mode">Initiative pacing mode</label>
                <select
                  id="initiative-pacing-mode"
                  value={form.initiativePacingMode}
                  onChange={set("initiativePacingMode")}
                >
                  <option value="even">Even pacing (strict)</option>
                  <option value="spontaneous">Spontaneous (randomized)</option>
                </select>
              </div>
              <div>
                <label htmlFor="initiative-spontaneity">
                  Spontaneity: <strong>{form.initiativeSpontaneity}%</strong>
                </label>
                <input
                  id="initiative-spontaneity"
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={form.initiativeSpontaneity}
                  onChange={set("initiativeSpontaneity")}
                />
              </div>
            </div>
          </>
        )}

        {showInitiativeImageControls && (
          <>
            <div className="split">
              <div>
                <label htmlFor="max-images-per-day">Max generated images/24h</label>
                <input
                  id="max-images-per-day"
                  type="number"
                  min="0"
                  max="200"
                  value={form.maxImagesPerDay}
                  onChange={set("maxImagesPerDay")}
                />
              </div>
              <div>
                <label htmlFor="initiative-simple-image-model">Simple image model</label>
                <input
                  id="initiative-simple-image-model"
                  type="text"
                  value={form.initiativeSimpleImageModel}
                  onChange={set("initiativeSimpleImageModel")}
                />
              </div>
            </div>

            <div className="split">
              <div>
                <label htmlFor="initiative-complex-image-model">Complex image model</label>
                <input
                  id="initiative-complex-image-model"
                  type="text"
                  value={form.initiativeComplexImageModel}
                  onChange={set("initiativeComplexImageModel")}
                />
              </div>
              <div>
                <label htmlFor="initiative-allowed-image-models">Allowed image models (comma/newline list)</label>
                <textarea
                  id="initiative-allowed-image-models"
                  rows="3"
                  value={form.initiativeAllowedImageModels}
                  onChange={set("initiativeAllowedImageModels")}
                />
              </div>
            </div>
          </>
        )}

        {showInitiativeVideoControls && (
          <div className="split">
            <div>
              <label htmlFor="max-videos-per-day">Max generated videos/24h</label>
              <input
                id="max-videos-per-day"
                type="number"
                min="0"
                max="120"
                value={form.maxVideosPerDay}
                onChange={set("maxVideosPerDay")}
              />
            </div>
            <div>
              <label htmlFor="initiative-video-model">Video model</label>
              <input
                id="initiative-video-model"
                type="text"
                value={form.initiativeVideoModel}
                onChange={set("initiativeVideoModel")}
              />
            </div>
          </div>
        )}

        {showInitiativeVideoControls && (
          <>
            <label htmlFor="initiative-allowed-video-models">Allowed video models (comma/newline list)</label>
            <textarea
              id="initiative-allowed-video-models"
              rows="3"
              value={form.initiativeAllowedVideoModels}
              onChange={set("initiativeAllowedVideoModels")}
            />
          </>
        )}

        {form.replyGifEnabled && (
          <div className="split">
            <div>
              <label htmlFor="max-gifs-per-day">Max GIF lookups/24h</label>
              <input
                id="max-gifs-per-day"
                type="number"
                min="0"
                max="300"
                value={form.maxGifsPerDay}
                onChange={set("maxGifsPerDay")}
              />
            </div>
            <div />
          </div>
        )}

        {/* -- Creative Discovery (sub-section) -- */}
        {showInitiativeAdvanced && (
          <>
            <h4>Creative Discovery</h4>
            <div className="toggles">
              <label>
                <input
                  type="checkbox"
                  checked={form.initiativeDiscoveryEnabled}
                  onChange={set("initiativeDiscoveryEnabled")}
                />
                Enable external discovery for initiative posts
              </label>
              {form.initiativeDiscoveryEnabled && (
                <label>
                  <input
                    type="checkbox"
                    checked={form.initiativeDiscoveryAllowNsfw}
                    onChange={set("initiativeDiscoveryAllowNsfw")}
                  />
                  Allow NSFW discovery items
                </label>
              )}
            </div>

            {form.initiativeDiscoveryEnabled && (
              <>
                <div className="split">
                  <div>
                    <label htmlFor="initiative-discovery-link-chance">Posts with links (%)</label>
                    <input
                      id="initiative-discovery-link-chance"
                      type="number"
                      min="0"
                      max="100"
                      value={form.initiativeDiscoveryLinkChance}
                      onChange={set("initiativeDiscoveryLinkChance")}
                    />
                  </div>
                  <div>
                    <label htmlFor="initiative-discovery-max-links">Max links per post</label>
                    <input
                      id="initiative-discovery-max-links"
                      type="number"
                      min="1"
                      max="4"
                      value={form.initiativeDiscoveryMaxLinks}
                      onChange={set("initiativeDiscoveryMaxLinks")}
                    />
                  </div>
                </div>

                <div className="split">
                  <div>
                    <label htmlFor="initiative-discovery-max-candidates">Candidates for prompt</label>
                    <input
                      id="initiative-discovery-max-candidates"
                      type="number"
                      min="1"
                      max="12"
                      value={form.initiativeDiscoveryMaxCandidates}
                      onChange={set("initiativeDiscoveryMaxCandidates")}
                    />
                  </div>
                  <div>
                    <label htmlFor="initiative-discovery-fetch-limit">Fetch limit per source</label>
                    <input
                      id="initiative-discovery-fetch-limit"
                      type="number"
                      min="2"
                      max="30"
                      value={form.initiativeDiscoveryFetchLimit}
                      onChange={set("initiativeDiscoveryFetchLimit")}
                    />
                  </div>
                </div>

                <div className="split">
                  <div>
                    <label htmlFor="initiative-discovery-freshness">Freshness window (hours)</label>
                    <input
                      id="initiative-discovery-freshness"
                      type="number"
                      min="1"
                      max="336"
                      value={form.initiativeDiscoveryFreshnessHours}
                      onChange={set("initiativeDiscoveryFreshnessHours")}
                    />
                  </div>
                  <div>
                    <label htmlFor="initiative-discovery-dedupe">Avoid repost window (hours)</label>
                    <input
                      id="initiative-discovery-dedupe"
                      type="number"
                      min="1"
                      max="1080"
                      value={form.initiativeDiscoveryDedupeHours}
                      onChange={set("initiativeDiscoveryDedupeHours")}
                    />
                  </div>
                </div>

                <label htmlFor="initiative-discovery-randomness">
                  Discovery randomness: <strong>{form.initiativeDiscoveryRandomness}%</strong>
                </label>
                <input
                  id="initiative-discovery-randomness"
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={form.initiativeDiscoveryRandomness}
                  onChange={set("initiativeDiscoveryRandomness")}
                />

                <div className="toggles">
                  <label>
                    <input
                      type="checkbox"
                      checked={form.initiativeDiscoverySourceReddit}
                      onChange={set("initiativeDiscoverySourceReddit")}
                    />
                    Reddit
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={form.initiativeDiscoverySourceHackerNews}
                      onChange={set("initiativeDiscoverySourceHackerNews")}
                    />
                    Hacker News
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={form.initiativeDiscoverySourceYoutube}
                      onChange={set("initiativeDiscoverySourceYoutube")}
                    />
                    YouTube RSS
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={form.initiativeDiscoverySourceRss}
                      onChange={set("initiativeDiscoverySourceRss")}
                    />
                    RSS feeds
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={form.initiativeDiscoverySourceX}
                      onChange={set("initiativeDiscoverySourceX")}
                    />
                    X via Nitter RSS
                  </label>
                </div>

                <label htmlFor="initiative-discovery-topics">Preferred topics (comma/newline)</label>
                <textarea
                  id="initiative-discovery-topics"
                  rows="2"
                  value={form.initiativeDiscoveryPreferredTopics}
                  onChange={set("initiativeDiscoveryPreferredTopics")}
                />

                {form.initiativeDiscoverySourceReddit && (
                  <>
                    <label htmlFor="initiative-discovery-reddit">Reddit subreddits</label>
                    <textarea
                      id="initiative-discovery-reddit"
                      rows="2"
                      value={form.initiativeDiscoveryRedditSubs}
                      onChange={set("initiativeDiscoveryRedditSubs")}
                    />
                  </>
                )}

                {form.initiativeDiscoverySourceYoutube && (
                  <>
                    <label htmlFor="initiative-discovery-youtube">YouTube channel IDs</label>
                    <textarea
                      id="initiative-discovery-youtube"
                      rows="2"
                      value={form.initiativeDiscoveryYoutubeChannels}
                      onChange={set("initiativeDiscoveryYoutubeChannels")}
                    />
                  </>
                )}

                {form.initiativeDiscoverySourceRss && (
                  <>
                    <label htmlFor="initiative-discovery-rss">RSS feed URLs</label>
                    <textarea
                      id="initiative-discovery-rss"
                      rows="3"
                      value={form.initiativeDiscoveryRssFeeds}
                      onChange={set("initiativeDiscoveryRssFeeds")}
                    />
                  </>
                )}

                {form.initiativeDiscoverySourceX && (
                  <>
                    <label htmlFor="initiative-discovery-x-handles">X handles</label>
                    <textarea
                      id="initiative-discovery-x-handles"
                      rows="2"
                      value={form.initiativeDiscoveryXHandles}
                      onChange={set("initiativeDiscoveryXHandles")}
                    />

                    <label htmlFor="initiative-discovery-nitter">Nitter base URL (for X RSS)</label>
                    <input
                      id="initiative-discovery-nitter"
                      type="text"
                      value={form.initiativeDiscoveryXNitterBase}
                      onChange={set("initiativeDiscoveryXNitterBase")}
                    />
                  </>
                )}
              </>
            )}
          </>
        )}
      </Section>

      {/* -------- CHANNELS & PERMISSIONS -------- */}
      <Section title="Channels & Permissions">
        <label htmlFor="initiative-channels">Standalone post channel IDs (only these)</label>
        <textarea
          id="initiative-channels"
          rows="2"
          value={form.initiativeChannels}
          onChange={set("initiativeChannels")}
        />

        <label htmlFor="allowed-channels">Allowed channel IDs (comma/newline)</label>
        <textarea
          id="allowed-channels"
          rows="3"
          value={form.allowedChannels}
          onChange={set("allowedChannels")}
        />

        <label htmlFor="blocked-channels">Blocked channel IDs (comma/newline)</label>
        <textarea
          id="blocked-channels"
          rows="3"
          value={form.blockedChannels}
          onChange={set("blockedChannels")}
        />

        <label htmlFor="blocked-users">Blocked user IDs (comma/newline)</label>
        <textarea
          id="blocked-users"
          rows="3"
          value={form.blockedUsers}
          onChange={set("blockedUsers")}
        />
      </Section>

      {/* -------- STICKY SAVE BAR -------- */}
      <div className="save-bar">
        <button type="submit" className="cta">Save settings</button>
        {toast.text && (
          <p className={`status-msg ${toast.type}`}>{toast.text}</p>
        )}
      </div>
    </form>
  );
}
