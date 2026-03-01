import { SlashCommandBuilder } from "discord.js";

export const musicCommands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Play music from YouTube or SoundCloud")
    .addStringOption((option) =>
      option
        .setName("query")
        .setDescription("Song name or URL to play")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop currently playing music"),
  new SlashCommandBuilder()
    .setName("pause")
    .setDescription("Pause currently playing music"),
  new SlashCommandBuilder()
    .setName("resume")
    .setDescription("Resume paused music"),
  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Skip to next track in queue")
];
