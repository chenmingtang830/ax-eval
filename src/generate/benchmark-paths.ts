import { resolve } from "node:path";
import { assertArtifactSegment } from "./artifact-path.js";

export interface BenchmarkLayout {
  root: string;
  benchmark: string;
  version: string;
  benchmark_dir: string;
  version_dir: string;
  vendors_dir: string;
  extracts_dir: string;
  packs_dir: string;
  archive_dir: string;
  suite_path: string;
  suite_concept_universe_path: string;
  suite_coverage_selection_path: string;
  suite_coverage_matrix_path: string;
  suite_trace_review_path: string;
  vendor_selection_ledger_path: string;
}

export function buildBenchmarkLayout(root: string, benchmark: string, version: string): BenchmarkLayout {
  const benchmarkSegment = assertArtifactSegment(benchmark, "benchmark slug");
  const versionSegment = assertArtifactSegment(version, "benchmark version");
  const benchmarkDir = resolve(root, "benchmarks", benchmarkSegment);
  const versionDir = resolve(benchmarkDir, versionSegment);
  return {
    root: resolve(root),
    benchmark: benchmarkSegment,
    version: versionSegment,
    benchmark_dir: benchmarkDir,
    version_dir: versionDir,
    vendors_dir: resolve(benchmarkDir, "vendors"),
    extracts_dir: resolve(versionDir, "extracts"),
    packs_dir: resolve(versionDir, "packs"),
    archive_dir: resolve(benchmarkDir, "_archive"),
    suite_path: resolve(versionDir, "suite.yaml"),
    suite_concept_universe_path: resolve(versionDir, "suite.concepts.yaml"),
    suite_coverage_selection_path: resolve(versionDir, "suite.selection.yaml"),
    suite_coverage_matrix_path: resolve(versionDir, "suite.coverage.yaml"),
    suite_trace_review_path: resolve(versionDir, "suite.trace-review.yaml"),
    vendor_selection_ledger_path: resolve(versionDir, "vendor-selection-ledger.yaml"),
  };
}

function vendorSlug(value: string): string {
  return assertArtifactSegment(value, "vendor slug");
}

export function benchmarkVendorCardPath(layout: BenchmarkLayout, vendor: string): string {
  return resolve(layout.vendors_dir, `${vendorSlug(vendor)}.discovered.yaml`);
}

export function benchmarkVendorExtractDir(layout: BenchmarkLayout, vendor: string): string {
  return resolve(layout.extracts_dir, vendorSlug(vendor));
}

export function benchmarkCapabilityInventoryPath(layout: BenchmarkLayout, vendor: string): string {
  return resolve(benchmarkVendorExtractDir(layout, vendor), "capability-inventory.yaml");
}

export function benchmarkSurfacesPath(layout: BenchmarkLayout, vendor: string): string {
  return resolve(benchmarkVendorExtractDir(layout, vendor), "surfaces.yaml");
}

export function benchmarkOraclesPath(layout: BenchmarkLayout, vendor: string): string {
  return resolve(benchmarkVendorExtractDir(layout, vendor), "oracles.yaml");
}

export function benchmarkCompiledPackPath(layout: BenchmarkLayout, vendor: string): string {
  return resolve(layout.packs_dir, vendorSlug(vendor), "pack.yaml");
}
