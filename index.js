// index.js — Tiers-only sync (DB -> Discord, v14 stable, admin-friendly)
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

/* ====== TIER ROLES ====== */
const TIER_ROLE_IDS = {
  1: "1409930511744368700", // T1
  2: "1409930635929456640", // T2
  3: "1409930709816184882", // T3
  4: "1409930791844315186", // T4
};
const ALL_TIER_IDS = new Set(Object.values(TIER_ROLE_IDS));

/* ====== HELPERS ====== */
let guildPromise;
function getGuild() {
  if (!guildPromise) guildPromise = client.guilds.fetch(GUILD_ID);
  return guildPromise;
}
function isValidTier(val) {
  const n = Number.parseInt(val, 10);
  return [1, 2, 3, 4].includes(n) ? n : null;
}

/* ====== CORE SYNC (v14: use roles.cache safely) ====== */
async function reconcileTier(discordId, tierNumber) {
  const guild = await getGuild();

  // Force fresh member fetch to avoid partials/stale
  const member = await guild.members.fetch({ user: discordId, force: true }).catch(() => null);
  if (!member) return;

  // Ensure roles manager + cache exist (v14)
  if (!member.roles || !member.roles.cache) {
    console.warn(`Roles unavailable for ${discordId}; skipping.`);
    return;
  }
  const rolesColl = member.roles.cache;

  // Desired tier role (or none)
  const desiredRoleId = tierNumber ? TIER_ROLE_IDS[tierNumber] : null;

  // Current tier roles
  const currentTierRoles = rolesColl.filter(r => ALL_TIER_IDS.has(r.id));
  const hasDesired = desiredRoleId ? rolesColl.has(desiredRoleId) : false;

  // No-op short circuits (avoid API calls)
  if (!desiredRoleId && currentTierRoles.size === 0) return;
  if (desiredRoleId && currentTierRoles.size === 1 && currentTierRoles.first().id === desiredRoleId) return;

  // Minimal diff
  const toRemove = [];
  for (const role of currentTierRoles.values()) {
    if (!desiredRoleId || role.id !== desiredRoleId) toRemove.push(role.id);
  }
  const toAdd = [];
  if (desiredRoleId && !hasDesired) toAdd.push(desiredRoleId);

  if (!toRemove.length && !toAdd.length) return;

  try {
    // Admin perms mean hierarchy checks aren’t needed, but this still respects rate limits
    if (toRemove.length) await member.roles.remove(toRemove, "Tier sync: remove old tier(s)");
    if (toAdd.length)    await member.roles.add(toAdd, "Tier sync: add desired tier");
  } catch (e) {
    console.error(`reconcileTier(${discordId})`, e);
  }
}

/* ====== APPLY FROM ROW ====== */
async function applyFromRow(row) {
  if (!row?.discord_id) return;
  const n = isValidTier(row.tier);
  await reconcileTier(row.discord_id, n);
}

/* ====== REALTIME: DB -> Discord (only when relevant fields change) ====== */
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
        const discordChanged = String(before.discord_id ?? "") !== String(after.discord_id ?? "");
        const tierChanged    = String(before.tier ?? "")       !== String(after.tier ?? "");
        if ((discordChanged || tierChanged) && after.discord_id) {
          await applyFromRow(after);
        }
        return;
      }

      // DELETE: no action (never strip tiers on delete)
    }
  );

  await channel.subscribe((status) => console.log("Supabase realtime:", status));
}

/* ====== STARTUP SWEEP (skip no-ops via reconcile short-circuits) ====== */
async function startupSweep() {
  const { data, error } = await supabase
    .from("players")
    .select("discord_id, tier")
    .not("discord_id", "is", null);

  if (error) {
    console.error("Startup fetch error:", error);
    return;
  }

  for (const row of data) {
    await applyFromRow(row);
  }
}

/* ====== BOOT ====== */
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // sanity: ensure we have Manage Roles (admin includes it)
  const guild = await getGuild();
  const me = guild.members.me || (await guild.members.fetch(client.user.id));
  if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    console.error("Bot missing Manage Roles permission");
  }

  await startRealtime();
  await startupSweep();
});

client.login(DISCORD_TOKEN);
