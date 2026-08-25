/** Rounds to 2 decimals, avoiding float drift on values such as 1.005. */
export const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

/**
 * Computes line and document totals for any sales/purchase document.
 * Discount applies to the line before tax, which matches Indian GST invoicing.
 */
export function calculateTotals(lines = []) {
  const priced = lines.map((line) => {
    const quantity = Number(line.quantity) || 0;
    const unitPrice = Number(line.unitPrice) || 0;
    const discountPercent = Number(line.discountPercent) || 0;
    const taxPercent = Number(line.taxPercent) || 0;

    const gross = quantity * unitPrice;
    const discountAmount = round2((gross * discountPercent) / 100);
    const taxableValue = round2(gross - discountAmount);
    const taxAmount = round2((taxableValue * taxPercent) / 100);

    return {
      ...line,
      quantity,
      unitPrice,
      discountPercent,
      taxPercent,
      discountAmount,
      taxableValue,
      taxAmount,
      lineTotal: round2(taxableValue + taxAmount),
    };
  });

  const subtotal = round2(priced.reduce((sum, line) => sum + line.taxableValue, 0));
  const discountTotal = round2(priced.reduce((sum, line) => sum + line.discountAmount, 0));
  const taxTotal = round2(priced.reduce((sum, line) => sum + line.taxAmount, 0));

  return {
    lines: priced,
    subtotal,
    discountTotal,
    taxTotal,
    grandTotal: round2(subtotal + taxTotal),
  };
}
