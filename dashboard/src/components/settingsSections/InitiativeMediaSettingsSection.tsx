import React from "react";
import { SettingsSection } from "../SettingsSection";
import { rangeStyle } from "../../utils";

export function InitiativeMediaSettingsSection({
  id,
  form,
  set,
  showInitiativeAdvanced,
  showInitiativeImageControls,
  showInitiativeVideoControls,
  initiativeImageModelOptions,
  initiativeVideoModelOptions
}) {
  return (
    <SettingsSection id={id} title="Initiative Posts & Media" active={form.autonomousInitiativeEnabled}>
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
                style={rangeStyle(form.initiativeSpontaneity)}
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
              <select
                id="initiative-simple-image-model"
                value={form.initiativeSimpleImageModel}
                onChange={set("initiativeSimpleImageModel")}
              >
                {initiativeImageModelOptions.map((modelId) => (
                  <option key={modelId} value={modelId}>
                    {modelId}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="split">
            <div>
              <label htmlFor="initiative-complex-image-model">Complex image model</label>
              <select
                id="initiative-complex-image-model"
                value={form.initiativeComplexImageModel}
                onChange={set("initiativeComplexImageModel")}
              >
                {initiativeImageModelOptions.map((modelId) => (
                  <option key={modelId} value={modelId}>
                    {modelId}
                  </option>
                ))}
              </select>
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
            <select
              id="initiative-video-model"
              value={form.initiativeVideoModel}
              onChange={set("initiativeVideoModel")}
            >
              {initiativeVideoModelOptions.map((modelId) => (
                <option key={modelId} value={modelId}>
                  {modelId}
                </option>
              ))}
            </select>
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
                style={rangeStyle(form.initiativeDiscoveryRandomness)}
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
    </SettingsSection>
  );
}
