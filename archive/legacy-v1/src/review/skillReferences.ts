import { readFile } from "node:fs/promises";
import path from "node:path";

export async function loadInlineSkillReferences(
  projectRoot: string,
  references: string[]
): Promise<string> {
  const baseDir = path.join(
    projectRoot,
    ".claude",
    "skills",
    "clinical-contract-review"
  );
  const contents = await Promise.all(
    references.map(async (reference) => {
      const filePath = path.join(baseDir, reference);
      const content = await readFile(filePath, "utf8");
      return `--- ${reference} ---\n${content}`;
    })
  );

  return contents.join("\n\n");
}
