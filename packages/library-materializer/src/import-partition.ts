export const IMPORT_PARTITION_FLOOR_BYTES = 2 * 1024;

export type ImportPartitionOracle = (bytes: Uint8Array) => Promise<boolean>;

export interface ImportPartitionAttempt {
  startOffset: number;
  endOffset: number;
  byteSize: number;
  outcome: "accepted" | "rejected";
  children?: [ImportPartitionAttempt, ImportPartitionAttempt];
}

export interface ImportPartitionPart {
  bytes: Uint8Array;
  startOffset: number;
  endOffset: number;
}

export interface ImportPartitionResult {
  parts: ImportPartitionPart[];
  attemptTree: ImportPartitionAttempt;
}

export class ImportPartitionFloorError extends Error {
  readonly code = "import_partition_floor_rejected" as const;

  constructor(
    public readonly startOffset: number,
    public readonly endOffset: number,
  ) {
    super(`Import partition discovery rejected byte offsets [${startOffset}, ${endOffset}) at or below the 2048-byte floor`);
    this.name = "ImportPartitionFloorError";
  }
}

/**
 * Discovers an importable, ordered byte partition through an injected oracle.
 * The oracle is invoked exactly once for each node in the returned attempt tree.
 */
export async function discoverImportPartition(
  bytes: Uint8Array,
  oracle: ImportPartitionOracle,
): Promise<ImportPartitionResult> {
  const source = bytes.slice();

  const visit = async (startOffset: number, endOffset: number): Promise<{
    parts: ImportPartitionPart[];
    attempt: ImportPartitionAttempt;
  }> => {
    const piece = source.slice(startOffset, endOffset);
    const accepted = await oracle(piece);
    const attempt: ImportPartitionAttempt = {
      startOffset,
      endOffset,
      byteSize: piece.byteLength,
      outcome: accepted ? "accepted" : "rejected",
    };

    if (accepted) {
      return {
        parts: [{ bytes: piece, startOffset, endOffset }],
        attempt,
      };
    }
    if (piece.byteLength <= IMPORT_PARTITION_FLOOR_BYTES) {
      throw new ImportPartitionFloorError(startOffset, endOffset);
    }

    const relativeSplit = selectSplitOffset(piece);
    const splitOffset = startOffset + relativeSplit;
    const left = source.slice(startOffset, splitOffset);
    const right = source.slice(splitOffset, endOffset);
    assertByteConcatenation(piece, [left, right]);

    const leftResult = await visit(startOffset, splitOffset);
    const rightResult = await visit(splitOffset, endOffset);
    attempt.children = [leftResult.attempt, rightResult.attempt];
    return {
      parts: [...leftResult.parts, ...rightResult.parts],
      attempt,
    };
  };

  const result = await visit(0, source.byteLength);
  assertByteConcatenation(source, result.parts.map((part) => part.bytes));
  return { parts: result.parts, attemptTree: result.attempt };
}

// Separator-only fragments (fence walls, rules, blank runs) are refused by
// Vertex as empty, so a split must leave BOTH sides balanced and carrying
// real content — a degenerate side (e.g. a lone newline) can never import.
const SEPARATOR_BYTES = new Set([0x09, 0x0a, 0x0d, 0x20, 0x23, 0x2a, 0x2d, 0x3a, 0x3d, 0x3e, 0x5f, 0x60]);

function selectSplitOffset(bytes: Uint8Array): number {
  const midpoint = Math.floor(bytes.byteLength / 2);
  const minSide = Math.max(1, Math.min(1024, Math.floor(bytes.byteLength / 4)));
  const contentPrefix = new Uint32Array(bytes.byteLength + 1);
  for (let index = 0; index < bytes.byteLength; index += 1) {
    contentPrefix[index + 1] = contentPrefix[index]! + (SEPARATOR_BYTES.has(bytes[index]!) ? 0 : 1);
  }
  const acceptable = (boundary: number): boolean =>
    boundary >= minSide
    && bytes.byteLength - boundary >= minSide
    && contentPrefix[boundary]! > 0
    && contentPrefix[bytes.byteLength]! - contentPrefix[boundary]! > 0;

  const paragraphBoundaries: number[] = [];
  const newlineBoundaries: number[] = [];
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    const boundary = index + 1;
    if (boundary > 0 && boundary < bytes.byteLength && acceptable(boundary)) newlineBoundaries.push(boundary);
    if (bytes[index + 1] === 0x0a) {
      const paragraphBoundary = index + 2;
      if (paragraphBoundary > 0 && paragraphBoundary < bytes.byteLength && acceptable(paragraphBoundary)) {
        paragraphBoundaries.push(paragraphBoundary);
      }
    }
  }

  return nearestBoundary(paragraphBoundaries, midpoint)
    ?? nearestBoundary(newlineBoundaries, midpoint)
    ?? midpoint;
}

function nearestBoundary(boundaries: number[], midpoint: number): number | undefined {
  let best: number | undefined;
  for (const boundary of boundaries) {
    if (
      best === undefined
      || Math.abs(boundary - midpoint) < Math.abs(best - midpoint)
      || (Math.abs(boundary - midpoint) === Math.abs(best - midpoint) && boundary < best)
    ) {
      best = boundary;
    }
  }
  return best;
}

function assertByteConcatenation(expected: Uint8Array, pieces: Uint8Array[]): void {
  const byteSize = pieces.reduce((total, piece) => total + piece.byteLength, 0);
  if (byteSize !== expected.byteLength) throw new Error("import partition concatenation invariant failed");
  let offset = 0;
  for (const piece of pieces) {
    for (const byte of piece) {
      if (expected[offset] !== byte) throw new Error("import partition concatenation invariant failed");
      offset += 1;
    }
  }
}
