'use strict';

const DISCORD_ID = /^\d{17,20}$/;

async function resolveLeaderboardEntries(entries, {
  guild,
  users,
  page = 0,
  pageSize = 10,
  getSavedName = () => '',
} = {}) {
  const safePage = Number.isFinite(page) ? Math.max(0, Math.trunc(page)) : 0;
  const visibleEntries = entries.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const resolvedNames = new Map();

  await Promise.all(visibleEntries.map(async (entry) => {
    const id = String(entry.id || '');
    let member = null;
    if (DISCORD_ID.test(id)) {
      member = guild?.members?.cache?.get(id) || null;
      if (!member && guild?.members?.fetch) {
        member = await guild.members.fetch(id).catch(() => null);
      }
    }

    if (member) {
      const displayName = member.displayName
        || member.user?.globalName
        || member.user?.username;
      if (displayName) {
        resolvedNames.set(id, { displayName, isGuildMember: true });
        return;
      }
    }

    let user = users?.cache?.get(id) || member?.user || null;
    if (!user && DISCORD_ID.test(id) && users?.fetch) {
      user = await users.fetch(id).catch(() => null);
    }
    const savedName = getSavedName(id);
    resolvedNames.set(id, {
      displayName: user?.globalName || user?.username || savedName || entry.displayName || 'Jugador sin nombre',
      isGuildMember: false,
    });
  }));

  return entries.map((entry) => {
    const id = String(entry.id || '');
    const resolved = resolvedNames.get(id);
    if (resolved) return { ...entry, ...resolved };
    const savedName = getSavedName(id);
    return {
      ...entry,
      displayName: savedName || entry.displayName || 'Jugador sin nombre',
      isGuildMember: false,
    };
  });
}

module.exports = { resolveLeaderboardEntries };