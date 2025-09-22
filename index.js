// index.js — Tiers-only sync (DB -> Discord), optimized to run ONLY on real changes
// Env: DISCORD_TOKEN, GUILD_ID, SUPABASE_URL, SUPABASE_SERVICE_KEY

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

/* ====== LIGHTWEIGHT CACHES ====== */
// Avoid repeated fetches and redundant edits
let guildPromise;
let mePromise;
function getGuild() {
  if (!guildPromise) guildPromise = client.guilds.fetch(GUILD_ID);
  return guildPromise;
}
async function getMe(guild) {
  if (!mePromise) {
    mePromise = guild.members.me || guild.members.fetch(client.user.id);
  }
  return mePromise;
}
function isValidTier(val) {
  const n = Number.parseInt(val, 10);
  return [1, 2, 3, 4].includes(n) ? n : null;
}

// Role editability cache per role id (true/false)
const editableRoleCache = new Map();
function canEditRoleCached(guild, me, roleId) {
  if (editableRoleCache.has(roleId)) return editableRoleCache.get(roleId);
  const role = guild.roles.cache.get(roleId);
  if (!role || role.managed) {
    editableRoleCache.set(roleId, false);
    return false;
  }
  const ok = me.roles.highest.comparePositionTo(role) > 0;
  editableRoleCache.set(roleId, ok);
  return ok;
}

/* ====== LAST-APPLIED & DEBOUNCE/QUEUE ====== */
// Remember last tier we successfully applied to avoid duplicate work
const lastAppliedTier = new Map(); // discordId -> number|null

// Debounce timers and per-member promise chains
const debounceTimers = new Map();   // discordId -> Timeout
const memberQueues   = new Map();   // discordId -> Promise (chain tail)
const DEBOUNCE_MS = 500;

// Helper: enqueue a function per-member to run serially
function enqueueForMember(discordId, fn) {
  const prev = memberQueues.get(discordId) || Promise.resolve();
  const next = prev
    .catch(() => {}) // swallow previous errors so chain continues
    .then(fn);
  memberQueues.set(discordId, next);
  return next;
}

/* ====== CORE: reconcile only if truly needed ====== */
async function reconcileTier(discordId, tierNumber) {
  const guild = await getGuild();
  const me = await getMe(guild);
  if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    console.error("Bot missing Manage Roles permission");
    return;
  }

  // If we already applied this exact state, skip early
  const last = lastAppliedTier.get(discordId);
  if (last === (tierNumber ?? null)) return;

  // Fetch member (cached by discord.js when possible)
  const member = await guild.members.fetch(discordId).catch(() => null);
  if (!member) return;

  // Current tier roles on the member
  const currentTierRoles = member.roles.cache.filter(r => ALL_TIER_IDS.has(r.id));
  const currentTierRoleId = currentTierRoles.first()?.id ?? null;

  const desiredRoleId = tierNumber ? TIER_ROLE_IDS[tierNumber] : null;

  // SHORT-CIRCUIT CASES (no API calls):
  // 1) If desired is null and member has no tier roles => nothing to do
  if (!desiredRoleId && currentTierRoles.size === 0) {
    lastAppliedTier.set(discordId, null);
    return;
  }
  // 2) If desired matches the only current tier role and there aren't extras => nothing to do
  if (desiredRoleId && currentTierRoles.size === 1 && currentTierRoleId === desiredRoleId) {
    lastAppliedTier.set(discordId, tierNumber);
    return;
  }

  // Build minimal changes
  const toRemove = [];
  for (const role of currentTierRoles.values()) {
    if (!desiredRoleId || role.id !== desiredRoleId) {
      if (canEditRoleCached(guild, me, role.id)) toRemove.push(role.id);
    }
  }

  const toAdd = [];
  if (desiredRoleId && !member.roles.cache.has(desiredRoleId) && canEditRoleCached(guild, me, desiredRoleId)) {
    toAdd.push(desiredRoleId);
  }

  // If nothing to do after checks, bail
  if (toRemove.length === 0 && toAdd.length === 0) {
    lastAppliedTier.set(discordId, tierNumber ?? null);
    return;
  }

  try {
    // Apply minimal diff; order: remove first (avoids momentary multi-tier)
    if (toRemove.length) await member.roles.remove(toRemove, "Tier sync: remove old tier(s)");
    if (toAdd.length)    await member.roles.add(toAdd, "Tier sync: add desired tier");
    lastAppliedTier.set(discordId, tierNumber ?? null);
  } catch (e) {
    console.error(`reconcileTier(${discordId})`, e);
  }
}

/** Debounced apply for a row */
function scheduleApplyFromRow(row) {
  if (!row?.discord_id) return;
  const discordId = row.discord_id;
  const tier = isValidTier(row.tier);

  // Debounce bursts per member
  clearTimeout(debounceTimers.get(discordId));
  const t = setTimeout(() => {
    // Queue serially so we never overlap edits for the same member
    enqueueForMember(discordId, () => reconcileTier(discordId, tier));
    debounceTimers.delete(discordId);
  }, DEBOUNCE_MS);
  debounceTimers.set(discordId, t);
}

/* ====== REALTIME: DB -> Discord, only when relevant fields change ====== */
async function startRealtime() {
  const channel = supabase.channel("players-tier-sync");

  channel.on(
    "postgres_changes",
    { event: "*", schema: "public", table: "players" },
    async (payload) => {
      const after = payload.new ?? {};
      const before = payload.old ?? {};

      if (payload.eventType === "INSERT") {
        if (after.discord_id) scheduleApplyFromRow(after);
        return;
      }

      if (payload.eventType === "UPDATE") {
        // React ONLY if discord_id or tier changed (string-compare handles null/number/string)
        const discordChanged = String(before.discord_id ?? "") !== String(after.discord_id ?? "");
        const tierChanged    = String(before.tier ?? "")       !== String(after.tier ?? "");
        if ((discordChanged || tierChanged) && after.discord_id) {
          scheduleApplyFromRow(after);
        }
        return;
      }

      // DELETE: no action (we never strip due to delete)
    }
  );

  await channel.subscribe((status) => console.log("Supabase realtime:", status));
}

/* ====== STARTUP: one-shot pass, but skip already-correct members ====== */
async function startupSweep() {
  const { data, error } = await supabase
    .from("players")
    .select("discord_id, tier")
    .not("discord_id", "is", null);

  if (error) {
    console.error("Startup fetch error:", error);
    return;
  }

  // Queue each member; the internal short-circuit will skip no-ops
  for (const row of data) {
    const discordId = row.discord_id;
    const tier = isValidTier(row.tier);
    // Use the same queue path (no debounce for startup to finish faster but still serialized per member)
    enqueueForMember(discordId, () => reconcileTier(discordId, tier));
  }
}

/* ====== BOOT ====== */
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await startRealtime();
  await startupSweep();
});

client.login(DISCORD_TOKEN);
