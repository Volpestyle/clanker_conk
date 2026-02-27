import React from "react";
import { CUSTOM_MODEL_OPTION_VALUE } from "../../settingsFormModel";
import { SettingsSection } from "../SettingsSection";
import { rangeStyle } from "../../utils";

export function VoiceModeSettingsSection({
  id,
  form,
  set,
  showVoiceAdvanced,
  isVoiceAgentMode,
  isOpenAiRealtimeMode,
  isGeminiRealtimeMode,
  isSttPipelineMode,
  setVoiceReplyDecisionProvider,
  selectVoiceReplyDecisionPresetModel,
  voiceReplyDecisionModelOptions,
  isVoiceReplyDecisionClaudeCodeProvider,
  selectedVoiceReplyDecisionPresetModel
}) {
  return (
    <SettingsSection id={id} title="Voice Mode" active={form.voiceEnabled}>
      <div className="toggles">
        <label>
          <input type="checkbox" checked={form.voiceEnabled} onChange={set("voiceEnabled")} />
          Enable voice sessions
        </label>
      </div>

      {showVoiceAdvanced && (
        <>
          <label htmlFor="voice-mode">Voice runtime mode</label>
          <select id="voice-mode" value={form.voiceMode} onChange={set("voiceMode")}>
            <option value="voice_agent">Voice agent (xAI realtime low-latency)</option>
            <option value="openai_realtime">OpenAI realtime (low-latency)</option>
            <option value="gemini_realtime">Gemini realtime (audio + stream frames)</option>
            <option value="stt_pipeline">STT pipeline (reuse chat LLM + memory)</option>
          </select>

          <div className="toggles">
            <label>
              <input
                type="checkbox"
                checked={form.voiceAllowNsfwHumor}
                onChange={set("voiceAllowNsfwHumor")}
              />
              Voice: allow adult/NSFW humor (with safety limits)
            </label>
          </div>

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
            Voice reply eagerness (unaddressed turns): <strong>{form.voiceReplyEagerness}%</strong>
          </label>
          <input
            id="voice-reply-eagerness"
            type="range"
            min="0"
            max="100"
            step="1"
            value={form.voiceReplyEagerness}
            onChange={set("voiceReplyEagerness")}
            style={rangeStyle(form.voiceReplyEagerness)}
          />

          <h4>Voice Reply Decider</h4>
          <p>Controls when Clank should chime in during VC.</p>
          <div className="split">
            <div>
              <label htmlFor="voice-reply-decision-provider">Provider</label>
              <select
                id="voice-reply-decision-provider"
                value={form.voiceReplyDecisionLlmProvider}
                onChange={setVoiceReplyDecisionProvider}
              >
                <option value="openai">openai</option>
                <option value="anthropic">anthropic</option>
                <option value="xai">xai (grok)</option>
                <option value="claude-code">claude code (local)</option>
              </select>
            </div>
            <div>
              <label htmlFor="voice-reply-decision-model-preset">Model Preset</label>
              <select
                id="voice-reply-decision-model-preset"
                value={selectedVoiceReplyDecisionPresetModel}
                onChange={selectVoiceReplyDecisionPresetModel}
              >
                {voiceReplyDecisionModelOptions.map((modelId) => (
                  <option key={modelId} value={modelId}>
                    {modelId}
                  </option>
                ))}
                {!isVoiceReplyDecisionClaudeCodeProvider && (
                  <option value={CUSTOM_MODEL_OPTION_VALUE}>custom model (manual)</option>
                )}
              </select>
            </div>
          </div>
          <label htmlFor="voice-reply-decision-model">Model ID</label>
          <input
            id="voice-reply-decision-model"
            type="text"
            value={form.voiceReplyDecisionLlmModel}
            onChange={set("voiceReplyDecisionLlmModel")}
            disabled={isVoiceReplyDecisionClaudeCodeProvider}
          />

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
            </>
          )}

          {isGeminiRealtimeMode && (
            <>
              <div className="split">
                <div>
                  <label htmlFor="voice-gemini-realtime-model">Gemini realtime model</label>
                  <input
                    id="voice-gemini-realtime-model"
                    type="text"
                    value={form.voiceGeminiRealtimeModel}
                    onChange={set("voiceGeminiRealtimeModel")}
                  />
                </div>
                <div>
                  <label htmlFor="voice-gemini-realtime-voice">Gemini realtime voice</label>
                  <input
                    id="voice-gemini-realtime-voice"
                    type="text"
                    value={form.voiceGeminiRealtimeVoice}
                    onChange={set("voiceGeminiRealtimeVoice")}
                  />
                </div>
              </div>

              <div className="split">
                <div>
                  <label htmlFor="voice-gemini-realtime-api-base-url">Gemini API base URL</label>
                  <input
                    id="voice-gemini-realtime-api-base-url"
                    type="text"
                    value={form.voiceGeminiRealtimeApiBaseUrl}
                    onChange={set("voiceGeminiRealtimeApiBaseUrl")}
                  />
                </div>
                <div />
              </div>

              <div className="split">
                <div>
                  <label htmlFor="voice-gemini-realtime-input-sample-rate">Gemini input sample rate (Hz)</label>
                  <input
                    id="voice-gemini-realtime-input-sample-rate"
                    type="number"
                    min="8000"
                    max="48000"
                    value={form.voiceGeminiRealtimeInputSampleRateHz}
                    onChange={set("voiceGeminiRealtimeInputSampleRateHz")}
                  />
                </div>
                <div>
                  <label htmlFor="voice-gemini-realtime-output-sample-rate">Gemini output sample rate (Hz)</label>
                  <input
                    id="voice-gemini-realtime-output-sample-rate"
                    type="number"
                    min="8000"
                    max="48000"
                    value={form.voiceGeminiRealtimeOutputSampleRateHz}
                    onChange={set("voiceGeminiRealtimeOutputSampleRateHz")}
                  />
                </div>
              </div>
            </>
          )}

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

          <h4>Stream Watch</h4>
          <div className="toggles">
            <label>
              <input
                type="checkbox"
                checked={form.voiceStreamWatchEnabled}
                onChange={set("voiceStreamWatchEnabled")}
              />
              Enable stream frame ingest + commentary
            </label>
          </div>

          {form.voiceStreamWatchEnabled && (
            <div className="split">
              <div>
                <label htmlFor="voice-stream-watch-commentary-interval">
                  Min seconds between stream commentary turns
                </label>
                <input
                  id="voice-stream-watch-commentary-interval"
                  type="number"
                  min="3"
                  max="120"
                  value={form.voiceStreamWatchMinCommentaryIntervalSeconds}
                  onChange={set("voiceStreamWatchMinCommentaryIntervalSeconds")}
                />
              </div>
              <div>
                <label htmlFor="voice-stream-watch-max-fpm">Max ingested stream frames/min</label>
                <input
                  id="voice-stream-watch-max-fpm"
                  type="number"
                  min="6"
                  max="600"
                  value={form.voiceStreamWatchMaxFramesPerMinute}
                  onChange={set("voiceStreamWatchMaxFramesPerMinute")}
                />
              </div>
            </div>
          )}

          {form.voiceStreamWatchEnabled && (
            <div className="split">
              <div>
                <label htmlFor="voice-stream-watch-max-frame-bytes">Max stream frame bytes</label>
                <input
                  id="voice-stream-watch-max-frame-bytes"
                  type="number"
                  min="50000"
                  max="4000000"
                  value={form.voiceStreamWatchMaxFrameBytes}
                  onChange={set("voiceStreamWatchMaxFrameBytes")}
                />
              </div>
              <div />
            </div>
          )}

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
    </SettingsSection>
  );
}
