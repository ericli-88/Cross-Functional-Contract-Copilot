// English documentation view over the offline workflow; never calls a model.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { roleKeys } from "../dist/src/domain/types.js";
import { resolveReviewProfile } from "../dist/src/review/reviewProfile.js";

const raw = JSON.parse(await readFile("docs/demo/scenes.json", "utf8"));
const ids = new Set(raw.scenes.map((scene) => scene.id));
for (const id of ["02-link-review", "04-no-change", "05-revision", "06-task-history", "07-completed", "08-reopened", "09-attachment", "10-archive"]) assert.ok(ids.has(id), `Missing workflow evidence: ${id}`);
const names = { finance: "Finance", operations: "Operations", commercial: "Commercial", legal: "Legal" };
const recommendations = {
  finance: { focus: "Cash flow and payment exposure", risk: "Payment is due 180 days after acceptance; late-payment protection is missing.", action: "Negotiate staged payments and add late-payment protections.", owner: "Jordan Lee" },
  operations: { focus: "Acceptance and delivery execution", risk: "Acceptance lacks objective criteria and a feedback deadline.", action: "Define acceptance criteria, response windows, and client responsibilities.", owner: "Sam Rivera" },
  commercial: { focus: "Scope and change-order exposure", risk: "Deliverables and charges for scope changes are not defined.", action: "Specify deliverables, scope boundaries, and change-order pricing.", owner: "Alex Morgan" },
  legal: { focus: "Liability and rights allocation", risk: "The agreement does not define a liability cap or the scope of compensation.", action: "Add a liability cap, IP ownership terms, and termination settlement provisions.", owner: "Taylor Chen" }
};
const roles = roleKeys.map((key) => ({ key, name: names[key], ...recommendations[key], references: resolveReviewProfile(key).skillReferences }));
assert.equal(new Set(roles.map((role) => role.key)).size, roleKeys.length);
const portfolio = {
  title: "Cross-Functional Contract Copilot",
  subtitle: "One contract. Role-specific revision guidance. Shared follow-through.",
  simulated: true,
  localization: "English editorial summaries of a Chinese-language deployment; not an English runtime UI or live API recording.",
  contract: "Northstar Systems | Services Agreement",
  contractId: raw.scenes.find((scene) => scene.id === "02-link-review").card.header.title.content.match(/HT-\d{8}-\d{4}/u)[0],
  roles,
  sourceScenes: raw.scenes.map((scene) => scene.id),
  verified: { initialVersion: 1, revisedVersion: 2, initialRoleTasks: roleKeys.length, unchangedContentSkipsAI: true, attachmentsConvertedToOnlineDocs: false },
  limitations: ["Commercial and Operations share a checklist", "Recommendations do not rewrite contract text", "Any configured owner can update a department status", "Completion deletes the associated role task; reopening recreates it on the next review"]
};
await writeFile("docs/demo/portfolio.json", JSON.stringify(portfolio, null, 2) + "\n");
console.log(`English portfolio exported: ${roles.length} actual roles; ${raw.scenes.length} workflow evidence scenes.`);
