import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

export const SKILL_TOPICS = ["setup", "buy", "orders", "wallets", "recipe"] as const;
export type SkillTopic = typeof SKILL_TOPICS[number];

const INDEX_FILES = [
  ...SKILL_TOPICS.map((name) => ({ name, file: `${name}.md` })),
  { name: "daski", file: "SKILL.md" },
] as const;

let rootPromise: Promise<string> | null = null;

async function skillRoot(): Promise<string> {
  rootPromise ??= (async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [resolve(here, "../skills"), resolve(here, "../../skills")];
    for (const candidate of candidates) {
      try {
        await access(join(candidate, "setup.md"));
        return candidate;
      } catch {
        // Continue to the development/production alternate.
      }
    }
    throw new Error("Bundled Daski skills are unavailable");
  })();
  return rootPromise;
}

export async function readSkill(topic: SkillTopic | "daski") {
  const entry = INDEX_FILES.find((candidate) => candidate.name === topic);
  if (!entry) throw new Error("Unknown Daski skill topic");
  const content = await readFile(join(await skillRoot(), entry.file), "utf8");
  return {
    name: entry.name,
    file: entry.file,
    content,
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: Buffer.byteLength(content),
  };
}

export async function skillIndex(publicUrl: string, version: string) {
  const skills = await Promise.all(INDEX_FILES.map(async ({ name }) => {
    const skill = await readSkill(name);
    return {
      name,
      url: `${publicUrl.replace(/\/$/, "")}/skills/${skill.file}`,
      sha256: skill.sha256,
      bytes: skill.bytes,
    };
  }));
  return { version, skills };
}

export async function llmsFull(): Promise<string> {
  const root = await skillRoot();
  try {
    return await readFile(join(root, "llms-full.txt"), "utf8");
  } catch {
    const skills = await Promise.all(INDEX_FILES.map(({ name }) => readSkill(name)));
    return skills.map((skill) => skill.content.trimEnd()).join("\n\n") + "\n";
  }
}

export function llmsIndex(publicUrl: string, mcpPath = "/mcp"): string {
  const root = publicUrl.replace(/\/$/, "");
  return [
    "# Daski",
    "",
    "Daski is an outcome marketplace using standard x402 Exact-EVM payments and payer-authorized lifecycle access.",
    "",
    `Setup: curl -fsSL ${root}/skills/setup.md`,
    `MCP: ${root}${mcpPath}`,
    `Installable skill: ${root}/skills/SKILL.md`,
    "",
    ...INDEX_FILES.map(({ file }) => `- ${root}/skills/${file}`),
    "",
  ].join("\n");
}

/** The installable skill's frontmatter `description`, for the legacy well-known index. */
export function skillFrontmatterDescription(content: string): string {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return "Daski buyer skill";
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") break;
    const match = /^description:\s*(.+?)\s*$/.exec(line);
    if (match?.[1]) return match[1];
  }
  return "Daski buyer skill";
}

/**
 * Legacy `/.well-known/skills/index.json` (pre-0.2.0 discovery, consumed by the
 * `skills` CLI as its fallback): one installable skill, `daski`, whose only
 * file is `SKILL.md`. The topic guides are references that skill fetches by
 * URL, not skills of their own, so they are deliberately not listed here.
 */
export async function legacySkillIndex(): Promise<{
  skills: Array<{ name: string; description: string; files: string[] }>;
}> {
  const skill = await readSkill("daski");
  return {
    skills: [{
      name: "daski",
      description: skillFrontmatterDescription(skill.content),
      files: ["SKILL.md"],
    }],
  };
}
