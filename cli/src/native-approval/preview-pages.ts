/** Conservative wrapping keeps wide Unicode visible without cutting preview content. */
export function previewPages(message: string, columns: number, rows: number): string[] {
  const width = Math.min(60, Math.floor((columns - 12) / 2));
  const height = Math.min(18, rows - 12);
  if (width < 12 || height < 3) throw new Error("Enlarge the terminal before reviewing a Cavelon change.");
  const lines: string[] = [];
  for (const line of message.split("\n")) {
    const characters = [...line];
    if (!characters.length) lines.push("");
    for (let offset = 0; offset < characters.length; offset += width) lines.push(characters.slice(offset, offset + width).join(""));
  }
  const pages: string[] = [];
  for (let offset = 0; offset < lines.length; offset += height) pages.push(lines.slice(offset, offset + height).join("\n"));
  return pages;
}
