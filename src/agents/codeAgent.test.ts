import { test } from "bun:test";
import assert from "node:assert/strict";
import { resolveCodeAgentConfig, resolveCodeAgentCwd } from "./codeAgent.ts";
import { createTestSettings } from "../testSettings.ts";

test("resolveCodeAgentConfig routes worker selection through the requested role", () => {
  const base = createTestSettings({
    permissions: {
      devTasks: {
        allowedUserIds: ["user-1"]
      }
    },
    agentStack: {
      runtimeConfig: {
        devTeam: {
          codex: {
            maxParallelTasks: 2,
            maxTasksPerHour: 5
          },
          codexCli: {
            maxParallelTasks: 2,
            maxTasksPerHour: 5
          },
          claudeCode: {
            maxParallelTasks: 2,
            maxTasksPerHour: 5
          }
        }
      }
    }
  });
  const settings = {
    ...base,
    agentStack: {
      ...base.agentStack,
      overrides: {
        ...base.agentStack.overrides,
        devTeam: {
          codingWorkers: ["codex_cli", "claude_code"],
          roles: {
            design: "claude_code",
            implementation: "codex_cli",
            review: "claude_code",
            research: "codex_cli"
          }
        }
      },
      runtimeConfig: {
        ...base.agentStack.runtimeConfig,
        devTeam: {
          ...base.agentStack.runtimeConfig.devTeam,
          codexCli: {
            ...base.agentStack.runtimeConfig.devTeam.codexCli,
            enabled: true,
            defaultCwd: "/tmp/codex-cli",
            maxParallelTasks: 3
          },
          claudeCode: {
            ...base.agentStack.runtimeConfig.devTeam.claudeCode,
            enabled: true,
            defaultCwd: "/tmp/claude-code",
            maxParallelTasks: 5
          }
        }
      }
    }
  };

  const designConfig = resolveCodeAgentConfig(settings, undefined, "design");
  const implementationConfig = resolveCodeAgentConfig(settings, undefined, "implementation");
  const reviewConfig = resolveCodeAgentConfig(settings, undefined, "review");
  const researchConfig = resolveCodeAgentConfig(settings, undefined, "research");

  assert.equal(designConfig.role, "design");
  assert.equal(designConfig.worker, "claude_code");
  assert.equal(designConfig.provider, "claude-code");
  assert.equal(designConfig.cwd, "/tmp/claude-code");
  assert.equal(designConfig.maxParallelTasks, 5);

  assert.equal(implementationConfig.role, "implementation");
  assert.equal(implementationConfig.worker, "codex_cli");
  assert.equal(implementationConfig.provider, "codex-cli");
  assert.equal(implementationConfig.cwd, "/tmp/codex-cli");
  assert.equal(implementationConfig.maxParallelTasks, 3);

  assert.equal(reviewConfig.worker, "claude_code");
  assert.equal(reviewConfig.provider, "claude-code");
  assert.equal(researchConfig.worker, "codex_cli");
  assert.equal(researchConfig.provider, "codex-cli");
});

test("resolveCodeAgentCwd defaults to the provided repo root and normalizes relative paths", () => {
  assert.equal(resolveCodeAgentCwd("", "/tmp/project"), "/tmp/project");
  assert.equal(resolveCodeAgentCwd("packages/app", "/tmp/project"), "/tmp/project/packages/app");
  assert.equal(resolveCodeAgentCwd("/var/tmp/repo", "/tmp/project"), "/var/tmp/repo");
});
