// Calendar validation shared by DOB and report-date parsers.
export function validIso(y, m, d) {
  if (+m < 1 || +m > 12 || +d < 1 || +d > 31) return null;
  const t = new Date(Date.UTC(+y, +m - 1, +d));
  if (
    t.getUTCFullYear() !== +y ||
    t.getUTCMonth() !== +m - 1 ||
    t.getUTCDate() !== +d
  )
    return null;
  return `${y}-${String(+m).padStart(2, "0")}-${String(+d).padStart(2, "0")}`;
}
