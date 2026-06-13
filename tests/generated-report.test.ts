import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TargetPackSchema, type TargetPack } from "../src/schemas.js";
import {
  buildRecommendations,
  renderGeneratedReport,
  type ProfileRun,
  type StaticReadiness,
} from "../src/generate/report.js";
import type { RoundtripOutcome } from "../src/generate/verify.js";
import type { DiscoveryReport, DiscoveryMetric } from "../src/generate/discovery.js";
import type { TraceStep } from "../src/harness/executor.js";
import { auditSpecQuality } from "../src/static/smells.js";

/** A small OpenAPI doc that trips several smells, for content-quality tests. */
function smellyAudit() {
  const spec = {
    openapi: "3.0.0",
    info: { title: "Demo API" },
    components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
    paths: {
      "/createWidget": {
        post: {
          // no summary/description (LAZY), action-verb path (PATH), no security
          // (SECURITY), undocumented body field (INPUT), no responses (RESPONSE).
          requestBody: {
            content: { "application/json": { schema: { type: "object", properties: { name: {} } } } },
          },
        },
      },
    },
  };
  return auditSpecQuality(JSON.stringify(spec), "https://demo.test/openapi.json");
}

// ---------------------------------------------------------------------------
// Fixture builders (no live creds / network needed).
// ---------------------------------------------------------------------------

type TaskInput = {
  id: string;
  difficulty: "L1" | "L2" | "L3" | "L4";
  prompt: string;
  title?: string;
  create_path?: string;
  allowed_surfaces?: string[];
  weak?: boolean;
};

function makePack(tasks: TaskInput[], withDiscovery = true): TargetPack {
  return TargetPackSchema.parse({
    name: "demo",
    standard_set_version: "demo-2026-06-05",
    run_id: "2026-06-05-demo",
    generated_by: "fixture@no-model",
    base_url: "https://api.demo.test",
    site_url: "https://demo.test",
    ...(withDiscovery ? { discovery: { product: "Demo" } } : {}),
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      difficulty: t.difficulty,
      prompt: t.prompt,
      create_path: t.create_path,
      allowed_surfaces: t.allowed_surfaces,
      oracles: t.weak
        ? [{ type: "exists", path: "id" }]
        : [{ type: "roundtrip", readPathTemplate: "/x/{gid}", assertField: "ok", expected: true }],
    })),
  });
}

function outcome(
  taskId: string,
  difficulty: string,
  profile: string,
  success: boolean,
  detail = "ok=true expected=true",
): RoundtripOutcome {
  return {
    taskId,
    difficulty,
    profile,
    success,
    oracleResults: [{ type: "roundtrip", passed: success, detail }],
    error: null,
  };
}

function discovery(passed: Partial<Record<DiscoveryMetric["id"], boolean>>, hops = 2): DiscoveryReport {
  const ids: DiscoveryMetric["id"][] = ["official", "canonical", "misled", "auth"];
  return {
    hops,
    metrics: ids.map((id) => ({ id, passed: passed[id] ?? true, detail: `${id} detail` })),
  };
}

const plan402 = (taskId: string): TraceStep => ({
  step: 1,
  taskId,
  action: "call",
  method: "POST",
  path: "/x",
  status: 402,
  note: "premium-only",
});

/**
 * Comprehensive scenario: a readiness↔behavioral gap, a product-attributed
 * ceiling failure (discovery held), a plan-limited failure, a weak-oracle task,
 * an SPA (v2≈0) docs surface, and a prompt with HTML-unsafe characters.
 */
function comprehensiveScenario(): { pack: TargetPack; runs: ProfileRun[]; stat: StaticReadiness } {
  const pack = makePack([
    { id: "t-pass-1", difficulty: "L1", prompt: "Create a widget and report its id." },
    { id: "t-pass-2", difficulty: "L1", prompt: "Add a comment and report its id." },
    {
      id: "t-prod",
      difficulty: "L4",
      prompt: `Create <b>"thing"</b> & report id <script>alert('xss')</script>`,
    },
    { id: "t-plan", difficulty: "L3", prompt: "Create a premium-only resource." },
    { id: "t-weak", difficulty: "L2", prompt: "List widgets (existence only).", weak: true },
  ]);

  const ceiling: ProfileRun = {
    profile: "ceiling",
    ns: "2026-06-05-demo-ceiling-ab12",
    discoverySource: "observed",
    // Discovery HELD (official + canonical pass) so failures are attributable.
    discovery: discovery({ auth: false }),
    trace: [plan402("t-plan")],
    outcomes: [
      outcome("t-pass-1", "L1", "ceiling", true),
      outcome("t-pass-2", "L1", "ceiling", true),
      outcome("t-prod", "L4", "ceiling", false, `ok=false expected=true <bad&"val'>`),
      outcome("t-plan", "L3", "ceiling", false, "402 premium-only"),
      outcome("t-weak", "L2", "ceiling", true, "id exists"),
    ],
  };
  const floor: ProfileRun = {
    profile: "floor",
    ns: "2026-06-05-demo-floor-cd34",
    discoverySource: "observed",
    discovery: discovery({ auth: false }),
    trace: [plan402("t-plan")],
    outcomes: [
      outcome("t-pass-1", "L1", "floor", true),
      outcome("t-pass-2", "L1", "floor", false),
      outcome("t-prod", "L4", "floor", false),
      outcome("t-plan", "L3", "floor", false),
      outcome("t-weak", "L2", "floor", false),
    ],
  };
  return { pack, runs: [floor, ceiling], stat: { site: "https://demo.test", v0Score: 90, v2Score: 0 } };
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("renderGeneratedReport (HTML)", () => {
  it("uses the product name in the headline, not the generated pack id", () => {
    const pack = TargetPackSchema.parse({
      ...makePack([{ id: "t", difficulty: "L1", prompt: "x" }]),
      name: "asana-generated",
      discovery: { product: "Asana" },
    });
    const html = renderGeneratedReport(pack, [
      {
        profile: "high",
        outcomes: [outcome("t", "L1", "high", true)],
        trace: [],
      },
    ]);
    expect(html).toContain("How well can an AI agent use <span class=\"ax-target\">Asana</span>?");
    expect(html).not.toContain("use <span class=\"ax-target\">asana-generated</span>");
  });

  it("emits a self-contained, semantic HTML document with every section", () => {
    const { pack, runs, stat } = comprehensiveScenario();
    const html = renderGeneratedReport(pack, runs, stat);

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<style>"); // inline styles, no external CDN
    expect(html).not.toContain("https://cdn"); // no external deps
    expect(html).toContain(":root"); // CSS custom properties for theming
    expect(html).toContain("--accent");

    // Section landmarks (top → bottom).
    expect(html).toContain("AX eval");
    expect(html).toContain(">Demo<");
    expect(html).toContain("standard_set_version");
    expect(html).toContain("<h2>Summary</h2>");
    expect(html).toContain("Key findings");
    expect(html).toContain("Recommendations");
    expect(html).toContain("<h2>Scores</h2>");
    expect(html).toContain("Robustness (pass@k)");
    expect(html).toContain("Trace checks");
    expect(html).toContain("Methodology");
    expect(html).toContain("Appendix");

    // Single-attempt runs nudge the reader to enable robustness.
    expect(html).toContain("--attempts");

    // TL;DR block opens the report with the four pillars + jump links.
    expect(html).toContain("ax-tldr");
    expect(html).toContain("TL;DR");
    expect(html).toContain("agent operability");
    // Four-pillar scorecard: static discovery and behavioral agent discovery are
    // distinct cards (never one conflated "discoverability" number), plus content
    // quality and task success.
    expect(html).toContain("ax-scorecard");
    expect(html).toContain("Static discovery");
    expect(html).toContain("docs-site crawl");
    expect(html).toContain("Agent discovery"); // pillar card
    expect(html).toContain("Agent discovery (Phase 0, behavioral)"); // detail section
    expect(html).toContain("Task success");
    expect(html).toContain('id="agent-discovery"'); // anchor for the TL;DR/card link
    expect(html).toContain("ax-card--warn"); // 60% task success → warn band
    expect(html).toContain("ax-rec--high");
  });

  it("weaves the content-quality (spec smell) axis into the pipeline report", () => {
    const { pack, runs, stat } = comprehensiveScenario();
    const audit = smellyAudit();
    const statCQ: StaticReadiness = { ...stat, contentScore: audit.score, contentQuality: audit };
    const html = renderGeneratedReport(pack, runs, statCQ);

    // Multi-config → the matrix Summary, where Content quality is a product-level
    // card alongside Static discovery (the behavioral pillars move into the grid).
    expect(html).toContain('class="ax-scorecard"');
    expect(html).toContain("agent operability");
    expect(html).toContain("Content quality");
    expect(html).toContain(">" + audit.score + '<span class="ax-card__scale">'); // score renders with its /100 scale

    // A dedicated content-quality section with the prevalence table renders.
    expect(html).toContain("Content quality (spec smells)");
    expect(html).toContain("Smell prevalence");
    expect(html).toContain("Hermes");

    // A content-quality recommendation appears (score < 80 on the smelly spec).
    const recs = buildRecommendations(pack, runs, statCQ);
    expect(recs.map((r) => r.title)).toContain("Improve the OpenAPI spec's content quality");

    // A content-quality finding is surfaced in the rendered report.
    expect(html).toContain("OpenAPI content quality is");
  });

  it("omits the content-quality card + section when no audit ran", () => {
    const { pack, runs, stat } = comprehensiveScenario();
    const html = renderGeneratedReport(pack, runs, stat); // stat has v0/v2 only
    expect(html).toContain('class="ax-scorecard"'); // plain 3-col grid
    expect(html).not.toContain('class="ax-scorecard ax-scorecard--four"');
    expect(html).not.toContain("Content quality (spec smells)");
  });

  it("escapes interpolated text (task prompts, oracle details)", () => {
    const { pack, runs, stat } = comprehensiveScenario();
    const html = renderGeneratedReport(pack, runs, stat);
    // The dangerous prompt must be escaped, never emitted raw.
    expect(html).not.toContain("<script>alert('xss')</script>");
    expect(html).toContain("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;"); // <b> escaped
    // Escaped oracle detail from the failing task.
    expect(html).toContain("&lt;bad&amp;&quot;val&#39;&gt;");
  });

  it("surfaces the headline gap, product/docs, SPA, weak-oracle and plan-limit recommendations", () => {
    const { pack, runs, stat } = comprehensiveScenario();
    const recs = buildRecommendations(pack, runs, stat);
    const titles = recs.map((r) => r.title);
    expect(titles).toContain("Close the gap between published and usable");
    expect(titles).toContain("Product/docs gap: the strongest agent still failed");
    expect(titles).toContain("Docs aren't link-reachable (likely a client-rendered SPA)");
    expect(titles).toContain("Strengthen weak task verification");
    expect(titles).toContain("Some failures are plan/sandbox limits, not product gaps");
    // High-priority recs sort first.
    expect(recs[0]!.priority).toBe("high");
    // Plan-limited task is named and framed as NOT a product gap.
    const plan = recs.find((r) => r.title.includes("plan/sandbox"))!;
    expect(plan.detail).toContain("t-plan");
    expect(plan.priority).toBe("low");
  });

  it("turns MCP-specific failures into a top tool-coverage recommendation", () => {
    const pack = makePack([
      {
        id: "gen-l1-projects",
        difficulty: "L1",
        prompt: "Create a project and add it to the portfolio.",
        create_path: "/projects",
      },
      {
        id: "gen-l2-projects-project_briefs",
        difficulty: "L2",
        prompt: "Create a project_briefs under a project.",
        create_path: "/projects/{project_gid}/project_briefs",
      },
      {
        id: "gen-l4-project-archive",
        difficulty: "L4",
        prompt: "Create a project, then archive it.",
        create_path: "/projects",
      },
    ]);
    const runs: ProfileRun[] = [
      {
        profile: "high",
        harness: "codex",
        surface: "mcp",
        discoverySource: "observed",
        discovery: discovery({}),
        outcomes: [
          outcome("gen-l1-projects", "L1", "high", false, "tools/list did not expose add project to portfolio"),
          outcome("gen-l2-projects-project_briefs", "L2", "high", false, "no gid reported by executor"),
          outcome("gen-l4-project-archive", "L4", "high", false, "tool unavailable: archive project"),
        ],
      },
      {
        profile: "high",
        harness: "codex",
        surface: "api",
        discoverySource: "observed",
        discovery: discovery({}),
        outcomes: [
          outcome("gen-l1-projects", "L1", "high", true),
          outcome("gen-l2-projects-project_briefs", "L2", "high", true),
          outcome("gen-l4-project-archive", "L4", "high", true),
        ],
      },
    ];
    const recs = buildRecommendations(pack, runs, { site: "https://demo.test", v0Score: 100, v2Score: 100 });
    expect(recs[0]!.title).toBe("Fill MCP tool coverage gaps");
    expect(recs[0]!.target).toContain("add project to portfolio");
    expect(recs[0]!.target).toContain("create project brief");
    expect(recs[0]!.target).toContain("archive/update project");

    const html = renderGeneratedReport(pack, runs, { site: "https://demo.test", v0Score: 100, v2Score: 100 });
    expect(html).toContain("weakest config is codex/MCP/high");
    expect(html).toContain("best config");

    const gated = renderGeneratedReport(pack, runs, { site: "https://demo.test", v0Score: 100, v2Score: 100 }, undefined, {
      minPassRate: 0.4,
    });
    expect(gated).toContain("ax-gate--warn");
    expect(gated).toContain("Overall gate: PASS · Surface gate: FAIL");
    expect(gated).toContain("Surface subgates:");
    expect(gated).toContain("API PASS 100%");
    expect(gated).toContain("MCP FAIL 0%");
  });

  it("adds a Scores footnote when a surface uses a narrower task subset", () => {
    const pack = makePack([
      { id: "api-l1", difficulty: "L1", prompt: "Create a customer.", allowed_surfaces: ["api", "mcp"] },
      { id: "api-l2", difficulty: "L2", prompt: "Create a price.", allowed_surfaces: ["api", "mcp"] },
      { id: "api-l3", difficulty: "L3", prompt: "Create a subscription.", allowed_surfaces: ["api"] },
      { id: "api-l4", difficulty: "L4", prompt: "Create a checkout session.", allowed_surfaces: ["api"] },
    ]);
    const runs: ProfileRun[] = [
      {
        profile: "low",
        harness: "codex",
        surface: "mcp",
        outcomes: [outcome("api-l1", "L1", "low", true), outcome("api-l2", "L2", "low", true)],
      },
      {
        profile: "low",
        harness: "codex",
        surface: "api",
        outcomes: [
          outcome("api-l1", "L1", "low", true),
          outcome("api-l2", "L2", "low", true),
          outcome("api-l3", "L3", "low", true),
          outcome("api-l4", "L4", "low", true),
        ],
      },
    ];

    const html = renderGeneratedReport(pack, runs);
    expect(html).toContain("<strong>Footnote.</strong>");
    expect(html).toContain("MCP is scored on a surface-aware subset in this report: 2/4 task(s) total");
    expect(html).toContain("L1 1, L2 1, L3 0, L4 0");
    expect(html).toContain("A 0/0 cell means there were no scored tasks for that surface in that difficulty bucket");
  });

  it("keeps MCP approval cancellations separate from missing tool coverage", () => {
    const pack = makePack([
      {
        id: "gen-l2-projects-project_briefs",
        difficulty: "L2",
        prompt: "Create a project_briefs under a project.",
        create_path: "/projects/{project_gid}/project_briefs",
      },
      {
        id: "gen-l4-task-complete",
        difficulty: "L4",
        prompt: "Create a task, then mark it complete.",
        create_path: "/tasks",
      },
    ]);
    const runs: ProfileRun[] = [
      {
        profile: "low",
        harness: "codex",
        surface: "mcp",
        discoverySource: "observed",
        discovery: discovery({}),
        trace: [
          {
            step: 1,
            taskId: "gen-l2-projects-project_briefs",
            action: "create project",
            method: "POST",
            path: "/projects",
            status: 201,
            note: "created project; no discovered project-brief tool",
          },
          {
            step: 2,
            taskId: "gen-l4-task-complete",
            action: "mark task complete",
            method: "PUT",
            path: "/tasks/1",
            status: 499,
            note: "user cancelled MCP tool call",
          },
        ],
        outcomes: [
          outcome("gen-l2-projects-project_briefs", "L2", "low", false, "no gid reported by executor"),
          outcome("gen-l4-task-complete", "L4", "low", false, "no gid reported by executor"),
        ],
      },
    ];
    const recs = buildRecommendations(pack, runs, { site: "https://demo.test", v0Score: 100, v2Score: 100 });
    const coverage = recs.find((r) => r.title === "Fill MCP tool coverage gaps")!;
    expect(coverage.target).toContain("create project brief");
    expect(coverage.target).not.toContain("complete/update task");

    const approval = recs.find((r) => r.title === "Separate MCP approval failures from tool coverage")!;
    expect(approval.evidence).toContain("user cancelled MCP tool call");
  });

  it("recommends machine-readable discovery entrypoints and pass@k for single-attempt runs", () => {
    const pack = makePack([{ id: "t1", difficulty: "L1", prompt: "do a thing" }]);
    const runs: ProfileRun[] = [
      {
        profile: "high",
        harness: "codex",
        surface: "api",
        outcomes: [outcome("t1", "L1", "high", true)],
      },
    ];
    const stat: StaticReadiness = {
      site: "https://demo.test",
      v0Score: 50,
      v2Score: 0,
      v0Checks: [
        { id: "openapi", label: "OpenAPI spec", status: "fail", weight: 3, detail: "not linked", source: "live" },
        { id: "mcp-server", label: "MCP server", status: "fail", weight: 2, detail: "not advertised", source: "live" },
        { id: "robots-sitemap", label: "Sitemap", status: "fail", weight: 1, detail: "missing", source: "live" },
        { id: "auth-discovery", label: "OAuth discovery", status: "fail", weight: 1, detail: "missing", source: "live" },
      ],
    };
    const recs = buildRecommendations(pack, runs, stat);
    const entry = recs.find((r) => r.title === "Publish machine-readable discovery entrypoints")!;
    expect(entry.detail).toContain("discoverable OpenAPI link");
    expect(entry.detail).toContain("MCP descriptor / endpoint");
    expect(entry.detail).toContain("sitemap.xml");
    expect(entry.detail).toContain("OAuth authorization-server discovery");
    expect(recs.map((r) => r.title)).toContain("Re-run with pass@k before treating results as stable");
  });

  it("recommends discovery/AEO fixes when official + canonical are missed", () => {
    const pack = makePack([{ id: "t1", difficulty: "L1", prompt: "do a thing" }]);
    const runs: ProfileRun[] = [
      {
        profile: "live", // unregistered profile name
        ns: "n4k2",
        discovery: discovery({ official: false, canonical: false }),
        outcomes: [outcome("t1", "L1", "live", false)],
      },
    ];
    const stat: StaticReadiness = { site: "https://demo.test", v0Score: 80, v2Score: 5 };
    const recs = buildRecommendations(pack, runs, stat);
    const titles = recs.map((r) => r.title);
    expect(titles).toContain("Agents never reached your official docs");
    expect(titles).toContain("Official docs don't surface the canonical endpoint");
    expect(titles).toContain("Docs aren't link-reachable (likely a client-rendered SPA)");

    // Methodology renders an unregistered profile gracefully ("unregistered", not "?").
    const html = renderGeneratedReport(pack, runs, stat);
    expect(html).toContain("unregistered");
    expect(html).not.toMatch(/<td>\?<\/td>/);
  });

  it("attributes a failure to the product when canonical held, even if official was missed", () => {
    // The agent never opened the official docs (official=false) but DID find and
    // use the canonical endpoint (canonical=true), then failed a task. That is a
    // product/docs gap, NOT a discovery block — only `canonical` should gate.
    const pack = makePack([{ id: "t-prod", difficulty: "L1", prompt: "Create a widget." }]);
    const runs: ProfileRun[] = [
      {
        profile: "ceiling",
        ns: "n-1",
        discovery: discovery({ official: false, canonical: true }),
        outcomes: [outcome("t-prod", "L1", "ceiling", false, "no gid reported by executor")],
      },
    ];
    const stat: StaticReadiness = { site: "https://demo.test", v0Score: 80, v2Score: 70 };
    const recs = buildRecommendations(pack, runs, stat);
    expect(recs.map((r) => r.title)).toContain("Product/docs gap: the strongest agent still failed");

    // The appendix must NOT label it "discovery-blocked?" (canonical held).
    const html = renderGeneratedReport(pack, runs, stat);
    expect(html).not.toContain("discovery-blocked?");
  });

  it("flags discovery-blocked only when canonical itself was missed", () => {
    const pack = makePack([{ id: "t-x", difficulty: "L1", prompt: "Create a widget." }]);
    const runs: ProfileRun[] = [
      {
        profile: "ceiling",
        ns: "n-2",
        discovery: discovery({ canonical: false }),
        outcomes: [outcome("t-x", "L1", "ceiling", false, "no gid reported by executor")],
      },
    ];
    const stat: StaticReadiness = { site: "https://demo.test", v0Score: 80, v2Score: 70 };
    const html = renderGeneratedReport(pack, runs, stat);
    expect(html).toContain("discovery-blocked?");
    // A canonical-blocked failure is not attributed to the product/docs.
    const recs = buildRecommendations(pack, runs, stat);
    expect(recs.map((r) => r.title)).not.toContain("Product/docs gap: the strongest agent still failed");
  });

  it("renders a Run configuration block (scope, not cost)", () => {
    const pack = makePack([
      { id: "t1", difficulty: "L1", prompt: "alpha" },
      { id: "t2", difficulty: "L2", prompt: "beta" },
    ]);
    const runs: ProfileRun[] = [
      { profile: "floor", outcomes: [outcome("t1", "L1", "floor", true), outcome("t2", "L2", "floor", false)] },
      { profile: "ceiling", outcomes: [outcome("t1", "L1", "ceiling", true), outcome("t2", "L2", "ceiling", true)] },
    ];
    const html = renderGeneratedReport(pack, runs);
    expect(html).toContain("Run configuration");
    expect(html).toContain("attempts per task");
    expect(html).toContain("turn budget");
    expect(html).not.toContain("Run cost");
  });

  it("methodology note explains the effort-only spread without surfacing matrix/paid framing", () => {
    const pack = makePack([{ id: "t1", difficulty: "L1", prompt: "do a thing" }]);
    const runs: ProfileRun[] = [
      { profile: "floor", outcomes: [outcome("t1", "L1", "floor", true)] },
      { profile: "ceiling", outcomes: [outcome("t1", "L1", "ceiling", true)] },
    ];
    const html = renderGeneratedReport(pack, runs);
    expect(html).toContain("effort only");
    expect(html).not.toContain("matrix mode");
    expect(html).not.toContain("paid tier");
    expect(html).not.toContain("付费");
  });

  it("gives a positive 'raise the bar' note when everything passes", () => {
    const pack = makePack([
      { id: "t1", difficulty: "L1", prompt: "alpha" },
      { id: "t2", difficulty: "L4", prompt: "beta" },
    ]);
    const runs: ProfileRun[] = [
      {
        profile: "ceiling",
        discovery: discovery({}),
        outcomes: [outcome("t1", "L1", "ceiling", true), outcome("t2", "L4", "ceiling", true)],
      },
    ];
    const stat: StaticReadiness = { site: "https://demo.test", v0Score: 100, v2Score: 95 };
    const recs = buildRecommendations(pack, runs, stat);
    expect(recs.map((r) => r.title)).toContain("All tasks pass — raise the bar");

    const html = renderGeneratedReport(pack, runs, stat);
    expect(html).toContain("ax-card--pass"); // gap ≤ 0 → pass coloring
    expect(html).toContain("Strong agent operability");
  });

  it("renders a CI-gate banner that fails below and passes above the threshold", () => {
    const { pack, runs, stat } = comprehensiveScenario();
    // comprehensive best/overall pass rate is well under 90%.
    const failHtml = renderGeneratedReport(pack, runs, stat, undefined, { minPassRate: 0.9 });
    expect(failHtml).toContain("ax-gate--fail");
    expect(failHtml).toContain("Overall gate: FAIL");
    expect(failHtml).toContain("required minimum of 90%");

    const passHtml = renderGeneratedReport(pack, runs, stat, undefined, { minPassRate: 0.1 });
    expect(passHtml).toContain("ax-gate--pass");
    expect(passHtml).toContain("Overall gate: PASS");

    // No gate flag ⇒ no banner.
    const noGate = renderGeneratedReport(pack, runs, stat);
    expect(noGate).not.toContain("Overall gate:");
  });

  it("surfaces runtime warnings in Methodology when the CLI passes them", () => {
    const { pack, runs, stat } = comprehensiveScenario();
    const html = renderGeneratedReport(pack, runs, stat, undefined, {
      gate: { minPassRate: 0.1 },
      warnings: [
        "No trace file at run-floor-a3.trace.json — trace checks fall back to self-report.",
        "Static v2 discover failed: connection refused.",
      ],
    });
    expect(html).toContain("ax-warnings");
    expect(html).toContain("Runtime notes &amp; caveats");
    expect(html).toContain("No trace file at run-floor-a3.trace.json");
    expect(html).toContain("Static v2 discover failed: connection refused.");

    const sampleHtml = renderGeneratedReport(pack, runs, stat, undefined, {
      warnings: ["Fake data only: this report is for layout review."],
    });
    expect(sampleHtml).toContain("Sample data only");
    expect(sampleHtml).toContain("Fake data only: this report is for layout review.");

    // Empty warnings ⇒ no block (don't pollute clean reports).
    const cleanHtml = renderGeneratedReport(pack, runs, stat, undefined, {
      gate: { minPassRate: 0.1 },
      warnings: [],
    });
    expect(cleanHtml).not.toContain("Runtime notes");
  });

  it("reports host-agent robustness (pass@k) across attempts and flags flaky tasks", () => {
    const pack = makePack([
      { id: "t-a", difficulty: "L1", prompt: "always works" },
      { id: "t-b", difficulty: "L2", prompt: "flaky" },
    ]);
    // 3 attempts, merged into one run: t-a passes 3/3, t-b passes 1/3.
    const outcomes: RoundtripOutcome[] = [
      outcome("t-a", "L1", "ceiling", true),
      outcome("t-b", "L2", "ceiling", true),
      outcome("t-a", "L1", "ceiling", true),
      outcome("t-b", "L2", "ceiling", false),
      outcome("t-a", "L1", "ceiling", true),
      outcome("t-b", "L2", "ceiling", false),
    ];
    const runs: ProfileRun[] = [{ profile: "ceiling", discovery: discovery({}), outcomes }];
    const html = renderGeneratedReport(pack, runs);
    expect(html).toContain("Robustness (pass@k)");
    expect(html).toContain("all-k");
    // pass@k = both solved at least once (2/2); all-k = only t-a (1/2); flaky = t-b.
    expect(html).toContain("t-b (1/3)");
    // Appendix shows the per-attempt vector.
    expect(html).toContain("passed 1/3 attempts");
    expect(html).toContain("passed 3/3 attempts");
  });

  it("surfaces structural trace diffs (missing + forbidden) against task constraints", () => {
    const pack = TargetPackSchema.parse({
      name: "trace-demo",
      base_url: "https://api.demo.test",
      tasks: [
        {
          id: "t-life",
          difficulty: "L4",
          prompt: "Create a widget, then do not delete it.",
          create_path: "/widgets",
          oracles: [{ type: "roundtrip", readPathTemplate: "/widgets/{gid}", assertField: "ok", expected: true }],
          trace: [{ type: "forbidden_call", taskId: "t-life", method: "DELETE", path: "/widgets/123" }],
        },
      ],
    });
    const runs: ProfileRun[] = [
      {
        profile: "ceiling",
        outcomes: [outcome("t-life", "L4", "ceiling", false)],
        // Observed: a forbidden DELETE, and no required POST /widgets create.
        trace: [
          { step: 1, taskId: "t-life", action: "delete", method: "DELETE", path: "/widgets/123", status: 204 },
        ],
      },
    ];
    const html = renderGeneratedReport(pack, runs);
    expect(html).toContain("Trace checks");
    expect(html).toContain("forbidden_call");
    expect(html).toContain("missing_call");
    // The observed call is rendered in the appendix trace list.
    expect(html).toContain("DELETE /widgets/123");
  });

  it("surfaces evidence file paths (results / trace / transcript) when provided", () => {
    const pack = makePack([{ id: "t1", difficulty: "L1", prompt: "do a thing" }]);
    const runs: ProfileRun[] = [
      {
        profile: "ceiling",
        outcomes: [outcome("t1", "L1", "ceiling", true)],
        evidence: {
          results: ["runs/2026-06-05-demo/run-ceiling-a1.json", "runs/2026-06-05-demo/run-ceiling-a2.json"],
          trace: ["runs/2026-06-05-demo/run-ceiling-a1.trace.json"],
          transcript: "runs/2026-06-05-demo/transcript-ceiling.txt",
        },
      },
    ];
    const html = renderGeneratedReport(pack, runs);
    expect(html).toContain("Evidence files (per config)");
    expect(html).toContain("run-ceiling-a1.json");
    expect(html).toContain("run-ceiling-a2.json");
    expect(html).toContain("run-ceiling-a1.trace.json");
    expect(html).toContain("transcript-ceiling.txt");
  });

  it("omits the evidence subsection when no run carries paths", () => {
    const pack = makePack([{ id: "t1", difficulty: "L1", prompt: "do a thing" }]);
    const runs: ProfileRun[] = [{ profile: "ceiling", outcomes: [outcome("t1", "L1", "ceiling", true)] }];
    const html = renderGeneratedReport(pack, runs);
    expect(html).not.toContain("Evidence files (per profile)");
  });

  it("notes when no traces were captured", () => {
    const pack = makePack([{ id: "t1", difficulty: "L1", prompt: "do a thing" }]);
    const runs: ProfileRun[] = [{ profile: "ceiling", outcomes: [outcome("t1", "L1", "ceiling", true)] }];
    const html = renderGeneratedReport(pack, runs);
    expect(html).toContain("No structured traces were captured");
  });

  it("writes a sample HTML artifact for eyeballing", () => {
    const { pack, runs, stat } = comprehensiveScenario();
    const ceiling = runs.find((r) => r.profile === "ceiling")!;

    // Make the sample exercise the new sections: 3 attempts on the ceiling profile
    // (t-prod is flaky: 1/3) so Robustness (pass@k) has something to show.
    ceiling.outcomes.push(
      outcome("t-pass-1", "L1", "ceiling", true),
      outcome("t-pass-2", "L1", "ceiling", true),
      outcome("t-prod", "L4", "ceiling", true),
      outcome("t-plan", "L3", "ceiling", false, "402 premium-only"),
      outcome("t-weak", "L2", "ceiling", true, "id exists"),
      outcome("t-pass-1", "L1", "ceiling", true),
      outcome("t-pass-2", "L1", "ceiling", true),
      outcome("t-prod", "L4", "ceiling", false, "ok=false expected=true"),
      outcome("t-plan", "L3", "ceiling", false, "402 premium-only"),
      outcome("t-weak", "L2", "ceiling", true, "id exists"),
    );

    // Add a forbidden-call constraint + an observed violation so Trace checks
    // shows a real structural diff in the sample.
    pack.tasks.find((t) => t.id === "t-weak")!.trace = [
      { type: "forbidden_call", taskId: "t-weak", method: "DELETE", path: "/x/legacy", description: "no destructive delete" },
    ];
    ceiling.trace = [
      ...(ceiling.trace ?? []),
      { step: 1, taskId: "t-weak", action: "delete legacy", method: "DELETE", path: "/x/legacy", status: 204 },
    ];

    // Surface evidence paths so the rendered sample shows the Evidence subsection.
    const floor = runs.find((r) => r.profile === "floor")!;
    floor.evidence = {
      results: ["runs/sample/run-floor.json"],
      trace: ["runs/sample/run-floor.trace.json"],
      transcript: "runs/sample/transcript-floor.txt",
    };
    ceiling.evidence = {
      results: [
        "runs/sample/run-ceiling-a1.json",
        "runs/sample/run-ceiling-a2.json",
        "runs/sample/run-ceiling-a3.json",
      ],
      trace: [
        "runs/sample/run-ceiling-a1.trace.json",
        "runs/sample/run-ceiling-a2.trace.json",
        "runs/sample/run-ceiling-a3.trace.json",
      ],
      transcript: "runs/sample/transcript-ceiling.txt",
    };

    // Add the content-quality axis so the sample shows the full pipeline.
    const audit = smellyAudit();
    const statCQ: StaticReadiness = { ...stat, contentScore: audit.score, contentQuality: audit };

    const html = renderGeneratedReport(pack, runs, statCQ, undefined, { minPassRate: 0.8 });
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const out = resolve(root, "results", "sample", "generated-eval.html");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, html);
    expect(html.length).toBeGreaterThan(2000);
    expect(html).toContain("Robustness (pass@k)");
    expect(html).toContain("Overall gate:");
    expect(html).toContain("forbidden_call");
    expect(html).toContain("Content quality (spec smells)");
  });
});
