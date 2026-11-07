/** Published principle page, retaining an explicitly pinned revision. */
export function ruleUrl(id: string): string {
  const match = /^(.*?)(?:@(\d+))?$/.exec(id.trim())!;
  const path = match[1]!.split("/").map(encodeURIComponent).join("/");
  return `https://wellactually.dev/p/${path}${match[2] ? `?v=${match[2]}` : ""}`;
}
