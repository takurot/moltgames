import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import * as fs from "fs";
import { describe, it, beforeAll, afterAll, beforeEach } from "vitest";

const PROJECT_ID = "moltgames-test";
const FIRESTORE_RULES = fs.readFileSync("firebase/firestore.rules", "utf8");

describe("Firestore Security Rules", () => {
  let testEnv: RulesTestEnvironment;

  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        rules: FIRESTORE_RULES,
        host: "127.0.0.1",
        port: 8088,
      },
    });
  });

  afterAll(async () => {
    await testEnv.cleanup();
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();
  });

  describe("users collection", () => {
    it("allows owner to read/write their own profile", async () => {
      const alice = testEnv.authenticatedContext("alice");
      await assertSucceeds(
        alice.firestore().collection("users").doc("alice").set({
          displayName: "Alice",
          createdAt: new Date(),
        })
      );
      await assertSucceeds(alice.firestore().collection("users").doc("alice").get());
    });

    it("denies others from reading/writing profile", async () => {
      const alice = testEnv.authenticatedContext("alice");
      const bob = testEnv.authenticatedContext("bob");

      await alice.firestore().collection("users").doc("alice").set({ displayName: "Alice" });

      await assertFails(bob.firestore().collection("users").doc("alice").get());
      await assertFails(bob.firestore().collection("users").doc("alice").update({ displayName: "Hacked" }));
    });
  });

  describe("agents collection", () => {
    it("allows owner to create agent", async () => {
      const alice = testEnv.authenticatedContext("alice");
      await assertSucceeds(
        alice.firestore().collection("agents").doc("agent1").set({
          ownerUid: "alice",
          modelProvider: "openai",
          modelName: "gpt-4",
          createdAt: new Date(),
          updatedAt: new Date(),
        })
      );
    });

    it("allows others to read public fields", async () => {
      const alice = testEnv.authenticatedContext("alice");
      const bob = testEnv.authenticatedContext("bob");

      // Alice creates agent with ONLY public fields
      await alice.firestore().collection("agents").doc("agent1").set({
        ownerUid: "alice",
        modelProvider: "openai",
        modelName: "gpt-4",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await assertSucceeds(bob.firestore().collection("agents").doc("agent1").get());
    });

    it("denies others if document contains private fields", async () => {
      const alice = testEnv.authenticatedContext("alice");
      const bob = testEnv.authenticatedContext("bob");

      // Alice creates agent with extra private field
      await alice.firestore().collection("agents").doc("agent1").set({
        ownerUid: "alice",
        modelProvider: "openai",
        modelName: "gpt-4",
        createdAt: new Date(),
        updatedAt: new Date(),
        systemPrompt: "SECRET",
      });

      // Bob tries to read
      await assertFails(bob.firestore().collection("agents").doc("agent1").get());
    });

    it("should allow policyFlags if it is considered public", async () => {
       const alice = testEnv.authenticatedContext("alice");
       const bob = testEnv.authenticatedContext("bob");

       await alice.firestore().collection("agents").doc("agent1").set({
         ownerUid: "alice",
         modelProvider: "openai",
         modelName: "gpt-4",
         createdAt: new Date(),
         updatedAt: new Date(),
         policyFlags: ["allow_nsfw"],
       });

       // This should succeed if we fix the rules to allow policyFlags
       await assertSucceeds(bob.firestore().collection("agents").doc("agent1").get());
    });
  });

  describe("matches collection", () => {
    it("allows reading public matches", async () => {
      const alice = testEnv.authenticatedContext("alice");
      const bob = testEnv.authenticatedContext("bob");

      await testEnv.withSecurityRulesDisabled(async (context) => {
          await context.firestore().collection("matches").doc("match1").set({
              visibility: "public",
              createdAt: new Date(),
          });
      });

      await assertSucceeds(bob.firestore().collection("matches").doc("match1").get());
    });

    it("allows participants to read private matches", async () => {
      const alice = testEnv.authenticatedContext("alice");
      const bob = testEnv.authenticatedContext("bob");

      await testEnv.withSecurityRulesDisabled(async (context) => {
          await context.firestore().collection("matches").doc("match2").set({
              visibility: "private",
              participantUids: ["alice", "bob"],
              createdAt: new Date(),
          });
      });

      await assertSucceeds(bob.firestore().collection("matches").doc("match2").get());
    });

    it("denies non-participants reading private matches", async () => {
      const charlie = testEnv.authenticatedContext("charlie");

      await testEnv.withSecurityRulesDisabled(async (context) => {
          await context.firestore().collection("matches").doc("match3").set({
              visibility: "private",
              participantUids: ["alice", "bob"],
              createdAt: new Date(),
          });
      });

      await assertFails(charlie.firestore().collection("matches").doc("match3").get());
    });

    it("denies client writes to matches", async () => {
        const alice = testEnv.authenticatedContext("alice");
        await assertFails(alice.firestore().collection("matches").doc("match_new").set({}));
    });
  });
});
