/**
 * shared/configBackup.ts — versioned running-config backup contracts.
 *
 * The Oxidized/rConfig/Golden-Config pattern, scoped to what this portal can
 * honestly claim: a snapshot of each reachable device's running-config, kept
 * versioned on disk, diffed against its own previous snapshot. There is no
 * golden baseline and no remediation here — drift means "the running config
 * CHANGED since the last snapshot", never "the config is wrong".
 *
 * Collection is READ-ONLY by construction. Live mode collects through the
 * same recorded-SSH channel the terminal bridge uses (local-plane
 * credentials, `show running-config` — a command the terminal's read-only
 * allow-list already permits); nothing is ever written to a device. Demo
 * mode synthesizes deterministic per-device configs (source 'demo
 * synthesis') so the feature is fully demonstrable without credentials —
 * provenance travels on every version row, never implied.
 *
 * Devices with no read-only config channel (APs, UXI sensors — the classes
 * deviceTerminalKind maps to 'none') are reported as 'no-source' with the
 * reason named, never silently dropped from the list: a coverage claim made
 * over a partial estate is the mistake the Compliance screen exists to avoid.
 */

export type ConfigBackupStatus =
  /** At least one snapshot is on file. */
  | 'ok'
  /** Collectable, but no sweep has stored a snapshot yet. */
  | 'pending'
  /** This device class has no read-only config channel from the portal. */
  | 'no-source'
  /** The last collection attempt failed; `note` says why. */
  | 'failed';

/** One stored snapshot's metadata — never the config body itself. */
export interface ConfigBackupVersionMeta {
  /** 1-based, monotonic per device. Gaps are possible (old versions pruned). */
  version: number;
  /** ISO collection time. */
  takenAt: string;
  /** Free-text provenance, e.g. 'demo synthesis' | 'ssh show running-config'. */
  source: string;
  /** Line count of the stored config. */
  lines: number;
  /** Content identity — a repeated collection of an unchanged config stores
   *  no new version, so a version list IS the device's change history. */
  sha256: string;
  /** True when this version's content differs from its predecessor's. Always
   *  true for a stored version beyond the first (unchanged content is not
   *  stored); false on version 1, which has nothing to drift from. */
  driftFromPrevious: boolean;
}

export interface ConfigBackupDeviceRow {
  device: string;
  /** Inventory plane label / management IP when the inventory reported them. */
  plane: string | null;
  ip: string | null;
  status: ConfigBackupStatus;
  /** The honest reason for 'no-source' / 'failed'; absent on 'ok'/'pending'. */
  note?: string;
  /** Versions on disk for this device. */
  versions: number;
  /** Newest snapshot's metadata, or null before the first one lands. */
  latest: ConfigBackupVersionMeta | null;
  /** The Compliance drift flag: the latest snapshot differs from its previous. */
  drift: boolean;
}

/** Estate-level rollup — what the Compliance 'Config drift' stat reads. */
export interface ConfigBackupSummary {
  /** Devices the inventory knows. */
  total: number;
  /** Devices with a read-only config channel. */
  eligible: number;
  /** Devices with at least one snapshot on file. */
  backedUp: number;
  /** Devices whose latest snapshot differs from its previous snapshot. */
  drift: number;
  /** Devices whose last collection attempt failed. */
  failed: number;
}

export interface ConfigBackupListEnvelope {
  dataSource: 'demo' | 'live';
  devices: ConfigBackupDeviceRow[];
  summary: ConfigBackupSummary;
  /** Present when the whole list is synthesized demo data. */
  note?: string;
}

/** Version metadata for one device, newest first. Bodies are fetched only
 *  through the diff route — never bulk-served. */
export interface ConfigBackupVersionList {
  device: string;
  versions: ConfigBackupVersionMeta[];
}

/** One line of a computed diff. 'del' is a line only in the older version,
 *  'add' a line only in the newer one. */
export interface ConfigDiffLine {
  kind: 'same' | 'add' | 'del';
  text: string;
}

/** A computed unified line-diff between two stored versions of one device. */
export interface ConfigBackupDiff {
  device: string;
  fromVersion: number;
  toVersion: number;
  fromTakenAt: string;
  toTakenAt: string;
  added: number;
  removed: number;
  /** Typed lines for the UI's coloured renderer. */
  lines: ConfigDiffLine[];
  /** The same diff as unified text ('+ '/'- '/'  ' prefixes) for copy/paste. */
  text: string;
}

/** Versions kept per device (Oxidized-style rolling window). */
export const CONFIG_BACKUP_KEEP_VERSIONS = 10;

/**
 * Cell budget for the LCS matrix below. Common prefixes/suffixes are trimmed
 * before the matrix is built, so this bounds the CHANGED MIDDLE, not the
 * config: 4M cells covers a 2000x2000-line changed region in 16 MB.
 */
export const CONFIG_DIFF_MAX_CELLS = 4_000_000;

/**
 * A dependency-free LCS line diff between two config texts.
 *
 * Why LCS and not a line-by-line walk: an inserted stanza must not render the
 * rest of the file as changed. The DP matrix is the standard longest-common-
 * subsequence table over the trimmed middle; the walk prefers deletions so a
 * changed block renders as removals followed by additions, the order a
 * reviewer expects from unified diffs.
 *
 * A changed middle larger than CONFIG_DIFF_MAX_CELLS collapses to "remove the
 * old block, add the new block" — always a CORRECT superset of the minimal
 * diff, never a wrong alignment presented as precise.
 */
export function diffConfigLines(before: string, after: string): ConfigDiffLine[] {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  const out: ConfigDiffLine[] = [];
  for (let i = 0; i < start; i += 1) out.push({ kind: 'same', text: a[i]! });

  if (midA.length * midB.length > CONFIG_DIFF_MAX_CELLS) {
    for (const text of midA) out.push({ kind: 'del', text });
    for (const text of midB) out.push({ kind: 'add', text });
  } else {
    const n = midA.length;
    const m = midB.length;
    const width = m + 1;
    const dp = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i * width + j] =
          midA[i] === midB[j]
            ? dp[(i + 1) * width + j + 1]! + 1
            : Math.max(dp[(i + 1) * width + j]!, dp[i * width + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        out.push({ kind: 'same', text: midA[i]! });
        i += 1;
        j += 1;
      } else if (dp[(i + 1) * width + j]! >= dp[i * width + j + 1]!) {
        out.push({ kind: 'del', text: midA[i]! });
        i += 1;
      } else {
        out.push({ kind: 'add', text: midB[j]! });
        j += 1;
      }
    }
    while (i < n) {
      out.push({ kind: 'del', text: midA[i]! });
      i += 1;
    }
    while (j < m) {
      out.push({ kind: 'add', text: midB[j]! });
      j += 1;
    }
  }

  for (let k = endA; k < a.length; k += 1) out.push({ kind: 'same', text: a[k]! });
  return out;
}

/** Render typed diff lines as unified text: '+ '/'- '/'  ' — the shape
 *  DiffCode already colours (danger/success/default). */
export function unifiedConfigDiffText(lines: ConfigDiffLine[]): string {
  return lines
    .map((line) => `${line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '} ${line.text}`)
    .join('\n');
}

/** True when the diff carries at least one changed line. */
export function configDiffHasChanges(lines: ConfigDiffLine[]): boolean {
  return lines.some((line) => line.kind !== 'same');
}
