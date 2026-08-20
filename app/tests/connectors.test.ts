import { expect, test } from "vitest";
import { connectorKeys } from "@/lib/connectors/queries";

test("uses a dedicated query namespace for the seeded connector catalog", () => {
  expect(connectorKeys.list()).toEqual(["connectors", "list"]);
});
