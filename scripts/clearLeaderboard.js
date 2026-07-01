import "dotenv/config";
import { clearScores, resetStreaks } from "../src/supabase.js";

// Quick local wipe of the leaderboard. Pass filters as flags, e.g.:
//   node scripts/clearLeaderboard.js
//   node scripts/clearLeaderboard.js --mode=apple_rush --difficulty=hard
function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

const filters = parseArgs(process.argv.slice(2));
const unfiltered = !filters.mode && !filters.difficulty && !filters.opponent;

const scores = await clearScores(filters);
const streaks = unfiltered ? await resetStreaks() : { deleted: 0 };

console.log(
  `Cleared ${scores.deleted} score row(s)${
    unfiltered ? ` and ${streaks.deleted} streak row(s)` : ` (filters: ${JSON.stringify(filters)})`
  }.`,
);
process.exit(0);
