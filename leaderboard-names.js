'use strict';

function usableName(value) {
  if (typeof value !== 'string') return '';
  const name = value.trim();
  return name && !/^unknown[\s_-]+user$/i.test(name) ? name : '';
}

async function resolveLeaderboardEntries(entries, {
  guild,
  users,
  page = 0,
  pageSize = 10,
  getSavedName = () => '',
  fetchUser,
} = {}) {
  const safePage = Number.isFinite(page) ? Math.max(0, Math.trunc(page)) : 0;
  const visibleEntries = entries.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const resolvedNames = new Map();

  await Promise.all(visibleEntries.map(async (entry) => {
    const id = String(entry.id || '');
    const member = guild?.members?.cache?.get(id) || null;
    let user = users?.cache?.get(id) || member?.user || null;
    const savedName = usableName(getSavedName(id));
    let isMentionResolvable = Boolean(member || usableName(user?.globalName) || usableName(user?.username));
    const findName = () => [
      member?.displayName,
      user?.globalName,
      user?.username,
      savedName,
      entry.displayName,
    ].map(usableName).find(Boolean) || '';

    let displayName = findName();
    if (!member && !isMentionResolvable && /^\d{17,20}$/.test(id) && typeof fetchUser === 'function') {
      try {
        user = await fetchUser(id);
        displayName = findName();
        isMentionResolvable = Boolean(usableName(user?.globalName) || usableName(user?.username));
      } catch {
        // A deleted or unavailable Discord account must not break the leaderboard.
      }
    }

    resolvedNames.set(id, {
      displayName: displayName || (/^\d{17,20}$/.test(id) ? `Usuario ${id.slice(-4)}` : 'Jugador sin nombre'),
      isGuildMember: Boolean(member),
      isMentionResolvable,
    });
  }));

  return entries.map((entry) => {
    const resolved = resolvedNames.get(String(entry.id || ''));
    return resolved ? { ...entry, ...resolved } : entry;
  });
}

module.exports = { resolveLeaderboardEntries };