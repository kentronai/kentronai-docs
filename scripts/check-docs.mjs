#!/usr/bin/env node
/**
 * Validation harness for the Receipt documentation site. Zero dependencies.
 *
 *   node scripts/check-docs.mjs             construction mode
 *   node scripts/check-docs.mjs --complete  release mode: every nav entry must have a file
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const COMPLETE = process.argv.includes('--complete')
const errors = []
const fail = (m) => errors.push(m)

if (!existsSync(join(ROOT, 'docs.json'))) {
  console.error('docs.json not found; run from the repository root')
  process.exit(1)
}
const config = JSON.parse(readFileSync(join(ROOT, 'docs.json'), 'utf8'))

// --- navigation ------------------------------------------------------------
const collect = (node, out = []) => {
  if (typeof node === 'string') out.push(node)
  else if (Array.isArray(node)) node.forEach((n) => collect(n, out))
  else if (node && typeof node === 'object')
    for (const k of ['tabs', 'anchors', 'products', 'menu', 'groups', 'pages'])
      if (node[k]) collect(node[k], out)
  return out
}
const navPages = collect(config.navigation)
const navSet = new Set(navPages)
const seen = new Set()
for (const p of navPages) {
  if (seen.has(p)) fail(`nav: "${p}" appears more than once in navigation`)
  seen.add(p)
}

// --- content files ---------------------------------------------------------
const SKIP = new Set([
  '.git', '.github', '.superpowers', 'node_modules',
  'docs', 'research', 'scripts',
  'logo', 'public', 'images', 'snippets',
])
// Repository documentation, not site content; also listed in .mintignore.
const SKIP_FILES = new Set(['README.md'])
const files = []
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry) || SKIP_FILES.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full)
    else if (/\.mdx?$/.test(entry)) files.push(relative(ROOT, full))
  }
}
walk(ROOT)
const slugOf = (f) => f.replace(/\.mdx?$/, '')
const fileSlugs = new Set(files.map(slugOf))

for (const f of files) {
  if (!navSet.has(slugOf(f))) fail(`orphan: ${f} is not referenced in docs.json navigation`)
}
if (COMPLETE) {
  for (const p of navPages) {
    if (!fileSlugs.has(p)) fail(`missing: navigation lists "${p}" but no file exists`)
  }
}

// --- frontmatter -----------------------------------------------------------
for (const f of files) {
  const text = readFileSync(join(ROOT, f), 'utf8')
  const m = text.match(/^---\n([\s\S]*?)\n---/)
  if (!m) { fail(`frontmatter: ${f} has no frontmatter block`); continue }
  // Strip surrounding quotes before testing, so `title: ""` does not pass.
  const raw = m[1].match(/^title:\s*(.+?)\s*$/m)
  const title = raw ? raw[1].replace(/^["']|["']$/g, '').trim() : ''
  if (!title) fail(`frontmatter: ${f} has no title`)
}

// --- internal links --------------------------------------------------------
const known = new Set([...fileSlugs, ...navSet])
const redirectSources = new Set((config.redirects ?? []).map((r) => r.source.replace(/^\//, '')))
for (const f of files) {
  const text = readFileSync(join(ROOT, f), 'utf8')
  const targets = [
    ...[...text.matchAll(/\]\((\/[^)\s#]*)(#[^)\s]*)?\)/g)].map((x) => x[1]),
    ...[...text.matchAll(/href="(\/[^"#]*)(#[^"]*)?"/g)].map((x) => x[1]),
  ]
  for (const t of targets) {
    const slug = t.replace(/^\//, '').replace(/\/$/, '')
    if (!slug) continue
    // A target ending in a file extension is an asset reference, not a page link.
    if (/\.[a-z0-9]{2,4}$/i.test(slug)) continue
    if (!known.has(slug) && !redirectSources.has(slug)) {
      fail(`link: ${f} -> /${slug} does not resolve`)
    }
  }
}

// --- images ----------------------------------------------------------------
// Every /images/... reference (markdown image, <img src>, or <Frame> child)
// must resolve to a file on disk. Mintlify serves a missing image as a broken
// picture without failing the build, so this is the only place it is caught.
for (const f of files) {
  const text = readFileSync(join(ROOT, f), 'utf8')
  const refs = [
    ...[...text.matchAll(/!\[[^\]]*\]\((\/images\/[^)\s]+)\)/g)].map((x) => x[1]),
    ...[...text.matchAll(/src="(\/images\/[^"]+)"/g)].map((x) => x[1]),
  ]
  for (const r of refs) {
    if (!existsSync(join(ROOT, r))) fail(`image: ${f} references ${r} which does not exist`)
  }
}

// --- redirects -------------------------------------------------------------
for (const r of config.redirects ?? []) {
  const src = r.source.replace(/^\//, '')
  if (fileSlugs.has(src)) fail(`redirect: source /${src} collides with a real page`)
  const dest = r.destination.replace(/^\//, '')
  if (!dest.includes(':') && !navSet.has(dest)) {
    fail(`redirect: destination /${dest} is not a navigation page`)
  }
}

// --- publication safety ----------------------------------------------------
// 123456789012 is the sanctioned documentation placeholder and is allowed everywhere.
const FORBIDDEN = [
  [/\b(?!123456789012\b)\d{12}\b/, 'a 12-digit account number'],
  [/\b\d{3}[- ]\d{3}[- ]\d{3}[- ]\d{3}\b/, 'a separator-formatted 12-digit account number'],
  [/\b\d{4}[- ]\d{4}[- ]\d{4}\b/, 'a separator-formatted 12-digit account number'],
  [/arn:aws:iam::(?!123456789012:)\d{12}:/, 'a real IAM ARN'],
  [/\bi-[0-9a-f]{8,17}\b/, 'an EC2 instance id'],
  // Excludes private ranges plus the RFC 5737 documentation ranges and link-local.
  [/\b(?!127\.|0\.|10\.|169\.254\.|192\.168\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|172\.(?:1[6-9]|2\d|3[01])\.|255\.)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, 'a public IP address'],
  [/\/Users\/(?!me\b)[A-Za-z0-9._-]+/, 'a personal home directory path'],
  [/\b[a-z0-9-]+\.[a-z0-9-]+\.ts\.net\b/, 'a private tailnet hostname'],
  [/AWS_PROFILE=beetle\b|--aws-profile beetle\b|\bbeetle-deploy\b|\bbeetle-production\b/, 'an internal AWS profile or deploy resource name'],
  // Both spellings of the legacy marketing domain: the forward form, and the
  // reverse-DNS form that macOS service identifiers use. The one exception is
  // `run.beetle.clauden-observer`, the launchd label the CLI actually installs:
  // a reader has to type it to find the file, so the docs must print it.
  [/\bbeetle\.run\b|\brun\.beetle(?!\.clauden-observer\b)/, 'the legacy marketing domain'],
  [/\b(Satish|knsre)\b/, 'a named individual or IAM user'],
]
for (const f of files) {
  const text = readFileSync(join(ROOT, f), 'utf8')
  for (const [re, label] of FORBIDDEN) {
    const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
    for (const hit of text.matchAll(global)) {
      fail(`safety: ${f} contains ${label} ("${hit[0]}")`)
    }
  }
}

// --- publication safety: screenshots ---------------------------------------
// Screenshots are captured from a live, signed-in session, which makes them the
// highest-risk artefact on the site and the one the text rules above never see.
// Every image must be listed here by a human who has looked at it, so that a
// newly added capture fails the build until someone has done that.
const REVIEWED_IMAGES_FILE = 'images/REVIEWED.txt'
if (existsSync(join(ROOT, 'images'))) {
  const imageFiles = []
  const walkImages = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walkImages(full)
      else if (/\.(png|jpe?g|gif|webp|svg)$/i.test(entry)) imageFiles.push(relative(ROOT, full))
    }
  }
  walkImages(join(ROOT, 'images'))

  if (!existsSync(join(ROOT, REVIEWED_IMAGES_FILE))) {
    fail(`safety: ${REVIEWED_IMAGES_FILE} is missing; every screenshot must be signed off in it`)
  } else {
    const reviewed = new Set(
      readFileSync(join(ROOT, REVIEWED_IMAGES_FILE), 'utf8')
        .split('\n')
        .map((l) => l.replace(/#.*$/, '').trim())
        .filter(Boolean),
    )
    for (const img of imageFiles) {
      if (!reviewed.has(img)) {
        fail(`safety: ${img} is not signed off in ${REVIEWED_IMAGES_FILE}; look at it, confirm it shows no real name, email, IP, account or instance id, then add it`)
      }
    }
    for (const r of reviewed) {
      if (!existsSync(join(ROOT, r))) fail(`safety: ${REVIEWED_IMAGES_FILE} lists ${r}, which does not exist`)
    }
  }
}

// --- report ----------------------------------------------------------------
if (errors.length) {
  console.error(`\n${errors.length} problem(s):\n`)
  errors.forEach((e, i) => console.error(`  ${i + 1}. ${e}`))
  console.error('')
  process.exit(1)
}
console.log(`OK  ${files.length} pages, ${navPages.length} navigation entries${COMPLETE ? ', complete' : ''}`)
