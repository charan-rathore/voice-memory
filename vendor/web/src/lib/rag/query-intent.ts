/** Narrow exclusions for unambiguously non-monetary uses. Unknown uses keep
 * the conservative commercial gate; this never relaxes evidence thresholds. */
export function nonMonetaryCost(query: string): boolean {
  if (
    /\b(?:fees?|prices?|pricing|money|dollars?|rupees?|euros?|billing|payment|retainer)\b|[$€£₹]/i.test(
      query,
    )
  )
    return false;
  return /\bcost(?:s|ing)?\s+(?:(?:me|you|him|her|us|them|the\s+\w+)\s+)?(?:(?:my|your|his|her|our|their|a|the)\s+)?(?:job|role|part|life|lives|time|sleep|trust|reputation|friendship)\b/i.test(
    query,
  );
}
