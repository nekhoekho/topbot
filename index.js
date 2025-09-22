// index.js — Tiers-only sync (DB -> Discord)
// Env needed: DISCORD_TOKEN, GUILD_ID, SUPABASE_URL, SUPABASE_SERVICE_KEY

import { Client, GatewayIntentBits, Partials, PermissionsBitField } from "discord.js";
import { createClient } from "@supabase/supabase-js";

/* ====== ENV ====== */
const { DISCORD_TOKEN, GUILD_ID, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!DISCORD_TOKEN || !GUILD_ID || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing env vars. Need DISCORD_TOKEN, GUILD_ID, SUPABASE_URL, SUPABASE_SERVICE_KEY");
  process.exit(1);
}

/* ====== DISCORD CLIENT ====== */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember],
});

/* ====== SUPABASE ====== */
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

/* ====== YOUR TIER ROLES ====== */
const TIER_ROLE_IDS = {
  1: "1409930511744368700", // T1
  2: "1409930635929456640", // T2
  3: "1409930709816184882", // T3
  4: "1409930791844315186", // T4
};
const ALL_TIER_IDS = new Set(Object.values(TIER_ROLE_IDS));

/* ====== HELPERS ====== */
async function getGuild() {
  return client.guilds.fetch(GUILD_ID);
}
async function getMember(guild, id) {
  return guild.members.fetch(id).catch(() => null);
}
function isValidTier(val) {
  const n = typeof val === "string" ? parseInt(val, 10) : val;
  return n === 1 || n === 2 || n === 3 || n === 4 ? n : null;
}
function canEditRole(guild, me, roleId) {
  const role = guild.roles.cache.get(roleId);
  if (!role) return false;
  if (role.managed) return false;
  return me.roles.highest.comparePositionTo(role) > 0;
}

/**
 * Reconcile ONLY tier roles for a single member based on numeric tier.
 * - tier in {1,2,3,4}: remove other tier roles, add the correct one.
 * - tier invalid/null: remove ALL tier roles.
 */
async function reconcileTier(discordId, tierNumber) {
  const guild = await getGuild();
  const me = guild.members.me || (await guild.members.fetch(client.user.id));
  if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    console.error("Bot missing Manage Roles permission");
    return;
  }

  const member = await getMember(guild, discordId);
  if (!member) return;

  const currentTierRoles = member.roles.cache.filter(r => ALL_TIER_IDS.has(r.id)).map(r => r.id);

  // Determine desired state
  const desiredRoleId = tierNumber ? TIER_ROLE_IDS[tierNumber] : null;

  // Build changes, respecting role hierarchy
  const toRemove = currentTierRoles.filter(id => !desiredRoleId || id !== desiredRoleId)
    .filter(id => canEditRole(guild, me, id));
  const toAdd = [];
  if (desiredRoleId && !member.roles.cache.has(desiredRoleId) && canEditRole(guild, me, desiredRoleId)) {
    toAdd.push(desiredRoleId);
  }

  // Apply
  try {
    if (toRemove.length) await member.roles.remove(toRemove);
    if (toAdd.length) await member.roles.add(toAdd);
  } catch (e) {
    console.error(`reconcileTier(${discordId})`, e);
  }
}

/** Apply from a DB row (only if discord_id present) */
async function applyFromRow(row) {
  if (!row?.discord_id) return;
  const n = isValidTier(row.tier);
  await reconcileTier(row.discord_id, n);
}

/* ====== REALTIME: DB -> Discord ====== */
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
        // Only react when discord_id or tier changes
        const changed = before.discord_id !== after.discord_id || before.tier !== after.tier;
        if (changed && after.discord_id) await applyFromRow(after);
        return;
      }

      // DELETE: do nothing (never strip due to delete)
    }
  );

  await channel.subscribe((status) => console.log("Supabase realtime:", status));
}

/* ====== STARTUP: enforce for rows we manage ====== */
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await startRealtime();

  // One-shot pass: only rows with a discord_id (we don't touch anyone else)
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

client.login(DISCORD_TOKEN);
