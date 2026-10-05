'use strict';

function resolveLeaderboardEntries(entries, {
  guild,
  users,
  page = 0,
  pageSize = 10,
  getSavedName = () => '',
} = {}) {
  const safePage = Number.isFinite(page) ? Math.max(0, Math.trunc(page)) : 0;
  const visibleEntries = entries.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const resolvedNames = new Map();

  for (const entry of visibleEntries) {
    const id = String(entry.id || '');
    const member = guild?.members?.cache?.get(id) || null;
    const user = users?.cache?.get(id) || member?.user || null;
    const savedName = getSavedName(id);
    resolvedNames.set(id, {
      displayName: member?.displayName || user?.globalName || user?.username || savedName || entry.displayName || 'Jugador sin nombre',
      isGuildMember: Boolean(member),
    });
  }

  return entries.map((entry) => {
    const resolved = resolvedNames.get(String(entry.id || ''));
    return resolved ? { ...entry, ...resolved } : entry;
  });
}

module.exports = { resolveLeaderboardEntries };