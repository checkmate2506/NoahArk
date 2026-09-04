export function findBannedTokens(source: string, banned: string[]): string[] {
  return banned.filter((token) => {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`).test(source);
  });
}
