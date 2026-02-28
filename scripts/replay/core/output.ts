import type { TurnSnapshot } from "./types.ts";
import { truncateText } from "./utils.ts";

export function printTurnSnapshots(snapshots: TurnSnapshot[], limit: number) {
  const boundedLimit = Math.max(0, Math.floor(limit) || 0);
  if (!snapshots.length || boundedLimit === 0) return;
  console.log(
    `turnSnapshots count=${snapshots.length} showing=${Math.min(
      boundedLimit,
      snapshots.length
    )}`
  );
  console.log("idx | time | mode | addr | try | decision | user | bot");
  for (const snapshot of snapshots.slice(0, boundedLimit)) {
    const time = String(snapshot.createdAt || "").slice(11, 19);
    const mode = snapshot.channelMode === "initiative" ? "init" : "non-init";
    const addr = snapshot.addressed ? "Y" : "N";
    const attempt = snapshot.attempted ? "Y" : "N";
    const decision = truncateText(snapshot.decisionKind, 14);
    const user = truncateText(`${snapshot.authorName}: ${snapshot.userContent}`, 54);
    const bot = snapshot.botContent ? truncateText(snapshot.botContent, 46) : "-";
    console.log(
      `${String(snapshot.index).padStart(2, "0")} | ${time} | ${mode} | ${addr} | ${attempt} | ${decision} | ${user} | ${bot}`
    );
  }
  if (snapshots.length > boundedLimit) {
    console.log(`... truncated ${snapshots.length - boundedLimit} more turn snapshots`);
  }
}

export async function writeJsonReport(outJsonPath: string, payload: unknown) {
  if (!outJsonPath) return false;
  await Bun.write(outJsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`wrote json report -> ${outJsonPath}`);
  return true;
}
