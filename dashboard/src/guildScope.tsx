import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export interface DashboardGuild {
  id: string;
  name: string;
}

type DashboardGuildScopeValue = {
  guilds: DashboardGuild[];
  selectedGuildId: string;
  selectedGuild: DashboardGuild | null;
  setSelectedGuildId: (guildId: string) => void;
};

const GUILD_STORAGE_KEY = "dashboard_last_guild_id";

const DashboardGuildScopeContext = createContext<DashboardGuildScopeValue | null>(null);

function getStoredDashboardGuildId(): string {
  try {
    return localStorage.getItem(GUILD_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function saveStoredDashboardGuildId(guildId: string) {
  try {
    const normalizedGuildId = String(guildId || "").trim();
    if (normalizedGuildId) {
      localStorage.setItem(GUILD_STORAGE_KEY, normalizedGuildId);
    } else {
      localStorage.removeItem(GUILD_STORAGE_KEY);
    }
  } catch {
    // Ignore localStorage failures so the dashboard stays usable in locked-down browsers.
  }
}

export function DashboardGuildScopeProvider({
  guilds,
  children
}: {
  guilds: DashboardGuild[];
  children: ReactNode;
}) {
  const [selectedGuildId, setSelectedGuildIdState] = useState(() => getStoredDashboardGuildId());

  useEffect(() => {
    if (!guilds.length) {
      setSelectedGuildIdState("");
      return;
    }

    setSelectedGuildIdState((current) => {
      const normalizedCurrent = String(current || "").trim();
      if (normalizedCurrent && guilds.some((guild) => guild.id === normalizedCurrent)) {
        return normalizedCurrent;
      }

      const storedGuildId = getStoredDashboardGuildId();
      if (storedGuildId && guilds.some((guild) => guild.id === storedGuildId)) {
        return storedGuildId;
      }

      const fallbackGuildId = String(guilds[0]?.id || "").trim();
      if (fallbackGuildId) {
        saveStoredDashboardGuildId(fallbackGuildId);
      }
      return fallbackGuildId;
    });
  }, [guilds]);

  const setSelectedGuildId = (guildId: string) => {
    const normalizedGuildId = String(guildId || "").trim();
    setSelectedGuildIdState(normalizedGuildId);
    saveStoredDashboardGuildId(normalizedGuildId);
  };

  const selectedGuild = useMemo(
    () => guilds.find((guild) => guild.id === selectedGuildId) || null,
    [guilds, selectedGuildId]
  );

  const value = useMemo<DashboardGuildScopeValue>(
    () => ({
      guilds,
      selectedGuildId,
      selectedGuild,
      setSelectedGuildId
    }),
    [guilds, selectedGuild, selectedGuildId]
  );

  return (
    <DashboardGuildScopeContext.Provider value={value}>
      {children}
    </DashboardGuildScopeContext.Provider>
  );
}

export function useDashboardGuildScope() {
  const context = useContext(DashboardGuildScopeContext);
  if (!context) {
    throw new Error("useDashboardGuildScope must be used within DashboardGuildScopeProvider");
  }
  return context;
}
