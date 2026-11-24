export interface DiffLine {
  type: 'unchanged' | 'removed' | 'added';
  line: string;
  oldLineNum?: number;
  newLineNum?: number;
}

export interface LyricsDiffResult {
  lines: DiffLine[];
  addedCount: number;
  removedCount: number;
  hasChanges: boolean;
}

/**
 * Computes a clean line-by-line LCS diff for lyrics moderation,
 * live modal preview, and HTML diff emails to pschax@gmail.com.
 */
export function computeLyricsDiff(
  originalLines: readonly string[],
  proposedLines: readonly string[],
): LyricsDiffResult {
  const m = originalLines.length;
  const n = proposedLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array<number>(n + 1).fill(0));

  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (originalLines[i] === proposedLines[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let oldNum = 1;
  let newNum = 1;
  let addedCount = 0;
  let removedCount = 0;

  while (i < m && j < n) {
    if (originalLines[i] === proposedLines[j]) {
      lines.push({
        type: 'unchanged',
        line: originalLines[i],
        oldLineNum: oldNum++,
        newLineNum: newNum++,
      });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({
        type: 'removed',
        line: originalLines[i],
        oldLineNum: oldNum++,
      });
      removedCount++;
      i++;
    } else {
      lines.push({
        type: 'added',
        line: proposedLines[j],
        newLineNum: newNum++,
      });
      addedCount++;
      j++;
    }
  }

  while (i < m) {
    lines.push({
      type: 'removed',
      line: originalLines[i++],
      oldLineNum: oldNum++,
    });
    removedCount++;
  }

  while (j < n) {
    lines.push({
      type: 'added',
      line: proposedLines[j++],
      newLineNum: newNum++,
    });
    addedCount++;
  }

  return {
    lines,
    addedCount,
    removedCount,
    hasChanges: addedCount > 0 || removedCount > 0,
  };
}
