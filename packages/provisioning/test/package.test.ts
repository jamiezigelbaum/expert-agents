import { describe, expect, test } from "bun:test";

describe("@expert-agents/provisioning package", () => {
  test("loads as an isolated workspace package", async () => {
    const provisioning = await import("../src/index.ts");

    const functions = [
      "AgentRepoValidationError", "EngagementError", "ServingPackagingError",
      "acceptEngagementLearning", "assertAvatarByteLength", "containsHighConfidenceSecret",
      "createBindingChecklist", "createBindingDescriptor", "createServingChecklist",
      "createServingManifest", "emitBindingArtifacts", "expertStatus", "extractEngagementLearning",
      "isEngagementHeldPath", "lintDerivedArtifactContent", "lintSoul", "openEngagementStore",
      "packageServingArtifact", "readBindingInputs", "renderTemplate", "requireAvatarExtension",
      "requireAvatarPath", "requireIssueTracker", "requireScaffoldOptions", "scaffoldExpert",
      "serializeCreationReceipt", "servingExclusionReason", "validateAgentManifest",
      "validateAgentServingSet", "validateBindingManifest", "validateDerivedArtifactManifest",
      "validateEngagementRecord", "verifyBindingConfig",
    ] as const;
    const numbers = [
      "AGENT_REPO_SCHEMA_VERSION", "AVATAR_MAX_BYTES", "BINDING_SCHEMA_VERSION",
      "DERIVED_ARTIFACT_SCHEMA_VERSION", "ENGAGEMENT_ID_MIN_LENGTH", "ENGAGEMENT_SCHEMA_VERSION",
      "LEARNING_VERBATIM_SPAN_LIMIT", "SOUL_CHARACTER_LIMIT",
    ] as const;
    const strings = [
      "AGENT_REPO_GITIGNORE", "AVATAR_FILE_STEM", "BINDING_CHECKLIST_FILE",
      "BINDING_DESCRIPTOR_FILE", "BINDING_RECEIPT_FILE", "DERIVED_ARTIFACT_CONTENT_FILE",
      "DERIVED_ARTIFACT_DIRECTORY", "DERIVED_ARTIFACT_MANIFEST_FILE",
      "ENGAGEMENT_CONTENT_DIRECTORY", "ENGAGEMENT_RECORD_FILE", "ENGAGEMENT_RECORD_KIND",
      "ISSUE_TRACKER_PLACEHOLDER", "LEARNING_ARTIFACT_KIND", "SERVING_CHECKLIST_FILE",
      "SERVING_MANIFEST_FILE", "SERVING_RECEIPT_FILE", "SERVING_WORKSPACE_DIRECTORY",
    ] as const;
    const arrays = [
      "AVATAR_EXTENSIONS", "HIGH_CONFIDENCE_SECRET_PATTERNS", "SERVING_MANUAL_PRECONDITIONS",
      "STRUCTURAL_SERVING_EXCLUSIONS", "TELEGRAM_DM_POLICIES",
    ] as const;

    expect(Object.keys(provisioning).sort()).toEqual([...functions, ...numbers, ...strings, ...arrays].sort());
    for (const name of functions) expect(typeof provisioning[name]).toBe("function");
    for (const name of numbers) expect(typeof provisioning[name]).toBe("number");
    for (const name of strings) expect(typeof provisioning[name]).toBe("string");
    for (const name of arrays) expect(provisioning[name]).toBeArray();
    expect(provisioning.AVATAR_EXTENSIONS).toEqual(["png", "jpg", "jpeg", "webp"]);
    expect(provisioning.HIGH_CONFIDENCE_SECRET_PATTERNS.every((pattern) => pattern instanceof RegExp)).toBe(true);
    expect(provisioning.SERVING_MANUAL_PRECONDITIONS.every((entry) => typeof entry === "string")).toBe(true);
  });
});
