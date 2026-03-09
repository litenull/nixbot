import type { Command } from "./types.js";

export const quitCommand: Command = {
  name: "quit",
  description: "Exit the application",
  matches: (input) => input.startsWith("/quit") || input.startsWith("/exit"),
  execute: async () => {
    return "__QUIT__";
  },
};
