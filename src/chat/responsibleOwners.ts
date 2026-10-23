import type { OwnerGroups, OwnerRecord, RoleKey } from "../domain/types.js";
import { roleLabels } from "../domain/types.js";
import type { ContractCaseStore } from "./contractCaseStore.js";

export type OwnerDefaults = Record<RoleKey, OwnerRecord[] | OwnerRecord>;

export async function resolveOwners(
  store: ContractCaseStore,
  defaults: OwnerDefaults
): Promise<OwnerGroups> {
  const registered = await store.listOwners();

  return {
    commercial: resolveOwnersForRole(defaults.commercial, registered.commercial),
    operations: resolveOwnersForRole(defaults.operations, registered.operations),
    legal: resolveOwnersForRole(defaults.legal, registered.legal),
    finance: resolveOwnersForRole(defaults.finance, registered.finance)
  };
}

function resolveOwnersForRole(
  defaultOwnerInput: OwnerRecord[] | OwnerRecord,
  registeredOwner?: OwnerRecord
): OwnerRecord[] {
  const defaultOwners = Array.isArray(defaultOwnerInput)
    ? defaultOwnerInput
    : [defaultOwnerInput];
  const configured = dedupeOwners(defaultOwners.filter((owner) => owner.userId));
  if (configured.length > 0) return configured;
  if (registeredOwner?.userId) return [registeredOwner];
  return defaultOwners.length > 0 ? defaultOwners : [];
}

export function makeRegisteredOwner(input: {
  roleKey: RoleKey;
  userId: string;
  displayName?: string;
}): OwnerRecord {
  return {
    roleKey: input.roleKey,
    roleLabel: roleLabels[input.roleKey],
    displayName: input.displayName ?? roleLabels[input.roleKey],
    userId: input.userId,
    registeredAt: new Date().toISOString(),
    source: "chat_registration"
  };
}

export function formatMissingOwnerMessage(
  owners: OwnerGroups,
  botMentionName = "合同机器人"
): string | undefined {
  const missing = (Object.keys(owners) as RoleKey[]).filter(
    (roleKey) => !owners[roleKey].some((owner) => owner.userId)
  );
  if (missing.length === 0) return undefined;

  const botAt = `@${botMentionName.replace(/^@/u, "").trim() || "合同机器人"}`;
  return [
    "以下负责人还没有 user_id，机器人暂时无法私信对应的 detailed 建议：",
    ...missing.map((roleKey) => `- ${roleLabels[roleKey]}：未配置负责人`),
    "",
    "可以让对应负责人在群里发送：",
    ...missing.map((roleKey) => `${botAt} 我是${roleLabels[roleKey]}负责人`)
  ].join("\n");
}

export function isUserInRole(
  owners: OwnerGroups,
  roleKey: RoleKey,
  userId: string
): boolean {
  return owners[roleKey].some((owner) => owner.userId === userId);
}

function dedupeOwners(owners: OwnerRecord[]): OwnerRecord[] {
  const seen = new Set<string>();
  return owners.filter((owner) => {
    if (!owner.userId || seen.has(owner.userId)) return false;
    seen.add(owner.userId);
    return true;
  });
}
