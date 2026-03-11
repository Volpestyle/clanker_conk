import { type SlashCommandBuilder, type SlashCommandSubcommandsOnlyBuilder } from "discord.js";

export function addBrowseSubcommand(
  command: SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder
) {
  return command.addSubcommand((subcommand) =>
    subcommand
      .setName("browse")
      .setDescription("Command the browser agent to navigate the web and extract info")
      .addStringOption((option) =>
        option
          .setName("task")
          .setDescription("The instruction for the agent")
          .setRequired(true)
      )
  );
}
