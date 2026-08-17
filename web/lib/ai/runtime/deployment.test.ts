import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  MultiInstanceAiConfigurationError,
  WEB_REPLICAS_ENV,
  assertSingleWebInstance,
} from "./deployment";

const dockerDir = join(__dirname, "..", "..", "..", "..", "docker");

describe("single-web-instance guard", () => {
  it("accepts an unset or explicitly single-instance declaration", () => {
    expect(() => assertSingleWebInstance({})).not.toThrow();
    expect(() => assertSingleWebInstance({ [WEB_REPLICAS_ENV]: undefined })).not.toThrow();
    expect(() => assertSingleWebInstance({ [WEB_REPLICAS_ENV]: "" })).not.toThrow();
    expect(() => assertSingleWebInstance({ [WEB_REPLICAS_ENV]: " 1 " })).not.toThrow();
  });

  it("refuses a configuration claiming multi-instance AI continuity", () => {
    for (const declared of ["2", "3", "16"]) {
      expect(() => assertSingleWebInstance({ [WEB_REPLICAS_ENV]: declared })).toThrow(
        MultiInstanceAiConfigurationError,
      );
    }
  });

  it("fails closed on a value it cannot read as one instance", () => {
    for (const declared of ["0", "-1", "one", "1.5", "auto"]) {
      expect(() => assertSingleWebInstance({ [WEB_REPLICAS_ENV]: declared })).toThrow(
        MultiInstanceAiConfigurationError,
      );
    }
  });

  it("names the env var and the reason, so the failure is actionable", () => {
    expect(() => assertSingleWebInstance({ [WEB_REPLICAS_ENV]: "2" })).toThrow(
      /NS_WEB_REPLICAS=2 claims more than one Next web instance/,
    );
  });
});

describe("compose topology", () => {
  const composeFiles = readdirSync(dockerDir).filter(
    (name) => name.startsWith("compose") && name.endsWith(".yml"),
  );

  it("finds the compose files it is guarding", () => {
    expect(composeFiles).toContain("compose.yml");
  });

  it("declares the single-instance bound on the base web service", () => {
    const base = parse(readFileSync(join(dockerDir, "compose.yml"), "utf8")) as ComposeFile;
    expect(base.services?.web?.environment?.[WEB_REPLICAS_ENV]).toBe("1");
    expect(base.services?.web?.environment?.COPILOTKIT_TELEMETRY_DISABLED).toBe("true");
  });

  it("never scales the web service past one in any overlay", () => {
    for (const name of composeFiles) {
      const parsed = parse(readFileSync(join(dockerDir, name), "utf8")) as ComposeFile;
      const web = parsed.services?.web;
      if (!web) continue;

      const replicas = web.deploy?.replicas ?? web.scale;
      expect(replicas ?? 1, `${name} scales web past the Phase-1 bound`).toBe(1);

      const declared = web.environment?.[WEB_REPLICAS_ENV];
      if (declared !== undefined) {
        expect(() =>
          assertSingleWebInstance({ [WEB_REPLICAS_ENV]: String(declared) }),
        ).not.toThrow();
      }
    }
  });
});

describe("deploy gate", () => {
  const script = readFileSync(join(dockerDir, "verify-deploy.sh"), "utf8");

  it("asserts the running web instance count", () => {
    expect(script).toContain("$COMPOSE ps -q web 2>/dev/null | grep -c .");
    expect(script).toContain('[ "$web_count" = 1 ]');
  });

  it("probes the deployed runtime's containment contract, not just its liveness", () => {
    expect(script).toContain("/api/copilotkit/info");
    for (const marker of [
      '"telemetryDisabled":true',
      "Cache-Control: no-store",
      "Set-Cookie",
      '"runtimeInstanceId"',
      '"list":false',
    ]) {
      expect(script, `deploy gate stopped checking ${marker}`).toContain(marker);
    }
  });

  it("proves a multi-instance claim is refused, under a bounded, cleaned probe", () => {
    expect(script).toContain("-e NS_WEB_REPLICAS=2");
    expect(script).toContain('docker rm -f "$AI_MULTI_NAME"');
    expect(script).toMatch(
      /timeout --foreground[^\n]*\\\n\s*docker run --rm --name "\$AI_MULTI_NAME"/,
    );
    // Non-zero exit alone would also be satisfied by an unrelated boot failure; the
    // gate must see the replica guard's own message.
    expect(script).toContain("grep -q 'NS_WEB_REPLICAS=2'");
  });
});

type ComposeService = {
  environment?: Record<string, string | number | undefined>;
  deploy?: { replicas?: number };
  scale?: number;
};

type ComposeFile = {
  services?: Record<string, ComposeService | undefined>;
};
