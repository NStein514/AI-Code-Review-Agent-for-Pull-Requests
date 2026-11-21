function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export function renderComment(comment: { body: string }, node: HTMLElement): void {
  const safe = escapeHtml(comment.body);
  node.innerHTML = safe;
}
