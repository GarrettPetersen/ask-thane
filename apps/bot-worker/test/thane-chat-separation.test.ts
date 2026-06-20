import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return listSourceFiles(path);
      }
      return entry.isFile() && path.endsWith(".ts") ? [path] : [];
    })
  );
  return files.flat();
}

describe("Thane Chat integration boundary", () => {
  it("keeps Ask Thane chat reads and writes behind the hosted app/webhook surface", async () => {
    const sourceRoot = new URL("../src", import.meta.url).pathname;
    const files = await listSourceFiles(sourceRoot);
    const violations: string[] = [];
    const disallowedPatterns = [
      /thane_cli_chat_messages/i,
      /thane_cli_message_reactions/i,
      /INSERT\s+INTO\s+thane_cli_channels/i,
      /INSERT\s+OR\s+IGNORE\s+INTO\s+thane_cli_channel_members/i
    ];

    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const pattern of disallowedPatterns) {
        if (pattern.test(text)) {
          violations.push(`${relative(sourceRoot, file)} matches ${pattern}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
