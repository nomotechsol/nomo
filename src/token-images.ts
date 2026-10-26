import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createReadStream, existsSync, mkdirSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { get } from "node:https";
import { isIP } from "node:net";
import { join } from "node:path";

const maxImageBytes = 1_500_000;
const imageTypes = {
  png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif", avif: "image/avif",
} as const;
type ImageExtension = keyof typeof imageTypes;

function imageExtension(bytes: Buffer): ImageExtension | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return "gif";
  if (bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp" &&
    ["avif", "avis"].includes(bytes.toString("ascii", 8, 12))) return "avif";
  return null;
}

function publicIPv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split(".").map(Number);
  return a !== 0 && a !== 10 && a !== 127 && a! < 224 &&
    !(a === 100 && b! >= 64 && b! <= 127) && !(a === 169 && b === 254) &&
    !(a === 172 && b! >= 16 && b! <= 31) && !(a === 192 && (b === 0 || b === 168)) &&
    !(a === 198 && (b === 18 || b === 19));
}

async function download(url: string, redirects = 0): Promise<Buffer> {
  if (redirects > 3) throw new Error("Too many image redirects");
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port ||
    isIP(parsed.hostname) || parsed.hostname.endsWith(".local")) throw new Error("Invalid image host");
  const addresses = await lookup(parsed.hostname, { family: 4, all: true });
  if (!addresses.length || addresses.some((entry) => !publicIPv4(entry.address)))
    throw new Error("Image host did not resolve to a public address");
  const address = addresses[0]!.address;
  return new Promise<Buffer>((resolve, reject) => {
    const request = get(parsed, {
      lookup: (_host, options, callback) => {
        if (typeof options === "object" && options?.all) {
          (callback as (error: NodeJS.ErrnoException | null, results: Array<{ address: string; family: number }>) => void)
            (null, [{ address, family: 4 }]);
          return;
        }
        const done = (typeof options === "function" ? options : callback) as
          (error: NodeJS.ErrnoException | null, ip: string, family: number) => void;
        done(null, address, 4);
      }, timeout: 8_000,
      headers: { accept: "image/avif,image/webp,image/*;q=0.8", "user-agent": "NOMO image cache/1.0" },
    }, (response) => {
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        response.resume();
        resolve(download(new URL(response.headers.location, parsed).href, redirects + 1));
        return;
      }
      if (status !== 200) { response.resume(); reject(new Error(`Image host returned ${status}`)); return; }
      const length = Number(response.headers["content-length"]);
      if (Number.isFinite(length) && length > maxImageBytes) {
        response.destroy(); reject(new Error("Token image exceeds size limit")); return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxImageBytes) { response.destroy(new Error("Token image exceeds size limit")); return; }
        chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks)));
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("Image host timed out")));
    request.on("error", reject);
  });
}

export class TokenImageCache {
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private readonly retryAfter = new Map<string, number>();
  private active = 0;

  constructor(private readonly directory: string,
    private readonly onError: (host: string, message: string) => void = () => {}) {
    mkdirSync(directory, { recursive: true, mode: 0o755 });
  }

  private digest(url: string): string { return createHash("sha256").update(url).digest("hex"); }

  publicUrl(url: string | null | undefined): string | null {
    if (!url) return null;
    const digest = this.digest(url);
    for (const ext of Object.keys(imageTypes) as ImageExtension[]) {
      if (existsSync(join(this.directory, `${digest}.${ext}`))) return `/token-images/${digest}.${ext}`;
    }
    return null;
  }

  file(name: string): { stream: ReturnType<typeof createReadStream>; mime: string } | null {
    const match = /^([a-f0-9]{64})\.(png|jpg|webp|gif|avif)$/.exec(name);
    if (!match) return null;
    const path = join(this.directory, name);
    if (!existsSync(path)) return null;
    return { stream: createReadStream(path), mime: imageTypes[match[2] as ImageExtension] };
  }

  enqueue(url: string | null | undefined): void {
    if (!url || this.publicUrl(url) || this.queued.has(url) || (this.retryAfter.get(url) ?? 0) > Date.now() ||
      this.queue.length >= 100) return;
    this.queue.push(url);
    this.queued.add(url);
    this.pump();
  }

  private pump(): void {
    while (this.active < 6 && this.queue.length) {
      const url = this.queue.shift()!;
      this.active++;
      void this.warm(url).catch((error: unknown) => {
        this.retryAfter.set(url, Date.now() + 60_000);
        let host = "invalid-url";
        try { host = new URL(url).hostname; } catch { /* metadata may contain a malformed URI */ }
        this.onError(host, error instanceof Error ? error.message : String(error));
      })
        .finally(() => { this.queued.delete(url); this.active--; this.pump(); });
    }
  }

  private async warm(url: string): Promise<void> {
    const bytes = await download(url);
    const ext = imageExtension(bytes);
    if (!ext) throw new Error("Unsupported token image format");
    const path = join(this.directory, `${this.digest(url)}.${ext}`);
    if (existsSync(path)) return;
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o644 });
    await rename(temporary, path);
  }
}
