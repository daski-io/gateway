import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const names = ["setup.md", "buy.md", "orders.md", "wallets.md", "recipe.md", "SKILL.md"];
const directory = resolve(process.cwd(), "dist/skills");
await mkdir(directory, { recursive: true });
const contents = await Promise.all(names.map((name) => readFile(resolve(directory, name), "utf8")));
await writeFile(
  resolve(directory, "llms-full.txt"),
  contents.map((content) => content.trimEnd()).join("\n\n") + "\n",
  "utf8",
);
