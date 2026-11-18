export interface TextDiffLine {
  kind: "unchanged" | "removed" | "added";
  text: string;
  before?: number;
  after?: number;
}

/** Complete line diff. For very large changed blocks, show every removal/addition without an LCS matrix. */
export function textDiff(
  before: string,
  after: string,
): { lines: TextDiffLine[]; blockReplacement: boolean } {
  const split = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const a = split(before),
    b = split(after);
  let prefix = 0,
    suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix])
    prefix++;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++;
  const n = a.length - prefix - suffix,
    m = b.length - prefix - suffix;
  const blockReplacement = (n + 1) * (m + 1) > 1_000_000;
  const raw: { kind: TextDiffLine["kind"]; text: string }[] = a
    .slice(0, prefix)
    .map((text) => ({ kind: "unchanged", text }));
  if (blockReplacement) {
    for (const text of a.slice(prefix, prefix + n))
      raw.push({ kind: "removed", text });
    for (const text of b.slice(prefix, prefix + m))
      raw.push({ kind: "added", text });
  } else {
    const matrix = new Uint32Array((n + 1) * (m + 1));
    const at = (i: number, j: number) => i * (m + 1) + j;
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        matrix[at(i, j)] =
          a[prefix + i] === b[prefix + j]
            ? matrix[at(i + 1, j + 1)] + 1
            : Math.max(matrix[at(i + 1, j)], matrix[at(i, j + 1)]);
    let i = 0,
      j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[prefix + i] === b[prefix + j]) {
        raw.push({ kind: "unchanged", text: a[prefix + i++] });
        j++;
      } else if (
        i < n &&
        (j === m || matrix[at(i + 1, j)] >= matrix[at(i, j + 1)])
      )
        raw.push({ kind: "removed", text: a[prefix + i++] });
      else raw.push({ kind: "added", text: b[prefix + j++] });
    }
  }
  for (const text of a.slice(a.length - suffix))
    raw.push({ kind: "unchanged", text });
  let oldLine = 1,
    newLine = 1;
  return {
    blockReplacement,
    lines: raw.map((line) => ({
      ...line,
      before: line.kind === "added" ? undefined : oldLine++,
      after: line.kind === "removed" ? undefined : newLine++,
    })),
  };
}
