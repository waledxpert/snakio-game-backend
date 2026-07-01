import { readFileSync } from "node:fs";
import pg from "pg";
const sql = readFileSync("./supabase-schema.sql", "utf8");
const PW = "RhHYev37pWw";
const REF = "uhkraauepmrmcclcrrwh";
const targets = [
  { label: "direct-ipv6", cs: `postgresql://postgres:${PW}@db.${REF}.supabase.co:5432/postgres` },
  { label: "pooler-us-east-1:5432", cs: `postgresql://postgres.${REF}:${PW}@aws-0-us-east-1.pooler.supabase.com:5432/postgres` },
  { label: "pooler-us-east-1:6543", cs: `postgresql://postgres.${REF}:${PW}@aws-0-us-east-1.pooler.supabase.com:6543/postgres` },
];
for (const t of targets) {
  const client = new pg.Client({ connectionString: t.cs, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000 });
  try {
    await client.connect();
    await client.query(sql);
    const r = await client.query(
      "select table_name from information_schema.tables where table_schema='public' order by table_name",
    );
    console.log(`SUCCESS via ${t.label}. public tables: ${r.rows.map((x) => x.table_name).join(", ")}`);
    await client.end();
    process.exit(0);
  } catch (e) {
    console.error(`FAIL ${t.label}: ${e.message}`);
    try { await client.end(); } catch { /* ignore */ }
  }
}
process.exit(2);
