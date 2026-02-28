import React, { useState, useEffect, useRef, useCallback } from "react";
import { api } from "../../api";

type ElevenLabsVoice = {
  voice_id: string;
  name: string;
  category: string;
  description?: string;
  labels?: Record<string, string>;
  preview_url?: string;
};

type CloneFile = {
  name: string;
  dataBase64: string;
  mimeType: string;
  sizeMb: string;
};

const ACCEPTED_AUDIO_TYPES = ".mp3,.wav,.m4a,.flac,.ogg,.oga,.aac";
const MAX_FILES = 8;

export function ElevenLabsVoiceManager({
  selectedVoiceId,
  onSelectVoice
}: {
  selectedVoiceId: string;
  onSelectVoice: (voiceId: string) => void;
}) {
  const [voices, setVoices] = useState<ElevenLabsVoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneName, setCloneName] = useState("");
  const [cloneDescription, setCloneDescription] = useState("");
  const [cloneFiles, setCloneFiles] = useState<CloneFile[]>([]);
  const [removeNoise, setRemoveNoise] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [cloneStatus, setCloneStatus] = useState("");
  const [deletingId, setDeletingId] = useState("");
  const [previewingId, setPreviewingId] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const fetchVoices = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api<{ voices: ElevenLabsVoice[] }>("/api/elevenlabs/voices");
      setVoices(data.voices || []);
    } catch (err: any) {
      setError(err?.message || "Failed to load voices");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchVoices();
  }, [fetchVoices]);

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const fileList = e.target.files;
    if (!fileList) return;
    const newFiles = Array.from(fileList).slice(0, MAX_FILES - cloneFiles.length);
    for (const file of newFiles) {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(",")[1] || "";
        setCloneFiles((prev) => {
          if (prev.length >= MAX_FILES) return prev;
          return [
            ...prev,
            {
              name: file.name,
              dataBase64: base64,
              mimeType: file.type || "audio/mpeg",
              sizeMb: (file.size / 1024 / 1024).toFixed(1)
            }
          ];
        });
      };
      reader.readAsDataURL(file);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeFile(index: number) {
    setCloneFiles((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleClone(e: React.FormEvent) {
    e.preventDefault();
    if (!cloneName.trim() || cloneFiles.length === 0) return;
    setCloning(true);
    setCloneStatus("");
    try {
      const result = await api<{ voice_id: string }>("/api/elevenlabs/voices", {
        method: "POST",
        body: {
          name: cloneName.trim(),
          description: cloneDescription.trim() || undefined,
          removeBackgroundNoise: removeNoise,
          files: cloneFiles.map((f) => ({
            name: f.name,
            dataBase64: f.dataBase64,
            mimeType: f.mimeType
          }))
        }
      });
      setCloneStatus(`Voice cloned! ID: ${result.voice_id}`);
      setCloneName("");
      setCloneDescription("");
      setCloneFiles([]);
      setRemoveNoise(false);
      onSelectVoice(result.voice_id);
      await fetchVoices();
    } catch (err: any) {
      setCloneStatus(`Clone failed: ${err?.message || "Unknown error"}`);
    } finally {
      setCloning(false);
    }
  }

  async function handleDelete(voiceId: string, voiceName: string) {
    if (!confirm(`Delete voice "${voiceName}"? This cannot be undone.`)) return;
    setDeletingId(voiceId);
    try {
      await api(`/api/elevenlabs/voices/${voiceId}`, { method: "DELETE" });
      if (selectedVoiceId === voiceId) onSelectVoice("");
      await fetchVoices();
    } catch (err: any) {
      setError(`Delete failed: ${err?.message || "Unknown error"}`);
    } finally {
      setDeletingId("");
    }
  }

  function handlePreview(voice: ElevenLabsVoice) {
    if (!voice.preview_url) return;
    if (previewingId === voice.voice_id) {
      audioRef.current?.pause();
      setPreviewingId("");
      return;
    }
    if (audioRef.current) {
      audioRef.current.pause();
    }
    const audio = new Audio(voice.preview_url);
    audio.onended = () => setPreviewingId("");
    audio.play().catch(() => {});
    audioRef.current = audio;
    setPreviewingId(voice.voice_id);
  }

  const clonedVoices = voices.filter((v) => v.category === "cloned");
  const otherVoices = voices.filter((v) => v.category !== "cloned");

  return (
    <div className="el-voice-manager">
      <div className="el-voice-select-row">
        <label htmlFor="el-voice-select">ElevenLabs voice</label>
        <select
          id="el-voice-select"
          value={selectedVoiceId}
          onChange={(e) => onSelectVoice(e.target.value)}
          disabled={loading}
        >
          <option value="">-- Select a voice --</option>
          {clonedVoices.length > 0 && (
            <optgroup label="Your cloned voices">
              {clonedVoices.map((v) => (
                <option key={v.voice_id} value={v.voice_id}>
                  {v.name}
                </option>
              ))}
            </optgroup>
          )}
          {otherVoices.length > 0 && (
            <optgroup label="Library voices">
              {otherVoices.map((v) => (
                <option key={v.voice_id} value={v.voice_id}>
                  {v.name} ({v.category})
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <button type="button" className="sm" onClick={fetchVoices} disabled={loading}>
          {loading ? "..." : "Refresh"}
        </button>
      </div>

      {error && <p className="el-error">{error}</p>}

      <details className="el-clone-section" open={cloneOpen} onToggle={(e) => setCloneOpen((e.target as any).open)}>
        <summary>Clone a new voice</summary>

        <form className="el-clone-form" onSubmit={handleClone}>
          <div className="split">
            <div>
              <label htmlFor="el-clone-name">Voice name</label>
              <input
                id="el-clone-name"
                type="text"
                value={cloneName}
                onChange={(e) => setCloneName(e.target.value)}
                placeholder="My Custom Voice"
                maxLength={100}
                required
              />
            </div>
            <div>
              <label htmlFor="el-clone-description">Description (optional)</label>
              <input
                id="el-clone-description"
                type="text"
                value={cloneDescription}
                onChange={(e) => setCloneDescription(e.target.value)}
                placeholder="A warm, friendly voice"
                maxLength={200}
              />
            </div>
          </div>

          <label>Audio samples (1-2 min of clear speech recommended)</label>
          <div className="el-file-drop-zone" onClick={() => fileInputRef.current?.click()}>
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_AUDIO_TYPES}
              multiple
              onChange={handleFileSelect}
              style={{ display: "none" }}
            />
            <span className="el-file-drop-text">
              Click to add audio files (MP3, WAV, M4A, FLAC, OGG)
            </span>
          </div>

          {cloneFiles.length > 0 && (
            <ul className="el-file-list">
              {cloneFiles.map((f, i) => (
                <li key={i}>
                  <span className="el-file-name">{f.name}</span>
                  <span className="el-file-size">{f.sizeMb} MB</span>
                  <button type="button" className="sm el-file-remove" onClick={() => removeFile(i)}>
                    remove
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="toggles">
            <label>
              <input
                type="checkbox"
                checked={removeNoise}
                onChange={(e) => setRemoveNoise(e.target.checked)}
              />
              Remove background noise from samples
            </label>
          </div>

          <button type="submit" className="sm el-clone-btn" disabled={cloning || !cloneName.trim() || cloneFiles.length === 0}>
            {cloning ? "Cloning..." : "Clone voice"}
          </button>

          {cloneStatus && (
            <p className={`el-clone-status ${cloneStatus.startsWith("Clone failed") ? "error" : "success"}`}>
              {cloneStatus}
            </p>
          )}
        </form>
      </details>

      {clonedVoices.length > 0 && (
        <details className="el-cloned-list-section">
          <summary>Manage cloned voices ({clonedVoices.length})</summary>
          <ul className="el-voice-list">
            {clonedVoices.map((v) => (
              <li key={v.voice_id} className={selectedVoiceId === v.voice_id ? "selected" : ""}>
                <div className="el-voice-info">
                  <strong>{v.name}</strong>
                  {v.description && <span className="el-voice-desc">{v.description}</span>}
                  <code className="el-voice-id">{v.voice_id}</code>
                </div>
                <div className="el-voice-actions">
                  {v.preview_url && (
                    <button
                      type="button"
                      className="sm"
                      onClick={() => handlePreview(v)}
                    >
                      {previewingId === v.voice_id ? "Stop" : "Preview"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="sm"
                    onClick={() => onSelectVoice(v.voice_id)}
                  >
                    Use
                  </button>
                  <button
                    type="button"
                    className="sm el-delete-btn"
                    disabled={deletingId === v.voice_id}
                    onClick={() => handleDelete(v.voice_id, v.name)}
                  >
                    {deletingId === v.voice_id ? "..." : "Delete"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
