import {
  FORBIDDEN_TOOL_NAMES,
  newProposalId,
  sanitizeProposalInput
} from "./devCompanionChronicle.js";

export async function proposeChronicleWrite({
  rawArgs,
  store,
  readMainSha,
  ownerId
}) {
  try {
    if (FORBIDDEN_TOOL_NAMES.includes(rawArgs?.name)) {
      return Object.freeze({ ok: false, error: "forbidden tool" });
    }
    if (typeof readMainSha !== "function") {
      return Object.freeze({ ok: false, error: "main SHA reader is required" });
    }
    const sanitized = sanitizeProposalInput(rawArgs);
    const main = await readMainSha();
    if (!main?.ok) {
      return Object.freeze({ ok: false, error: main?.error || "could not read main SHA" });
    }
    const id = newProposalId();
    await store.saveChronicleProposal({
      id,
      ownerId,
      baseSha: main.sha,
      branchName: sanitized.branchName,
      files: sanitized.files,
      commitMessage: sanitized.commitMessage,
      prTitle: sanitized.prTitle,
      prBody: sanitized.prBody,
      contentHash: sanitized.contentHash
    });
    return Object.freeze({
      ok: true,
      wrote: false,
      proposalId: id,
      baseSha: main.sha,
      branchName: sanitized.branchName,
      files: sanitized.files.map((file) => ({ path: file.path, contentSha256: file.contentSha256 })),
      next: `/approvewrite ${id}`
    });
  } catch (error) {
    return Object.freeze({ ok: false, error: error.message });
  }
}
