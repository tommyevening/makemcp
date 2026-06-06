/**
 * Ingests Make's full public app catalog (~3000+ apps) into the `apps` table,
 * so the agent knows which integrations exist even before any module schema is
 * loaded. Module schemas are resolved later (SDK for opensource apps, blueprint
 * mining / lazy fetch for native apps).
 *
 * Source: Make's integrations sitemap (English /en/integrations/{slug} URLs).
 * Cloudflare blocks plain curl/fetch without a browser User-Agent, so we read
 * from a downloaded XML file:
 *
 *   1) curl -A "<browser UA>" https://www.make.com/en/pw-api/sitemaps/integrations-sitemap.xml -o data/cache/integrations-sitemap.xml
 *   2) npx tsx src/knowledge/catalog.ts data/cache/integrations-sitemap.xml
 *
 * If no file arg is given it attempts a direct fetch (may be Cloudflare-blocked).
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, isAbsolute } from "node:path";
import { MakeKnowledgeDB } from "../db/database.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const DB_PATH = join(ROOT, "data", "make.db");
const SITEMAP_URL = "https://www.make.com/en/pw-api/sitemaps/integrations-sitemap.xml";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const log = (m: string) => process.stderr.write(m + "\n");

function humanize(slug: string): string {
  return slug
    .replace(/-community$/, "")
    .split("-")
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

function slugsFromXml(xml: string): string[] {
  const set = new Set<string>();
  const re = /https:\/\/www\.make\.com\/en\/integrations\/([a-z0-9][a-z0-9-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) set.add(m[1]);
  return [...set].sort();
}

async function getXml(): Promise<string> {
  const arg = process.argv[2];
  if (arg) {
    const p = isAbsolute(arg) ? arg : join(ROOT, arg);
    if (!existsSync(p)) throw new Error(`Sitemap file not found: ${p}`);
    return readFileSync(p, "utf8");
  }
  log(`Fetching ${SITEMAP_URL} (no file arg given)...`);
  const res = await fetch(SITEMAP_URL, { headers: { "User-Agent": UA, Accept: "application/xml,text/html;q=0.9,*/*;q=0.8" } });
  if (!res.ok) throw new Error(`Fetch failed ${res.status}. Cloudflare likely blocked it — download via curl with a browser UA and pass the file path.`);
  return res.text();
}

async function main(): Promise<void> {
  if (!existsSync(DB_PATH)) {
    log(`No DB at ${DB_PATH}. Run \`npm run build:db\` first.`);
    process.exit(1);
  }
  const xml = await getXml();
  const slugs = slugsFromXml(xml);
  if (slugs.length === 0) {
    log("No integration slugs found in the XML. Wrong file or Cloudflare challenge page?");
    process.exit(1);
  }

  const db = new MakeKnowledgeDB(DB_PATH, { readOnly: false });
  db.initSchema();
  for (const slug of slugs) db.upsertCatalogApp(slug, humanize(slug));
  const total = db.catalogCount();
  const stats = db.stats();
  db.close();
  log(`Ingested ${slugs.length} catalog apps. Catalog total: ${total}. DB apps row count: ${stats.apps}.`);
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
