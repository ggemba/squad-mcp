#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const bundleDir = path.resolve('agents');
const targetDir = path.resolve(process.env.USERPROFILE || process.env.HOME, '.claude', 'agents');

const SYNC_MAP = [
  { bundle: 'PO.md', target: 'product-owner.md', name: 'product-owner', defaultDesc: 'Product Owner. Validates business value, functional requirements, and UX. Use for features, business-rule changes, and user-facing surfaces.' },
  { bundle: 'Senior-Architect.md', target: 'senior-architect.md', name: 'senior-architect', defaultDesc: 'Senior Architect. Guards module boundaries, coupling, dependency direction, DI lifetimes, and scalability. Use for structural changes and new modules.' },
  { bundle: 'Senior-DBA.md', target: 'senior-dba.md', name: 'senior-dba', defaultDesc: 'Senior DBA. Reviews queries, migrations, EF mappings, cache, concurrency, and persistence stack. Use for data-layer changes.' },
  { bundle: 'Senior-Developer.md', target: 'senior-developer.md', name: 'senior-developer', defaultDesc: 'Pragmatic senior developer. Reviews technical correctness, robustness, API contracts, external integrations, observability, and application performance.' },
  { bundle: 'Senior-Dev-Reviewer.md', target: 'senior-dev-reviewer.md', name: 'senior-dev-reviewer', defaultDesc: 'Senior code reviewer. Focuses on readability, code smells, naming, idioms, async/await correctness, and error handling.' },
  { bundle: 'Senior-Dev-Security.md', target: 'senior-dev-security.md', name: 'senior-dev-security', defaultDesc: 'Application security specialist. Finds OWASP Top 10 vulnerabilities, validates authn/authz, sensitive data, input validation, and dependency CVEs.' },
  { bundle: 'Senior-QA.md', target: 'senior-qa.md', name: 'senior-qa', defaultDesc: 'Quality and testing specialist. Assesses coverage, test strategy, reliability, mocks, and missing scenarios.' },
  { bundle: 'TechLead-Planner.md', target: 'tech-lead-planner.md', name: 'tech-lead-planner', defaultDesc: 'Tech lead at plan time. Reviews proposed implementation plans BEFORE execution to catch design mistakes, misplaced complexity, and missing deploy considerations. Use for plan-stage review only — not for line-by-line code review.' },
  { bundle: 'TechLead-Consolidator.md', target: 'tech-lead-consolidator.md', name: 'tech-lead-consolidator', defaultDesc: 'Tech lead AFTER the code is written. Convergence point for advisory reports, arbitrates conflicts, issues the final merge verdict, owns rollback plan and deploy considerations.' },
];

function ensureFrontmatter(existing, name, fallbackDesc) {
  if (!existing) {
    return `---\nname: ${name}\ndescription: ${fallbackDesc}\nmodel: inherit\n---\n\n`;
  }
  const m = existing.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) {
    return `---\nname: ${name}\ndescription: ${fallbackDesc}\nmodel: inherit\n---\n\n`;
  }
  return `---\n${m[1]}\n---\n\n`;
}

let written = 0;
let created = 0;

for (const entry of SYNC_MAP) {
  const bundlePath = path.join(bundleDir, entry.bundle);
  const targetPath = path.join(targetDir, entry.target);
  if (!fs.existsSync(bundlePath)) {
    console.error(`MISSING BUNDLE: ${entry.bundle}`);
    process.exit(1);
  }
  const body = fs.readFileSync(bundlePath, 'utf8');
  const existed = fs.existsSync(targetPath);
  const existingContent = existed ? fs.readFileSync(targetPath, 'utf8') : null;
  const frontmatter = ensureFrontmatter(existingContent, entry.name, entry.defaultDesc);
  const out = frontmatter + body;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, out, 'utf8');
  if (existed) {
    written++;
    console.log(`updated: ${entry.target}`);
  } else {
    created++;
    console.log(`created: ${entry.target}`);
  }
}

const sharedDocs = ['_Severity-and-Ownership.md', 'Skill-Squad-Dev.md', 'Skill-Squad-Review.md'];
const sharedTargetDir = path.join(targetDir, '_squad-shared');
fs.mkdirSync(sharedTargetDir, { recursive: true });
for (const doc of sharedDocs) {
  const src = path.join(bundleDir, doc);
  const dst = path.join(sharedTargetDir, doc);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
    console.log(`shared: ${doc}`);
  }
}

console.log(`\nsync complete: ${created} created, ${written} updated, target=${targetDir}`);
