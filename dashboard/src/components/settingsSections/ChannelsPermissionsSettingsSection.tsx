import React from "react";
import { SettingsSection } from "../SettingsSection";

export function ChannelsPermissionsSettingsSection({ id, form, set }) {
  return (
    <SettingsSection id={id} title="Channels & Permissions">
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
    </SettingsSection>
  );
}
