/**
 * The minimum environment a deployment is allowed to boot with, for tests that need a config but are
 * not testing configuration itself.
 *
 * It lives in one place because the minimum is a moving target: [Cirurgia §4.6]
 * o Intelligence deixou de ser obrigatório (modo local, R3) e o DATABASE_URL
 * virou o caminho do chassis.db (bun:sqlite, R2) — os cinco INTELLIGENCE_*
 * saíram daqui porque agora eles DERRUBAM o boot em vez de sustentá-lo.
 * Tests that assert on configuration should keep building their environment
 * inline; everything else should spread this.
 */
export function testEnvironment(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    DATABASE_URL: ":memory:",
    KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
    BETTER_AUTH_SECRET: "a-long-enough-local-development-auth-secret",
    BETTER_AUTH_URL: "http://localhost:3001",
    MANAGED_AGENT_AG_UI_URL: "http://localhost:4200/ag-ui",
    ...overrides,
  };
}
