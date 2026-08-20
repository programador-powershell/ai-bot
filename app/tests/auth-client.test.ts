import { expect, test } from "vitest";
import { authClient, signInWithGoogle } from "@/lib/auth/client";

test("starts the Google social sign-in flow through the Better Auth client", () => {
  // [Porte bun:test→vitest] toBeFunction não existe no vitest; a asserção
  // equivalente é sobre o typeof.
  expect(typeof authClient.signIn.social).toBe("function");
  expect(typeof signInWithGoogle).toBe("function");
});
