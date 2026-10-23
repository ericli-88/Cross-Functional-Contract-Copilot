import type { ChatContractReviewInput, ContractText } from "../domain/types.js";

function formatWarnings(contract: ContractText): string {
  if (contract.extractionWarnings.length === 0) return "- none";
  return contract.extractionWarnings.map((warning) => `- ${warning}`).join("\n");
}

export function buildReviewPrompt(
  input: ChatContractReviewInput,
  referenceContent: string
): string {
  const profile = input.reviewProfile;
  const contractText = input.contract.text.trim();

  return `Use the clinical-contract-review Skill requirement.

Role: clinical research contract pre-review assistant.

You are reviewing a Feishu collaborative document from a contract review group chat.
The document may have been edited by multiple people. The user explicitly mentioned the bot, so this is an intentional review trigger.

Scope:
- Provide only auxiliary recommendations for human reviewers.
- Provide no final approval/rejection/legal conclusion.
- Review from our/service-provider side, protecting delivery boundaries, payment, liability cap, IP, and termination settlement.
- Only review from the current functional role below. Mention other departments only when escalation or cross-check is required.

Current contract task:
- contractId: ${input.contractId}
- version: V${input.version}
- documentTitle: ${input.documentTitle}
- documentUrl: ${input.documentUrl}
- documentToken: ${input.documentToken}
- triggeredByName: ${input.triggeredByName ?? "unknown"}

Current functional review role:
- nodeName: ${profile.nodeName}
- title: ${profile.title}
- reviewerRole: ${profile.reviewerRole}
- focusAreas:
${profile.focusAreas.map((area) => `  - ${area}`).join("\n")}

Reference criteria for this role:
${referenceContent}

Required output:
- Return only structured JSON matching the schema.
- contract_type: concise contract category.
- risk_level: low, medium, or high.
- suggestion: suggest_approve, supplement_required, or manual_review.
- confidence: number from 0 to 1.
- must_focus: 1-8 high-signal risks for this functional role only. Each item must include title and detail.
- actions: 1-8 concrete next actions or modification suggestions for this responsible person.
- tips: 1-5 short reminders for the human reviewer.
- Do not output Markdown headings, tables, code fences, or extra fields.
- If the document text is incomplete or unclear, say so and recommend manual review or supplementing materials.

Extracted Feishu document text:
File: ${input.contract.fileName}
Extraction warnings:
${formatWarnings(input.contract)}

${contractText.length > 0 ? contractText : "No extractable contract text exists."}`;
}
