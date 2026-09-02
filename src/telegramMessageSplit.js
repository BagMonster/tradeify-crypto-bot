/**
 * Telegram Bot API rejects sendMessage when text is longer than 4096
 * characters. D-060 fan-out of five instrument blocks routinely exceeds that.
 *
 * Split on instrument separators first, then blank lines, then single lines,
 * then a hard cut. Multi-page replies get a [n/m] prefix. Every returned
 * chunk is guaranteed <= limit.
 */

export const TELEGRAM_TEXT_LIMIT = 4096;
const PAGE_PREFIX_RESERVE = 16; // "[99/99]\n"

function hardCut(text, max) {
  const out = [];
  for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max));
  return out;
}

function packSegments(segments, max) {
  const chunks = [];
  let current = "";
  for (const segment of segments) {
    if (segment.length > max) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      const pieces = segment.includes("\n")
        ? packSegments(segment.split(/(?<=\n)/), max)
        : hardCut(segment, max);
      chunks.push(...pieces);
      continue;
    }
    const next = current ? current + segment : segment;
    if (next.length <= max) {
      current = next;
      continue;
    }
    if (current) chunks.push(current);
    current = segment;
  }
  if (current) chunks.push(current);
  return chunks;
}

function segmentsFor(text) {
  // D-060 fan-out draws a 28-em-dash rule before each instrument.
  if (text.includes("\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014")) {
    return text.split(/(?=\u2014{8,})/);
  }
  if (text.includes("\n\n")) return text.split(/(?<=\n\n)/);
  if (text.includes("\n")) return text.split(/(?<=\n)/);
  return [text];
}

export function splitTelegramText(text, limit = TELEGRAM_TEXT_LIMIT) {
  const raw = text == null ? "" : String(text);
  if (raw.length === 0) return [""];
  if (raw.length <= limit) return [raw];

  const bodyLimit = Math.max(1, limit - PAGE_PREFIX_RESERVE);
  const bodies = packSegments(segmentsFor(raw), bodyLimit);
  if (bodies.length === 1 && bodies[0].length <= limit) return bodies;

  const total = bodies.length;
  return bodies.map((body, i) => {
    const prefix = `[${i + 1}/${total}]\n`;
    const page = prefix + body;
    return page.length <= limit ? page : prefix + body.slice(0, limit - prefix.length);
  });
}
