export interface ChatMessage {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
}

function contentToText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text ?? "" : ""))
    .filter(Boolean)
    .join("\n");
}

/** Flatten OpenAI chat messages into a single prompt for Cursor Agent ask mode. */
export function messagesToPrompt(messages: ChatMessage[]): string {
  const lines: string[] = [
    "You are answering via an OpenAI-compatible chat completions bridge.",
    "Reply with the assistant answer only. Do not edit files or run tools unless the user explicitly asks in the conversation below.",
    "",
  ];

  for (const message of messages) {
    const text = contentToText(message.content).trim();
    if (!text) continue;
    const role = message.role.toUpperCase();
    lines.push(`[${role}]`, text, "");
  }

  lines.push("[ASSISTANT]");
  return lines.join("\n");
}
