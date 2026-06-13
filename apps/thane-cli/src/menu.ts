import { emitKeypressEvents } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import type { SlashCommand } from "./slash-commands.js";

type Key = {
  name?: string;
  ctrl?: boolean;
};

type KeyHandler = (chunk: string, key: Key) => void;

function renderMenu(commands: SlashCommand[], selectedIndex: number): void {
  output.write("\x1b[2J\x1b[H");
  output.write("Thane commands\n");
  output.write("Use arrow keys, Return to choose, Esc to close.\n\n");
  commands.forEach((command, index) => {
    const pointer = index === selectedIndex ? "> " : "  ";
    output.write(`${pointer}${command.usage.padEnd(28)} ${command.description}\n`);
  });
}

export async function runSlashMenu(commands: SlashCommand[]): Promise<SlashCommand | undefined> {
  if (!input.isTTY || !input.setRawMode) {
    output.write(commands.map((command) => `${command.usage} - ${command.description}`).join("\n"));
    output.write("\n");
    return undefined;
  }

  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();

  let selectedIndex = 0;
  renderMenu(commands, selectedIndex);

  return new Promise((resolve) => {
    const cleanup = (command?: SlashCommand): void => {
      input.setRawMode?.(false);
      input.off("keypress", onKeypress);
      output.write("\x1b[2J\x1b[H");
      resolve(command);
    };

    const onKeypress: KeyHandler = (_chunk, key) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        return;
      }
      if (key.name === "escape") {
        cleanup();
        return;
      }
      if (key.name === "up") {
        selectedIndex = selectedIndex === 0 ? commands.length - 1 : selectedIndex - 1;
        renderMenu(commands, selectedIndex);
        return;
      }
      if (key.name === "down") {
        selectedIndex = selectedIndex === commands.length - 1 ? 0 : selectedIndex + 1;
        renderMenu(commands, selectedIndex);
        return;
      }
      if (key.name === "return") {
        cleanup(commands[selectedIndex]);
      }
    };

    input.on("keypress", onKeypress);
  });
}
