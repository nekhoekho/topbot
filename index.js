// index.js
import { Client, GatewayIntentBits, Partials } from "discord.js";
import { createClient } from "@supabase/supabase-js";

/* ================= ENV ================= */
const {
  DISCORD_TOKEN,
  GUILD_ID,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
} = process.env;

if (!DISCORD_TOKEN || !GUILD_ID || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error(
    "Missing env vars. Required: DISCORD_TOKEN, GUILD_ID, SUPABASE_URL, SUPABASE_SERVICE_KEY"
  );
  process.exit(1);
}

/* ================= DISCORD CLIENT ================= */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember],
});

/* ================= SUPABASE ================= */
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

/* ================= ROLE MAPS (YOUR IDS) ================= */
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
  HM: "1413906878357962843",
};

/* ================= HELPERS ================= */
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

function getEffectiveTier(row) {
  const s = norm(row.stasis_tier);
  return s !== "" ? s : norm(row.tier);
}

function getPositionKey(row) {
  const r = norm(row.role);
  if (r === "TOP") return "TOP";
  if (r === "MID") return "MID";
  if (r === "ADC" || r === "BOT") return "ADC";
  if (r === "SUP" || r === "SUPPORT") return "SUP";
  if (r === "JGL" || r === "JUNGLE") return "JGL";
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

  // Baseline + flags
  want.add(BASE_ROLES.PLAYER);
  if (row.is_scout) want.add(BASE_ROLES.SCOUT);
  if (row.is_lft) want.add(BASE_ROLES.LFT);

  return want;
}

async function reconcileRoles(discordId, wantSet) {
  const member = await getMember(discordId);
  if (!member) return;

  const current = new Set(member.roles.cache.map((r) => r.id));
  const toRemove = [...current].filter(
    (id) => ALL_KNOWN_IDS.has(id) && !wantSet.has(id)
  );
  const toAdd = [...wantSet].filter((id) => !current.has(id));

  try {
    if (toRemove.length) await member.roles.remove(toRemove);
    if (toAdd.length) await member.roles.add(toAdd);
  } catch (e) {
    console.error(`reconcileRoles(${discordId})`, e);
  }
}

async function applyFromRow(row) {
  const discordId = row.discord_id;
  if (!discordId) return;
  const want = desiredRoleIds(row);
  await reconcileRoles(discordId, want);
}

/* ================= AUTOLINK: FILL players.discord_id ================= */
/**
 * Attempt to link a member to a players row by matching players.discord_username
 * against username, username#discriminator, or server display name.
 * Only fills rows where discord_id IS NULL.
 */
async function tryAutolinkMember(member) {
  const username = member.user.username || "";
  const discriminator = member.user.discriminator || ""; // "0" for most new accounts
  const tag =
    discriminator && discriminator !== "0" ? `${username}#${discriminator}` : null;
  const display = member.displayName || member.nickname || null;

  const candidates = [username, tag, display].filter(Boolean).map((s) => s.trim());
  if (candidates.length === 0) return false;

  let matchedRow = null;

  // Exact match first
  for (const value of candidates) {
    const { data, error } = await supabase
      .from("players")
      .select(
        "id, discord_id, tier, stasis_tier, role, erl, is_lft, is_scout"
      )
      .eq("discord_username", value)
      .is("discord_id", null)
      .maybeSingle();

    if (error) {
      console.error("autolink select error:", error);
      return false;
    }
    if (data) {
      matchedRow = data;
      break;
    }
  }

  // Case-insensitive fallback
  if (!matchedRow) {
    for (const value of candidates) {
      const { data, error } = await supabase
        .from("players")
        .select(
          "id, discord_id, tier, stasis_tier, role, erl, is_lft, is_scout"
        )
        .ilike("discord_username", value)
        .is("discord_id", null)
        .maybeSingle();

      if (error) {
        console.error("autolink ilike error:", error);
        return false;
      }
      if (data) {
        matchedRow = data;
        break;
      }
    }
  }

  if (!matchedRow) return false;

  // Write the snowflake into players.discord_id
  const { error: updErr } = await supabase
    .from("players")
    .update({ discord_id: member.id })
    .eq("id", matchedRow.id);

  if (updErr) {
    console.error("autolink update error:", updErr);
    return false;
  }

  // Immediately apply roles
  await applyFromRow({ ...matchedRow, discord_id: member.id });
  return true;
}

/* ================= REALTIME ================= */
async function startRealtime() {
  const channel = supabase.channel("players-sync");

  channel.on(
    "postgres_changes",
    { event: "*", schema: "public", table: "players" },
    async (payload) => {
      const after = payload.new ?? {};
      const before = payload.old ?? {};

      if (payload.eventType === "INSERT") {
        if (after.discord_id) await applyFromRow(after);
        return;
      }

      if (payload.eventType === "UPDATE") {
        const tracked = [
          "discord_id",
          "tier",
          "stasis_tier",
          "role",
          "erl",
          "is_lft",
          "is_scout",
        ];
        const changed = tracked.some((k) => before[k] !== after[k]);
        if (after.discord_id && changed) await applyFromRow(after);
        return;
      }

      // OPTIONAL: on DELETE remove all managed roles
      // if (payload.eventType === "DELETE" && before.discord_id) {
      //   await reconcileRoles(before.discord_id, new Set());
      // }
    }
  );

  await channel.subscribe((status) =>
    console.log("Supabase realtime:", status)
  );
}

/* ================= EVENT HANDLERS ================= */
client.on("guildMemberAdd", async (member) => {
  // Try to autolink by discord_username
  const linked = await tryAutolinkMember(member);
  if (linked) return;

  // Otherwise, if already linked by ID, just apply roles
  const { data, error } = await supabase
    .from("players")
    .select("tier, stasis_tier, role, erl, is_lft, is_scout, discord_id")
    .eq("discord_id", member.id)
    .maybeSingle();

  if (error) return console.error("join lookup error:", error);
  if (data) await applyFromRow(data);
});

/* ================= STARTUP ================= */
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await startRealtime();

  // Bulk autolink pass for rows missing discord_id
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const members = await guild.members.fetch(); // fetch all cached members

    const { data: rows, error } = await supabase
      .from("players")
      .select(
        "id, discord_id, discord_username, tier, stasis_tier, role, erl, is_lft, is_scout"
      )
      .is("discord_id", null);

    if (!error && rows?.length) {
      // index members by possible keys
      const byName = new Map();
      members.forEach((m) => {
        const uname = m.user.username?.trim();
        const disc = m.user.discriminator;
        const tag =
          disc && disc !== "0" ? `${uname}#${disc}` : null;
        const display = m.displayName?.trim();
        [uname, tag, display]
          .filter(Boolean)
          .forEach((key) => {
            byName.set(key, m);
            byName.set(key.toLowerCase(), m);
          });
      });

      for (const row of rows) {
        const key = row.discord_username?.trim();
        if (!key) continue;
        const member =
          byName.get(key) || byName.get(key.toLowerCase());
        if (!member) continue;

        const { error: updErr } = await supabase
          .from("players")
          .update({ discord_id: member.id })
          .eq("id", row.id);

        if (updErr) {
          console.error("bulk autolink update error:", updErr);
          continue;
        }
        await applyFromRow({ ...row, discord_id: member.id });
      }
    }
  } catch (e) {
    console.error("bulk autolink pass error:", e);
  }

  // One-shot reconciliation for already-linked rows
  const { data, error } = await supabase
    .from("players")
    .select("discord_id, tier, stasis_tier, role, erl, is_lft, is_scout")
    .not("discord_id", "is", null);

  if (error) return console.error("reconcile query error:", error);
  for (const row of data) await applyFromRow(row);
});

client.login(DISCORD_TOKEN);
