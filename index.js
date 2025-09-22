// index.js
import { Client, GatewayIntentBits, Partials } from "discord.js";
import { createClient } from "@supabase/supabase-js";

const {
  DISCORD_TOKEN,
  GUILD_ID,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
} = process.env;

if (!DISCORD_TOKEN || !GUILD_ID || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing env vars: DISCORD_TOKEN, GUILD_ID, SUPABASE_URL, SUPABASE_SERVICE_KEY");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember],
});

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

/* ----- Role maps (your IDs) ----- */

// Tiers
const TIER_ROLE_IDS = {
  T1: "1409930511744368700",
  T2: "1409930635929456640",
  T3: "1409930709816184882",
  T4: "1409930791844315186",
};

// Positions
const POSITION_ROLE_IDS = {
  TOP: "1409984458341351427",
  JGL: "1409984541489365161",
  JUNGLE: "1409984541489365161",
  MID: "1409984658955046933",
  ADC: "1409984744061534219",
  BOT: "1409984744061534219",
  SUP: "1409984748784324669",
  SUPPORT: "1409984748784324669",
};

// Baseline / Flags
const BASE_ROLES = {
  PLAYER: "1409185696010342512",
  SCOUT: "1413636425814904853",
  LFT: "1416144951305306202",
};

// ERLs
const ERL_ROLE_IDS = {
  LFL: "1413612125078814903",
  PRM: "1413906613525545010",
  NLC: "1413906657976516648",
  TCL: "1413906848699912264",
  HM:  "1413906878357962843",
};

/* ----- Helpers ----- */

const allKnownTierRoleIds = new Set(Object.values(TIER_ROLE_IDS));
const allKnownPositionRoleIds = new Set(Object.values(POSITION_ROLE_IDS));
const allKnownErlRoleIds = new Set(Object.values(ERL_ROLE_IDS));
const allKnownFlagRoleIds = new Set(Object.values(BASE_ROLES));
const ALL_KNOWN_IDS = new Set([
  ...allKnownTierRoleIds,
  ...allKnownPositionRoleIds,
  ...allKnownErlRoleIds,
  ...allKnownFlagRoleIds,
]);

const norm = (v) => (v ?? "").toString().trim().toUpperCase();

/** Effective tier: fall back to `tier` if `stasis_tier` empty */
function getEffectiveTier(row) {
  const s = norm(row.stasis_tier);
  return s !== "" ? s : norm(row.tier);
}

/** Position/role in your schema is `players.role` */
function getPositionKey(row) {
  const r = norm(row.role);
  if (r === "TOP") return "TOP";
  if (["JGL", "JUNGLE"].includes(r)) return "JGL";
  if (r === "MID") return "MID";
  if (["ADC", "BOT"].includes(r)) return "ADC";
  if (["SUP", "SUPPORT"].includes(r)) return "SUP";
  return null;
}

async function getMember(discordId) {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    return await guild.members.fetch(discordId).catch(() => null);
  } catch (e) {
    console.error("getMember:", e);
    return null;
  }
}

/** Compute desired roles for a row */
function desiredRoleIds(row) {
  const want = new Set();

  // Tier
  const t = getEffectiveTier(row);
  if (t && TIER_ROLE_IDS[t]) want.add(TIER_ROLE_IDS[t]);

  // Position
  const p = getPositionKey(row);
  if (p && POSITION_ROLE_IDS[p]) want.add(POSITION_ROLE_IDS[p]);

  // ERL
  const e = norm(row.erl);
  if (e && ERL_ROLE_IDS[e]) want.add(ERL_ROLE_IDS[e]);

  // Player baseline + flags
  want.add(BASE_ROLES.PLAYER);
  if (row.is_scout) want.add(BASE_ROLES.SCOUT);
  if (row.is_lft) want.add(BASE_ROLES.LFT);

  return want;
}

/** Reconcile member's roles to match desired set, only touching roles we manage */
async function reconcileRoles(discordId, wantSet) {
  const member = await getMember(discordId);
  if (!member) return;

  const current = new Set(member.roles.cache.map((r) => r.id));

  // Remove only roles we manage and that are not desired
  const toRemove = [...current].filter((id) => ALL_KNOWN_IDS.has(id) && !wantSet.has(id));
  // Add missing desired roles
  const toAdd = [...wantSet].filter((id) => !current.has(id));

  try {
    if (toRemove.length) await member.roles.remove(toRemove);
    if (toAdd.length) await member.roles.add(toAdd);
  } catch (e) {
    console.error(`reconcileRoles(${discordId})`, e);
  }
}

/** Handle one players row change */
async function applyFromRow(row) {
  const discordId = row.discord_id;
  if (!discordId) return; // nothing to do if not linked yet
  const want = desiredRoleIds(row);
  await reconcileRoles(discordId, want);
}

/* ----- Realtime wiring ----- */

async function startRealtime() {
  const channel = supabase.channel("players-sync");

  channel.on(
    "postgres_changes",
    { event: "*", schema: "public", table: "players" },
    async (payload) => {
      const after = payload.new ?? {};
      const before = payload.old ?? {};

      // Only act when discord_id is known
      if (payload.eventType === "INSERT" && after.discord_id) {
        await applyFromRow(after);
      } else if (payload.eventType === "UPDATE") {
        const trackedCols = ["discord_id", "tier", "stasis_tier", "role", "erl", "is_lft", "is_scout"];
        const changed = trackedCols.some((k) => before[k] !== after[k]);
        if (after.discord_id && changed) await applyFromRow(after);
      }
      // OPTIONAL: on DELETE, strip managed roles (commented out by default)
      // else if (payload.eventType === "DELETE" && before.discord_id) {
      //   await reconcileRoles(before.discord_id, new Set()); // remove all managed roles
      // }
    }
  );

  await channel.subscribe((status) => console.log("Supabase realtime:", status));
}

/* ----- Onboarding: assign roles on join if row already exists ----- */
client.on("guildMemberAdd", async (member) => {
  const { data, error } = await supabase
    .from("players")
    .select("tier, stasis_tier, role, erl, is_lft, is_scout, discord_id")
    .eq("discord_id", member.id)
    .maybeSingle();

  if (error) return console.error("join lookup error:", error);
  if (data) await applyFromRow(data);
});

/* ----- Startup ----- */
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await startRealtime();

  // One-shot reconciliation: enforce for all linked players
  const { data, error } = await supabase
    .from("players")
    .select("discord_id, tier, stasis_tier, role, erl, is_lft, is_scout")
    .not("discord_id", "is", null);

  if (error) return console.error("reconcile query error:", error);

  for (const row of data) await applyFromRow(row);
});

client.login(DISCORD_TOKEN);
