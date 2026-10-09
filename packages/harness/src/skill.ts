/** Native skill-loading configuration, not business skill content or tool definitions. */
export interface HarnessSkillsOptions {
  /** Trusted source directories; each adapter uses its supported native loading mechanism. */
  directories: readonly string[];
}
