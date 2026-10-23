import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import iconv from "iconv-lite";

const rootDir = process.cwd();
const replacementChar = String.fromCharCode(0xfffd);
const ignoredDirectories = new Set([
  ".git",
  "archive",
  ".claude",
  "data",
  "dist",
  "node_modules",
  "ollama"
]);
const scannedExtensions = new Set([
  "",
  ".env",
  ".example",
  ".json",
  ".md",
  ".mjs",
  ".ps1",
  ".ts",
  ".yaml",
  ".yml"
]);

const chineseTerms = [
  "\u6211\u662f",
  "\u5ba1\u67e5",
  "\u5ba1\u6838",
  "\u5408\u540c",
  "\u673a\u5668\u4eba",
  "\u8d1f\u8d23\u4eba",
  "\u4fee\u6539",
  "\u590d\u5ba1",
  "\u5e2e\u52a9",
  "\u8c03\u8bd5",
  "\u600e\u4e48",
  "\u98ce\u9669",
  "\u5efa\u8bae",
  "\u5546\u52a1",
  "\u8fd0\u8425",
  "\u6cd5\u52a1",
  "\u8d22\u52a1"
];
const mojibakeMarkers = Array.from(
  new Set(
    chineseTerms
      .map((term) => iconv.decode(Buffer.from(term, "utf8"), "gb18030"))
      .map((term) => term.replace(/\uFFFD/gu, ""))
      .filter((term) => term.length >= 2)
  )
);

const findings = [];

for (const filePath of walk(rootDir)) {
  const relativePath = path.relative(rootDir, filePath).replace(/\\/gu, "/");
  const fileName = path.basename(filePath);
  if (fileName.endsWith(".log") || fileName.includes(".backup-")) continue;
  if (!shouldScan(filePath, fileName)) continue;

  const text = readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.includes(replacementChar)) {
      findings.push({
        file: relativePath,
        line: index + 1,
        reason: "contains Unicode replacement character U+FFFD"
      });
      continue;
    }
    const marker = mojibakeMarkers.find((candidate) => line.includes(candidate));
    if (marker) {
      findings.push({
        file: relativePath,
        line: index + 1,
        reason: `contains likely mojibake marker ${JSON.stringify(marker)}`
      });
    }
  }
}

if (findings.length > 0) {
  console.error("Encoding check failed. These files contain likely corrupted text:");
  for (const finding of findings.slice(0, 80)) {
    console.error(`- ${finding.file}:${finding.line} ${finding.reason}`);
  }
  if (findings.length > 80) {
    console.error(`... and ${findings.length - 80} more finding(s).`);
  }
  process.exit(1);
}

console.log("Encoding check passed.");

function* walk(directory) {
  for (const entry of readdirSync(directory)) {
    if (ignoredDirectories.has(entry)) continue;
    const entryPath = path.join(directory, entry);
    const stat = statSync(entryPath);
    if (stat.isDirectory()) {
      yield* walk(entryPath);
    } else if (stat.isFile()) {
      yield entryPath;
    }
  }
}

function shouldScan(filePath, fileName) {
  if (fileName === ".env" || fileName === ".env.example") return true;
  const extension = path.extname(filePath);
  return scannedExtensions.has(extension);
}
