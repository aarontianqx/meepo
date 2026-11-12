import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.moon', 'dist', 'build', 'coverage']);

function slugify(heading) {
  return heading
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim()
    .toLowerCase()
    .replace(/[`*~]/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-');
}

function stripFencedCode(markdown) {
  return markdown.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, '');
}

function collectMarkdown(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectMarkdown(full, out);
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

const files = collectMarkdown(ROOT);
const anchorsByFile = new Map();

for (const file of files) {
  const clean = stripFencedCode(fs.readFileSync(file, 'utf8'));
  const anchors = new Set();
  for (const line of clean.split(/\r?\n/)) {
    const match = line.match(/^#{1,6}\s+(.+)$/);
    if (match) anchors.add(slugify(match[1]));
  }
  anchorsByFile.set(path.resolve(file), anchors);
}

const errors = [];
const specsCharter = path.resolve(ROOT, 'specs/README.md');
const indexedEvergreen = new Set();

for (const file of files) {
  const relFile = path.relative(ROOT, file).split(path.sep).join('/');
  const raw = fs.readFileSync(file, 'utf8');
  const clean = stripFencedCode(raw);
  const isEvergreen =
    relFile.startsWith('specs/architecture/') || relFile.startsWith('specs/features/');

  if (isEvergreen) {
    const headLines = clean
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 3);
    if (!headLines[0]?.startsWith('# ') || !headLines[1]?.startsWith('> **Scope**:')) {
      errors.push(
        `${relFile}: evergreen specs must start with "# <Title>" followed by "> **Scope**: ..."`
      );
    }
  }

  const linkRe = /\[[^\]]+\]\(([^)]+)\)/g;
  let match;
  while ((match = linkRe.exec(clean)) !== null) {
    const href = match[1].trim();
    if (/^(https?:|mailto:)/.test(href)) continue;

    if (href.startsWith('#')) {
      const anchor = href.slice(1);
      if (!anchorsByFile.get(path.resolve(file))?.has(anchor)) {
        errors.push(`${relFile}: broken local anchor "${href}"`);
      }
      continue;
    }

    const [targetPart, anchor] = href.split('#');
    const resolved = path.resolve(path.dirname(file), targetPart);
    if (!fs.existsSync(resolved)) {
      errors.push(`${relFile}: broken relative link "${href}"`);
      continue;
    }

    const relTarget = path.relative(ROOT, resolved).split(path.sep).join('/');
    if (isEvergreen && relTarget.startsWith('specs/proposals/')) {
      errors.push(`${relFile}: evergreen specs must not link to proposals ("${href}")`);
    }
    if (path.resolve(file) === specsCharter) {
      indexedEvergreen.add(relTarget);
    }
    if (anchor && resolved.endsWith('.md') && !anchorsByFile.get(resolved)?.has(anchor)) {
      errors.push(`${relFile}: broken heading anchor "${href}"`);
    }
  }
}

for (const sub of ['specs/architecture', 'specs/features']) {
  for (const name of fs.readdirSync(path.join(ROOT, sub))) {
    if (!name.endsWith('.md')) continue;
    const rel = `${sub}/${name}`;
    if (!indexedEvergreen.has(rel)) {
      errors.push(`${rel}: evergreen spec is missing from specs/README.md Reading Map`);
    }
  }
}

if (errors.length > 0) {
  console.error('Specification hygiene check failed:\n' + errors.map((e) => `  - ${e}`).join('\n'));
  process.exit(1);
}
