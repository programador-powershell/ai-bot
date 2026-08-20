import { expect, test } from "vitest";
import { credentialFormSchema } from "@/lib/credentials/form";

test("requires credential type, provider, key ID, and secret", () => {
  expect(
    credentialFormSchema.safeParse({
      kind: "model",
      provider: "",
      keyId: "",
      plaintext: "",
    }).success,
  ).toBe(false);
});
