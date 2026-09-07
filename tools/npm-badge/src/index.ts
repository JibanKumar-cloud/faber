/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

const PACKAGE = "faberwright";

export default {
  async fetch(): Promise<Response> {
    try {
      const { total, weekly } = await getDownloads();

      const message =
        `⭐ ${formatNumber(total)} downloads · 📈 ${formatNumber(weekly)} this week`;

      return new Response(makeBadge("📦 npm", message), {
        headers: {
          "Content-Type": "image/svg+xml;charset=UTF-8",
          "Cache-Control": "public, max-age=3600",
        },
      });
    } catch {
      return new Response(makeBadge("📦 npm", "downloads unavailable"), {
        headers: {
          "Content-Type": "image/svg+xml;charset=UTF-8",
          "Cache-Control": "public, max-age=300",
        },
      });
    }
  },
};

async function getDownloads() {
  const registryRes = await fetch(`https://registry.npmjs.org/${PACKAGE}`);

  if (!registryRes.ok) {
    throw new Error("Failed to fetch npm package metadata");
  }

  const metadata = await registryRes.json() as {
    time: {
      created: string;
    };
  };

  const firstRelease = new Date(metadata.time.created);
  const today = new Date();

  let total = 0;
  let start = new Date(firstRelease);

  while (start <= today) {
    const end = new Date(start);
    end.setUTCFullYear(end.getUTCFullYear() + 1);
    end.setUTCDate(end.getUTCDate() - 1);

    if (end > today) {
      end.setTime(today.getTime());
    }

    total += await fetchDownloads(start, end);

    start = new Date(end);
    start.setUTCDate(start.getUTCDate() + 1);
  }

  const weeklyRes = await fetch(
    `https://api.npmjs.org/downloads/point/last-week/${PACKAGE}`
  );

  if (!weeklyRes.ok) {
    throw new Error("Failed to fetch weekly npm downloads");
  }

  const weeklyData = await weeklyRes.json() as {
    downloads: number;
  };

  return {
    total,
    weekly: weeklyData.downloads,
  };
}

async function fetchDownloads(start: Date, end: Date): Promise<number> {
  const response = await fetch(
    `https://api.npmjs.org/downloads/point/${isoDate(start)}:${isoDate(end)}/${PACKAGE}`
  );

  if (!response.ok) {
    throw new Error(`npm API returned ${response.status}`);
  }

  const data = await response.json() as {
    downloads?: number;
  };

  return data.downloads ?? 0;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatNumber(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1).replace(".0", "")}M`;
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1).replace(".0", "")}K`;
  }

  return String(value);
}

function makeBadge(label: string, message: string): string {
  const labelWidth = 76;
  const messageWidth = Math.max(170, message.length * 7.1 + 20);
  const totalWidth = labelWidth + messageWidth;

  return `
<svg xmlns="http://www.w3.org/2000/svg"
     width="${totalWidth}"
     height="28"
     role="img"
     aria-label="${escapeXml(label)}: ${escapeXml(message)}">

  <clipPath id="round">
    <rect width="${totalWidth}" height="28" rx="6"/>
  </clipPath>

  <g clip-path="url(#round)">
    <rect width="${labelWidth}" height="28" fill="#CB3837"/>
    <rect x="${labelWidth}" width="${messageWidth}" height="28" fill="#24292f"/>
  </g>

  <g
    fill="#fff"
    text-anchor="middle"
    font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif"
    font-size="12"
    font-weight="600">

    <text x="${labelWidth / 2}" y="18">
      ${escapeXml(label)}
    </text>

    <text x="${labelWidth + messageWidth / 2}" y="18">
      ${escapeXml(message)}
    </text>
  </g>
</svg>`.trim();
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}