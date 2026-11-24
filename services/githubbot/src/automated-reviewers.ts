/** Deployment defaults for this fork; an explicit list replaces them. */
export const DEFAULT_AUTOMATED_REVIEWER_LOGINS: readonly string[] = ["darkmatteragent"];

export function automatedReviewerLogins(configured?: readonly string[]): readonly string[] {
  return configured ?? DEFAULT_AUTOMATED_REVIEWER_LOGINS;
}
