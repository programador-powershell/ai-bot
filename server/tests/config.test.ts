import { describe, expect, test } from "vitest";
import { loadConfig } from "../src/config";

// [Cirurgia §4.6 — R3] O contrato MÍNIMO mudou de dono: o Intelligence saiu do
// boot (modo local, a conversa é o nosso event log) e o DATABASE_URL virou o
// caminho do chassis.db (bun:sqlite, R2). O que era "recusa a subir sem
// Intelligence" virou o espelho honesto: recusa a subir COM variáveis de
// Intelligence, porque configuração que o produto não honra não passa calada.
const baseEnvironment = {
  DATABASE_URL: ":memory:",
  KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
  GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
  BETTER_AUTH_SECRET: "a-long-enough-local-development-auth-secret",
  BETTER_AUTH_URL: "http://localhost:3001",
  MANAGED_AGENT_AG_UI_URL: " http://localhost:4200/ag-ui ",
};

describe("deployment configuration", () => {
  test("resolves the local runtime, which is the only runtime (R3)", () => {
    const config = loadConfig(baseEnvironment);

    expect(config.runtime).toEqual({
      mode: "local",
      // Nasce false e só vira true na onda 2, quando os channels lerem o
      // event log de verdade — a /api/capabilities não pode prometer antes.
      durableHistory: false,
    });
    expect(config.managedAgentAgUiUrl).toEqual(
      new URL("http://localhost:4200/ag-ui"),
    );
    expect(config.tenantPackageDirectory).toBe("../examples/fintech");
  });

  test("allows deployment without an authentication provider", () => {
    const config = loadConfig({
      DATABASE_URL: baseEnvironment.DATABASE_URL,
      KEY_ENCRYPTION_KEY: baseEnvironment.KEY_ENCRYPTION_KEY,
      MANAGED_AGENT_AG_UI_URL: baseEnvironment.MANAGED_AGENT_AG_UI_URL,
    });

    expect(config.auth).toBeUndefined();
  });

  // O espelho do original: cada variável de Intelligence presente é uma recusa
  // de boot, porque este deployment não a honra — dizer isso em voz alta é
  // melhor do que um operador acreditar que configurou algo que não existe.
  test.each([
    "INTELLIGENCE_API_URL",
    "INTELLIGENCE_GATEWAY_WS_URL",
    "INTELLIGENCE_API_KEY",
    "COPILOTKIT_LICENSE_TOKEN",
  ])("refuses to start when %s is configured (modo local não a honra)", (name) => {
    const environment: Record<string, string | undefined> = {
      ...baseEnvironment,
      [name]: "algum-valor",
    };

    expect(() => loadConfig(environment)).toThrow(name);
  });

  test("rejects incomplete OAuth client configuration", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
        GOOGLE_OAUTH_CLIENT_SECRET: "",
      }),
    ).toThrow(
      "Google OAuth configuration requires both client ID and client secret",
    );
  });

  test("refuses to start when MANAGED_AGENT_AG_UI_URL is missing", () => {
    const environment: Record<string, string | undefined> = {
      ...baseEnvironment,
    };
    delete environment.MANAGED_AGENT_AG_UI_URL;

    expect(() => loadConfig(environment)).toThrow("MANAGED_AGENT_AG_UI_URL");
  });

  test("refuses a non-HTTP MANAGED_AGENT_AG_UI_URL", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        MANAGED_AGENT_AG_UI_URL: "ftp://localhost:4200/ag-ui",
      }),
    ).toThrow("MANAGED_AGENT_AG_UI_URL");
  });

  test("requires a base64-encoded 32-byte key-encryption key", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        KEY_ENCRYPTION_KEY: "local-development-key",
      }),
    ).toThrow("KEY_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  });

  test("enables Google authentication when its complete deployment contract is present", () => {
    const config = loadConfig({
      ...baseEnvironment,
      GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
      BETTER_AUTH_SECRET: "a-long-enough-local-development-auth-secret",
      BETTER_AUTH_URL: "http://localhost:3001",
      INITIAL_ADMIN_EMAILS: "admin@openbot.test, owner@openbot.test",
    });

    expect(config.auth).toEqual({
      baseUrl: "http://localhost:3001",
      secret: "a-long-enough-local-development-auth-secret",
      google: {
        clientId: "google-client-id",
        clientSecret: "google-client-secret",
      },
      trustedOrigins: ["http://localhost:3000"],
      initialAdminEmails: ["admin@openbot.test", "owner@openbot.test"],
    });
  });

  test("rejects incomplete Google authentication deployment settings", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
        GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
        BETTER_AUTH_SECRET: "",
        BETTER_AUTH_URL: "http://localhost:3001",
      }),
    ).toThrow("Google authentication requires BETTER_AUTH_SECRET");
  });

  // A turn that is ended is a turn somebody loses, so an unset variable leaves every stream alone
  // rather than acquiring a timeout the deployment never asked for. `.env.example` ships a value.
  test("leaves the stall watchdog off when nothing is configured", () => {
    expect(loadConfig(baseEnvironment).agentStallTimeoutMs).toBe(0);
  });

  test("takes a timeout in milliseconds, and zero as switching it off", () => {
    expect(
      loadConfig({ ...baseEnvironment, AGENT_STALL_TIMEOUT_MS: "120000" })
        .agentStallTimeoutMs,
    ).toBe(120_000);
    expect(
      loadConfig({ ...baseEnvironment, AGENT_STALL_TIMEOUT_MS: "0" })
        .agentStallTimeoutMs,
    ).toBe(0);
  });

  // Refused rather than defaulted, for the same reason a malformed policy is: an operator who meant
  // to write a boundary and mistyped it would otherwise get a deployment enforcing something else.
  test.each(["two minutes", "-1", "1.5", ""])(
    "refuses to start on AGENT_STALL_TIMEOUT_MS=%p",
    (value) => {
      const attempt = () =>
        loadConfig({ ...baseEnvironment, AGENT_STALL_TIMEOUT_MS: value });
      if (value === "") {
        // An empty value is an absent one, which is the off case rather than a malformed one.
        expect(attempt().agentStallTimeoutMs).toBe(0);
        return;
      }
      expect(attempt).toThrow("AGENT_STALL_TIMEOUT_MS");
    },
  );
});
