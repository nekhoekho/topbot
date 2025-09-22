// index.js — DB ➜ Discord (tiers only)
// Requirements:
//  - players table has columns: discord_id (text), tier (text: T1/T2/T3/T4)
//  - Bot has Manage Roles and is ABOVE T1–T4 in the role list.

import { Client, GatewayIntentBits, Partials, PermissionsBitField } from "discord.js";
import { createClient } from "@supabase/supabase-js";

/* ========= ENV ========= */
const {
  DISCORD_TOKEN,
  GUILD_ID,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
} = process.env;

if (!DISCORD_TOKEN || !GUILD_ID || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing env vars. Required: DISCORD_TOKEN, GUILD_ID, SUPABASE_URL, SUPABASE_SERVICE_KEY");
  process.exit(1);
}

/* ========= CLIENTS ========= */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember],
});

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

/* ========= YOUR TIER ROLES ========= */
const TIER_ROLE_IDS = {
  T1: "1409930511744368700",
  T2: "1409930635929456640",
  T3: "1409930709816184882",
  T4: "1409930791844315186",
};
const ALL_TIER_ROLE_IDS = new Set(Object.values(TIER_ROLE_IDS));

/* ========= HELPERS ========= */
const norm = v => (v ?? "").toString().trim().toUpperCase();

async function fetchGuild() {
  return client.guilds.fetch(GUILD_ID);
}

async function fetchMember(guild, discordId) {
  return guild.members.fetch(discordId).catch(() => null);
}

function desiredTierRoleId(row) {
  const t = norm(row.tier);
  return TIER_ROLE_IDS[t] || null; // if invalid/empty, return null (do nothing)
}

function canEditRole(guild, me, roleId) {
  const role = guild.roles.cache.get(roleId);
  if (!role) return false;
  if (role.managed) return false;
  return me.roles.highest.comparePositionTo(role) > 0;
}

/**
 * Only adjust tier roles:
 * - If DB tier is valid (T1–T4), remove other tier roles and ensure the desired one is present.
 * - If DB tier is empty/unknown, DO NOTHING (leave whatever the user has).
 * We never touch non-tier roles.
 */
async function reconcileTierRoles(discordId, tierRoleId) {
  const guild = await fetchGuild();
  const me = guild.members.me || await guild.members.fetch(client.user.id);
  if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    console.error("Bot missing Manage Roles permission.");
    return;
  }

  const member = await fetchMember(guild, discordId);
  if (!member) return;

  if (!tierRoleId) {
    // DB has no tier → do nothing (don't strip)
    return;
  }

  // Safety: ensure we can edit desired role
  if (!canEditRole(guild, me, tierRoleId)) {
    console.warn(`Cannot add desired tier role ${tierRoleId} (below bot or managed).`);
    return;
  }

  // Determine current tier roles on the member
  const currentTierRoles = member.roles.cache
    .filter(r => ALL_TIER_ROLE_IDS.has(r.id))
    .map(r => r.id);

  // Remove tier roles that are not the desired one (and only if we can edit them)
  const toRemove = currentTierRoles.filter(id => id !== tierRoleId && canEditRole(guild, me, id));
  const toAdd = member.roles.cache.has(tierRoleId) ? [] : [tierRoleId];

  // Apply
  try {
    if (toRemove.length) await member.roles.remove(toRemove);
    if (toAdd.length) await member.roles.add(toAdd);
  } catch (e) {
    console.error(`reconcileTierRoles(${discordId})`, e);
  }
}

/**
 * Apply tier from a DB row (tiers only). No other roles touched.
 * Only runs for users present in DB (we never iterate the whole guild).
 */
async function applyFromRow(row) {
  if (!row?.discord_id) return;
  const tierRoleId = desiredTierRoleId(row);
  await reconcileTierRoles(row.discord_id, tierRoleId);
}

/* ========= REALTIME (DB ➜ Discord) ========= */
async function startRealtime() {
  const channel = supabase.channel("players-tier-sync");

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
        // Only react when tier or discord_id changes
        const changed = before.discord_id !== after.discord_id || before.tier !== after.tier;
        if (changed && after.discord_id) await applyFromRow(after);
        return;
      }

      // On DELETE we do nothing (never strip roles for safety)
    }
  );

  await channel.subscribe((status) => console.log("Supabase realtime:", status));
}

/* ========= STARTUP ========= */
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // Start realtime first
  await startRealtime();

  // One-shot reconciliation for rows we manage: only users present in DB with a tier value.
  const { data, error } = await supabase
    .from("players")
    .select("discord_id, tier")
    .not("discord_id", "is", null);

  if (error) {
    console.error("Startup fetch error:", error);
  } else {
    for (const row of data) {
      await applyFromRow(row);
    }
  }
});

// No guildMemberUpdate, no autolink, no Discord ➜ DB writes.
client.login(DISCORD_TOKEN);
