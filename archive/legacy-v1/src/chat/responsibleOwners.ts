import type { OwnerRecord, RoleKey } from "../domain/types.js";
import { roleLabels } from "../domain/types.js";
import type { ContractCaseStore } from "./contractCaseStore.js";

export type OwnerDefaults = Record<RoleKey, OwnerRecord>;

export async function resolveOwners(
  store: ContractCaseStore,
  defaults: OwnerDefaults
): Promise<Record<RoleKey, OwnerRecord>> {
  const registered = await store.listOwners();

  return {
    commercial: resolveOwner(defaults.commercial, registered.commercial),
    operations: resolveOwner(defaults.operations, registered.operations),
    legal: resolveOwner(defaults.legal, registered.legal),
    finance: resolveOwner(defaults.finance, registered.finance)
  };
}

function resolveOwner(defaultOwner: OwnerRecord, registeredOwner?: OwnerRecord): OwnerRecord {
  if (defaultOwner.userId) return defaultOwner;
  return registeredOwner?.userId ? registeredOwner : defaultOwner;
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
  owners: Record<RoleKey, OwnerRecord>,
  botMentionName = "合同机器人"
): string | undefined {
  const missing = Object.values(owners).filter((owner) => !owner.userId);
  if (missing.length === 0) return undefined;

  const botAt = `@${botMentionName.replace(/^@/u, "").trim() || "合同机器人"}`;
  return [
    "以下负责人还没有 user_id，机器人暂时无法私信对应的 detailed 建议：",
    ...missing.map((owner) => `- ${owner.roleLabel}：${owner.displayName}`),
    "",
    "可以让对应负责人在群里发送：",
    ...missing.map((owner) => `${botAt} 我是${owner.roleLabel}负责人`)
  ].join("\n");
}
