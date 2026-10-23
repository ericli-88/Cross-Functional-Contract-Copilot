import type { ReviewProfile, RoleKey } from "../domain/types.js";

const businessLikeSkillReferences = [
  "references/business-leader-review.md",
  "references/general-risk-checklist.md"
];

const businessLikeFocusAreas = [
  "履约可行性",
  "服务范围边界",
  "变更收费",
  "客户配合义务",
  "验收标准"
];

const reviewProfilesByRole: Record<RoleKey, ReviewProfile> = {
  commercial: {
    key: "commercial",
    nodeName: "商务审批",
    title: "商务审核",
    reviewerRole: "商务负责人",
    skillReferences: businessLikeSkillReferences,
    focusAreas: businessLikeFocusAreas
  },
  operations: {
    key: "operations",
    nodeName: "运营审批",
    title: "运营审核",
    reviewerRole: "运营负责人",
    skillReferences: businessLikeSkillReferences,
    focusAreas: businessLikeFocusAreas
  },
  legal: {
    key: "legal",
    nodeName: "法务审批",
    title: "法务审核",
    reviewerRole: "公司法务",
    skillReferences: ["references/legal-review.md"],
    focusAreas: [
      "权责对等",
      "责任限制",
      "知识产权",
      "数据安全边界",
      "终止与争议解决"
    ]
  },
  finance: {
    key: "finance",
    nodeName: "财务审批",
    title: "财务审核",
    reviewerRole: "财务部",
    skillReferences: ["references/finance-review.md"],
    focusAreas: [
      "收款节点",
      "付款周期",
      "质保金限制",
      "发票与付款解耦",
      "逾期付款保护"
    ]
  }
};

export function resolveReviewProfile(roleKey: RoleKey): ReviewProfile {
  return reviewProfilesByRole[roleKey];
}
