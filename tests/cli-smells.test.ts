import { describe, expect, it } from "vitest";
import { auditCliHelpQuality } from "../src/static/cli-smells.js";

describe("CLI help-quality audit", () => {
  it("scores complete help output as agent-ready", () => {
    const audit = auditCliHelpQuality(
      `
Acme CLI creates and manages Acme workspace resources from the terminal.

Usage:
  acme <command> [flags]

Commands:
  login        Authenticate with an API token for non-interactive use
  task create Create a task in a workspace
  task delete Delete a task after confirmation; this cannot be undone

Options:
  --token <token>       API token or ACME_API_KEY value to use
  --workspace <id>      Workspace identifier
  --name <text>         Human-readable task name

Examples:
  acme login --token "$ACME_API_KEY"
  acme task create --workspace ws_123 --name "AX probe"
`,
      { title: "acme", command: "acme --help", bin: "acme" },
    );

    expect(audit.score).toBe(100);
    expect(audit.totalFindings).toBe(0);
  });

  it("flags weak help output that leaves agents guessing", () => {
    const audit = auditCliHelpQuality("Usage: acme\n\nCommands:\n  delete", {
      title: "acme",
      command: "acme --help",
      bin: "acme",
    });

    expect(audit.score).toBeLessThan(60);
    expect(audit.byCategory.DESCRIPTION).toBe(1);
    expect(audit.byCategory.FLAGS).toBe(1);
    expect(audit.byCategory.AUTH).toBe(1);
    expect(audit.byCategory.EXAMPLES).toBe(1);
    expect(audit.byCategory.DESTRUCTIVE).toBe(1);
  });

  it("does not treat empty section headings as usable CLI help", () => {
    const audit = auditCliHelpQuality(
      `
Acme CLI manages Acme workspace resources from the terminal.

Usage: acme <command> [flags]
Authentication uses ACME_API_KEY.

Commands:
Options:
Examples:
`,
      { title: "acme", command: "acme --help", bin: "acme" },
    );

    expect(audit.byCategory.COMMANDS).toBe(1);
    expect(audit.byCategory.FLAGS).toBe(1);
    expect(audit.byCategory.EXAMPLES).toBe(1);
    expect(audit.score).toBeLessThan(70);
  });
});
