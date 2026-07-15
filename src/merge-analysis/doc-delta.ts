import { extractSection } from "./section-updater";

export interface DeltaSummary {
  summary: string;
  changeCount: number;
  sections: string[];
}

/**
 * Compares each newly-generated section against its previous content in the
 * old intake report to build a short human-readable summary for the PR
 * description. This is intentionally simple (length/word-diff heuristics,
 * not a real diff algorithm) since it only needs to be good enough for a
 * reviewer to skim before opening the actual PR diff.
 */
export function computeDocDelta(
  oldReport: string,
  newSections: Record<string, string>
): DeltaSummary {
  const changedSections: string[] = [];
  const notes: string[] = [];

  for (const [sectionName, newBody] of Object.entries(newSections)) {
    const oldBody = extractSection(oldReport, sectionName) || "";
    const oldTrim = oldBody.trim();
    const newTrim = newBody.trim();

    if (oldTrim === newTrim) continue; // no meaningful change

    changedSections.push(sectionName);

    if (!oldTrim) {
      notes.push(`${sectionName}: added (previously empty)`);
      continue;
    }

    const oldLen = oldTrim.length;
    const newLen = newTrim.length;
    const delta = newLen - oldLen;
    if (Math.abs(delta) < 20) {
      notes.push(`${sectionName}: minor wording update`);
    } else if (delta > 0) {
      notes.push(`${sectionName}: expanded (+${delta} chars)`);
    } else {
      notes.push(`${sectionName}: trimmed (${delta} chars)`);
    }
  }

  return {
    summary: notes.length > 0 ? notes.join("; ") : "No substantive changes detected.",
    changeCount: changedSections.length,
    sections: changedSections,
  };
}
