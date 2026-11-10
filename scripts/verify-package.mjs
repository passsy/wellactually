import { createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";

// npm may return 202 and print success before a package is downloadable.
export async function verifyPublishedPackage(packed, { fetcher = fetch, sleep = setTimeout, attempts = 20 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = await fetcher(`https://registry.npmjs.org/${encodeURIComponent(packed.name)}/${encodeURIComponent(packed.version)}?verify=${Date.now()}`, { signal: AbortSignal.timeout(15000) });
    if (response.status === 404 || response.status === 429 || response.status >= 500) {
      if (attempt + 1 < attempts) {
        console.log(`npm is processing ${packed.name}@${packed.version}; waiting for registry verification`);
        await sleep(15000);
        continue;
      }
      break;
    }
    if (!response.ok) throw new Error(`Registry verification returned ${response.status}`);
    const manifest = await response.json();
    if (manifest.name !== packed.name || manifest.version !== packed.version || manifest.dist?.integrity !== packed.integrity) {
      throw new Error("Published package metadata differs from the tested artifact");
    }
    const tarball = new URL(manifest.dist.tarball);
    if (tarball.protocol !== "https:" || tarball.username || tarball.password) throw new Error("Unexpected registry tarball URL");
    const download = await fetcher(tarball, { signal: AbortSignal.timeout(30000) });
    if (!download.ok) throw new Error(`Published tarball returned ${download.status}`);
    const bytes = Buffer.from(await download.arrayBuffer());
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    if (integrity !== packed.integrity) throw new Error("Published tarball differs from the tested artifact");
    console.log(`Verified published archive: ${packed.name}@${packed.version}`);
    return { name: manifest.name, version: manifest.version, integrity };
  }
  throw new Error("npm accepted the upload but the version is not publicly available yet; do not promote installer pointers");
}
