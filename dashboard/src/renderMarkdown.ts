function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderMarkdown(src: string): string {
  let html = escapeHtml(src);

  // code blocks (``` ... ```)
  html = html.replace(/```([^`]*?)```/gs, (_m, code) =>
    `<pre class="md-code-block">${code.trim()}</pre>`
  );

  // inline code
  html = html.replace(/`([^`\n]+)`/g, '<code class="md-inline-code">$1</code>');

  // headers
  html = html.replace(/^### (.+)$/gm, '<h3 class="md-h3">$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2 class="md-h2">$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1 class="md-h1">$1</h1>');

  // bold / italic
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // unordered lists  — convert runs of "- item" lines
  html = html.replace(/((?:^- .+\n?)+)/gm, (block) => {
    const items = block.trim().split("\n").map((line) =>
      `<li class="md-li">${line.replace(/^- /, "")}</li>`
    ).join("");
    return `<ul class="md-ul">${items}</ul>`;
  });

  // line breaks (preserve single newlines as <br> outside of blocks)
  html = html.replace(/\n/g, "<br>");

  // clean up double <br> after block elements
  html = html.replace(/(<\/(?:h[1-3]|ul|pre)>)<br>/g, "$1");
  html = html.replace(/<br>(<(?:h[1-3]|ul|pre))/g, "$1");

  return html;
}
