/**
 * Extracts the body text of a "## SectionName" block from a Markdown intake
 * report (everything after the heading line up to, but not including, the
 * next "## " heading or end of file).
 */
export function extractSection(report: string, sectionName: string): string | null {
  const match = matchSection(report, sectionName);
  return match ? match.body : null;
}

function matchSection(
  report: string,
  sectionName: string
): { start: number; end: number; body: string } | null {
  const headingRegex = new RegExp(`^##\\s+${escapeRegex(sectionName)}\\s*$`, "m");
  const headingMatch = headingRegex.exec(report);
  if (!headingMatch) return null;

  const bodyStart = headingMatch.index + headingMatch[0].length;
  const rest = report.slice(bodyStart);
  const nextHeadingMatch = /^##\s+/m.exec(rest);
  const bodyEnd = nextHeadingMatch ? bodyStart + nextHeadingMatch.index : report.length;

  return {
    start: headingMatch.index,
    end: bodyEnd,
    body: report.slice(bodyStart, bodyEnd).trim(),
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replaces only the given sections' content in an existing intake report,
 * leaving every other section (and the overall document structure) intact.
 * If a section heading doesn't exist yet in the old report (shouldn't
 * normally happen since Phase 1 always generates all 9 sections), it's
 * appended at the end.
 */
export function updateIntakeReport(
  oldReport: string,
  newSections: Record<string, string>
): string {
  let updated = oldReport;

  for (const [sectionName, newBody] of Object.entries(newSections)) {
    const match = matchSection(updated, sectionName);
    const replacement = `## ${sectionName}\n\n${newBody.trim()}\n\n`;

    if (match) {
      updated = updated.slice(0, match.start) + replacement + updated.slice(match.end);
    } else {
      updated = updated.trimEnd() + "\n\n" + replacement;
    }
  }

  return updated;
}
